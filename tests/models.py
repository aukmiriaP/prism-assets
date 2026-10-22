"""3D integration checks with real Blender, real formats, deterministic embeddings."""
import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from catalog import Catalog
from model_assets import blender_executable, read_pmx


class Inference:
    status, error = "ready", None
    calls = 0
    def submit(self, kind, value, priority=0):
        self.calls += 1
        f = concurrent.futures.Future()
        with Image.open(value) as image:
            pixel = np.asarray(image.convert("RGB").resize((1, 1)), dtype=np.float32).reshape(3) + 1
        f.set_result(pixel / np.linalg.norm(pixel))
        return f


def settle(catalog):
    deadline = time.monotonic() + 500
    while catalog.active and time.monotonic() < deadline:
        time.sleep(.1)
    assert not catalog.active, "Index timed out"
    assert not catalog.rows("SELECT * FROM jobs WHERE status='failed'")


def close(catalog):
    catalog.close()
    catalog.worker.join(3)
    catalog.db.close()


def main():
    base = Path(tempfile.mkdtemp(prefix="prism-model-tests-"))
    files = base / "originals"
    subprocess.run([blender_executable(), "--background", "--factory-startup", "--disable-autoexec",
                    "--python", str(ROOT / "tests/model_fixtures.py"), "--", str(files)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, timeout=60)
    inference = Inference()
    catalog = Catalog(base / "library", inference=inference, watch=False)
    try:
        folder = catalog.add_folder(str(files))
        settle(catalog)
        items = catalog.list_assets({"kind": "model", "group_duplicates": False})["items"]
        print("FORMAT_RESULTS", [(a["name"], a["status"], a["error"]) for a in items], flush=True)
        assert len(items) == 5
        assert all(a["status"] == ("error" if a["name"] == "broken.pmx" else "ready") for a in items)
        by_name = {a["name"]: a for a in items}
        gltf = by_name["sphere.gltf"]
        assert gltf["model"]["bound_textures"] == 1
        assert any(r["kind"] == "buffer" for r in gltf["model"]["resources"])
        assert not gltf["model"]["resources"][0]["embedded"]
        assert by_name["sphere.glb"]["model"]["resources"][0]["embedded"]
        assert by_name["missing.gltf"]["model"]["missing_resources"] == 1
        assert catalog.model_file(gltf["id"], "model.glb").read_bytes()[:4] == b"glTF"
        assert np.isclose(np.linalg.norm(catalog.similar_vector(gltf["id"])), 1)
        assert catalog.list_assets({"kind": "model"}, catalog.similar_vector(gltf["id"]))["total"] == 4
        assert catalog.list_assets({"kind": "texture"})["total"] >= 1
        calls = inference.calls
        catalog.rescan(folder["id"])
        settle(catalog)
        assert inference.calls == calls, "Unchanged models were rebuilt"
        # Change an external image, leaving the model bytes untouched.
        external = Path(gltf["model"]["resources"][0]["path"])
        Image.new("RGB", (32, 32), "blue").save(external)
        catalog.update_asset(gltf["id"], {"tags": ["模型参考"], "favorite": True})
        collection = catalog.save_collection("3D")
        catalog.bulk_update([gltf["id"]], {"collection_id": collection["id"]})
        catalog.rescan(folder["id"])
        settle(catalog)
        changed = catalog.get_asset(gltf["id"])
        assert changed["hash"] != gltf["hash"]
        assert changed["thumbnail"] != gltf["thumbnail"]
        assert changed["tags"] == ["模型参考"]
        assert changed["favorite"]
        assert changed["collections"][0]["id"] == collection["id"]
        # Explicit auth and binary/media routing with FastAPI's real middleware.
        import app_server
        from fastapi.testclient import TestClient
        app_server.app.state.catalog = catalog
        client = TestClient(app_server.app)
        url = f"/assets/{gltf['id']}/model"
        assert client.get(url).status_code == 401
        assert client.get(url + "?token=" + app_server.TOKEN).status_code == 401
        auth = {"Authorization": "Bearer " + app_server.TOKEN, "Origin": "null"}
        response = client.get(url, headers=auth)
        assert response.content[:4] == b"glTF"
        assert response.headers["access-control-allow-origin"] == "null"
        assert client.options(url, headers={"Origin": "null", "Access-Control-Request-Method": "GET",
                                           "Access-Control-Request-Headers": "authorization"}).status_code == 200
        assert client.get(f"/assets/{gltf['id']}/resources/0/preview?token={app_server.TOKEN}").status_code == 200
        assert client.get(f"/assets/{gltf['id']}/resources/99999/preview?token={app_server.TOKEN}").status_code == 404
        assert client.post("/search", headers=auth, json={"asset_id": gltf["id"], "filters": {"kind": "model"}}).status_code == 200
        # Preview refresh explicitly targets a ready model; ordinary retry remains failure-only.
        retry_url = "/assets/retry"
        assert client.post(retry_url, headers=auth, json={"refresh_models": True}).status_code == 400
        assert client.post(retry_url, headers=auth, json={"ids": [gltf["id"]]}).json()["queued"] == 0
        image = catalog.rows("SELECT id FROM assets WHERE kind='image' AND status='ready' LIMIT 1")[0]
        assert client.post(retry_url, headers=auth,
                           json={"ids": [image["id"]], "refresh_models": True}).json()["queued"] == 0
        calls = inference.calls
        untargeted_thumbnail = catalog.get_asset(by_name["sphere.glb"]["id"])["thumbnail"]
        response = client.post(retry_url, headers=auth,
                               json={"ids": [gltf["id"]], "refresh_models": True})
        assert response.status_code == 200 and response.json()["queued"] == 1
        settle(catalog)
        refreshed = catalog.get_asset(gltf["id"])
        assert refreshed["thumbnail"] != changed["thumbnail"]
        assert refreshed["hash"] == changed["hash"]
        assert refreshed["id"] == changed["id"] and refreshed["tags"] == changed["tags"]
        assert refreshed["favorite"] and refreshed["collections"][0]["id"] == collection["id"]
        assert inference.calls == calls + 2, "Refresh must encode only the two target model views"
        assert catalog.get_asset(by_name["sphere.glb"]["id"])["thumbnail"] == untargeted_thumbnail
        changed = refreshed
        close(catalog)
        catalog = Catalog(base / "library", inference=inference, watch=False)
        settle(catalog)
        assert catalog.get_asset(gltf["id"])["thumbnail"] == changed["thumbnail"]
        assert catalog.get_asset(gltf["id"])["favorite"]
        # Remove every model sharing the image: ownership must disappear.
        for path in files.glob("*"):
            if path.suffix.lower() in {".gltf", ".glb", ".fbx", ".pmx"}:
                path.unlink()
        catalog.rescan(folder["id"])
        settle(catalog)
        assert catalog.list_assets({"kind": "texture"})["total"] == 0
        assert catalog.list_assets({})["total"] >= 1
        print(json.dumps({"ok": True, "data": str(base), "checks": [
            "FBX/GLB/glTF actual conversion", "embedded/external bindings", "missing texture fallback",
            "corrupt PMX isolation", "authenticated GLB/CORS/resource endpoints", "model similar search",
            "unchanged scan reuse", "texture change invalidation", "tags/favorites/collections retained",
            "explicit ready-model preview refresh; image/whole-scope refresh rejected",
            "restart cache persistence", "missing model releases child images"]}), flush=True)
    finally:
        close(catalog)
    # Validate supplied PMXs with a separate library; originals stay read-only.
    dataset = ROOT.parent / "datasets/character_model"
    if dataset.is_dir():
        real = Catalog(base / "real-library", inference=Inference(), watch=False)
        try:
            real.add_folder(str(dataset))
            settle(real)
            models = real.list_assets({"kind": "model"})["items"]
            assert len(models) == 3
            assert all(a["status"] == "ready" for a in models), [(a["name"], a["error"]) for a in models]
            assert sorted(a["model"]["bound_textures"] for a in models) == [15, 17, 22]
            assert real.list_assets({})["total"] == 3
            assert real.summary()["components"] == 126
            assert all(a["model"]["missing_resources"] == 0 for a in models)
            (base / "real-results.json").write_text(json.dumps(models, ensure_ascii=False, indent=2))
            print("REAL_PMX_OK", str(base), [(a["name"], a["model"]["bound_textures"]) for a in models], flush=True)
        finally:
            close(real)


if __name__ == "__main__":
    main()
