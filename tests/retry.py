"""Failure recovery through the authenticated API, with no model download."""
import concurrent.futures
from pathlib import Path
import sys
import tempfile
import threading
import time
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog import Catalog
from model_assets import prepare_model


class Inference:
    status, error = "ready", None

    def __init__(self):
        self.failing = {"alpha.png", "beta.png", "excluded.png"}
        self.calls = []
        self.block = ""
        self.held = None
        self.entered = threading.Event()

    def submit(self, kind, value, priority=0):
        name = Path(value).name
        self.calls.append(name)
        future = concurrent.futures.Future()
        if name == self.block:
            self.held = future
            self.entered.set()
        elif name in self.failing:
            future.set_exception(ValueError("Temporary inference failure"))
        else:
            future.set_result(np.array([1, 0, 0], dtype=np.float32))
        return future


def settle(catalog):
    deadline = time.monotonic() + 10
    while catalog.active and time.monotonic() < deadline:
        time.sleep(.02)
    assert not catalog.active, "Retry failed to settle"


def main():
    import app_server
    from fastapi.testclient import TestClient

    with tempfile.TemporaryDirectory(prefix="prism-retry-") as temporary:
        base = Path(temporary)
        originals = base / "originals"
        (originals / "ignored").mkdir(parents=True)
        for name in ["healthy.png", "alpha.png", "beta.png", "ignored/excluded.png"]:
            Image.new("RGB", (16, 16), "red").save(originals / name)
        container = originals / "wrapped.glb"
        container.write_bytes(b"CTV1" + b"x" * 100)
        with patch("model_assets.subprocess.run") as conversion:
            try:
                prepare_model(container, base / "never-created")
                raise AssertionError("A CTV1 container was accepted as a GLB")
            except ValueError as exc:
                assert "CTV1" in str(exc) and "标准 GLB" in str(exc)
            conversion.assert_not_called()
        inference = Inference()
        catalog = Catalog(base / "library", inference=inference, watch=False)
        try:
            folder = catalog.add_folder(str(originals))
            settle(catalog)
            catalog.folder_exclusions(folder["id"], ["ignored"])
            settle(catalog)
            assets = {a["name"]: a for a in catalog.rows("SELECT * FROM assets")}
            alpha, beta = assets["alpha.png"], assets["beta.png"]
            catalog.update_asset(alpha["id"], {"tags": ["保留"], "favorite": True})
            collection = catalog.save_collection("保留集合")
            catalog.bulk_update([alpha["id"]], {"collection_id": collection["id"]})
            healthy = catalog.get_asset(assets["healthy.png"]["id"])
            app_server.app.state.catalog = catalog
            client = TestClient(app_server.app)
            auth = {"Authorization": "Bearer " + app_server.TOKEN}

            def retry(body):
                response = client.post("/assets/retry", headers=auth, json=body)
                assert response.status_code == 200, response.text
                return response.json()

            assert client.post("/assets/retry", json={}).status_code == 401
            assert client.post("/assets/retry", headers=auth, json={"ids": ["unknown"]}).status_code == 400
            assert client.post("/assets/retry", headers=auth, json={"ids": ["x"] * 5001}).status_code == 422
            inference.failing.clear()
            inference.block = "alpha.png"
            assert retry({"ids": [alpha["id"]]})["queued"] == 1
            assert inference.entered.wait(3)
            assert catalog.get_asset(alpha["id"])["status"] == "pending"
            jobs = len(catalog.rows("SELECT id FROM jobs"))
            assert retry({"ids": [alpha["id"]]})["queued"] == 0
            assert retry({"ids": [beta["id"]]}) == {"queued": 0, "busy": 1, "jobs": []}
            assert len(catalog.rows("SELECT id FROM jobs")) == jobs
            inference.held.set_result(np.array([1, 0, 0], dtype=np.float32))
            inference.block = ""
            settle(catalog)
            recovered = catalog.get_asset(alpha["id"])
            assert recovered["status"] == "ready" and recovered["error"] is None
            assert recovered["tags"] == ["保留"] and recovered["favorite"]
            assert recovered["collections"][0]["id"] == collection["id"]
            assert recovered["id"] == alpha["id"]
            assert catalog.get_asset(beta["id"])["status"] == "error"

            # Scoped retry ignores pagination and does not discover/reindex other files.
            Image.new("RGB", (16, 16), "blue").save(originals / "untracked.png")
            Image.new("RGB", (32, 32), "blue").save(originals / "beta.png")
            assert retry({"filters": {"name": "beta", "limit": 1}})["queued"] == 1
            settle(catalog)
            assert catalog.get_asset(beta["id"])["width"] == 32
            assert not catalog.rows("SELECT id FROM assets WHERE name=?", ("untracked.png",))
            assert catalog.get_asset(healthy["id"])["thumbnail"] == healthy["thumbnail"]
            assert inference.calls.count("healthy.png") == 1
            assert inference.calls.count("excluded.png") == 1
            assert retry({"ids": [healthy["id"]]})["queued"] == 0

            # Retry-all excludes hidden files, and irreparable containers remain failures.
            assert retry({})["queued"] == 1
            settle(catalog)
            wrapped = catalog.get_asset(assets["wrapped.glb"]["id"])
            assert wrapped["status"] == "error" and "CTV1" in wrapped["error"]
            assert catalog.rows("SELECT * FROM jobs ORDER BY created DESC LIMIT 1")[0]["failed"] == 1
            catalog.execute("UPDATE assets SET status='error' WHERE id=?", (beta["id"],))
            (originals / "beta.png").unlink()
            assert retry({"ids": [beta["id"]]})["queued"] == 1
            settle(catalog)
            assert catalog.get_asset(beta["id"])["status"] == "missing"
            print("RETRY_OK: auth, single/scoped/all retries, busy/double-submit, metadata retention, "
                  "unchanged healthy assets, exclusions, missing files, CTV1 preflight")
        finally:
            if inference.held and not inference.held.done():
                inference.held.set_result(np.array([1, 0, 0], dtype=np.float32))
            catalog.close()
            catalog.worker.join(3)
            catalog.db.close()


if __name__ == "__main__":
    main()
