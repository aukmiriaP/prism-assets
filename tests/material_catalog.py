"""Real SQLite/API/filesystem and Blender render/export/application; controlled vectors."""
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch
import zipfile

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from catalog import Catalog
from material_assets import inspect_material
from model_assets import blender_executable


class Inference:
    status, error = "ready", None
    def __init__(self):
        self.calls = []
        self.block = False
        self.held = None
        self.entered = threading.Event()
        self.fail = False

    def submit(self, kind, value, priority=0):
        self.calls.append(value)
        future = concurrent.futures.Future()
        if self.block and Path(value).name == "view-0.png":
            self.block = False
            self.held = future
            self.entered.set()
        elif self.fail and Path(value).name == "view-0.png":
            future.set_exception(ValueError("controlled encoding failure"))
        else:
            future.set_result(np.array([1, 0, 0], dtype=np.float32))
        return future


def settle(catalog):
    deadline = time.monotonic() + 200
    while catalog.active and time.monotonic() < deadline:
        time.sleep(.03)
    assert not catalog.active, "Material index timed out"
    assert not catalog.rows("SELECT * FROM jobs WHERE status='failed'"), catalog.summary()["jobs"]


def close(catalog):
    catalog.close(); catalog.worker.join(3); catalog.db.close()


def digest_tree(base):
    return {str(p.relative_to(base)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in base.rglob("*") if p.is_file()}


def main():
    import app_server
    from fastapi.testclient import TestClient
    temporary = Path(tempfile.mkdtemp(prefix="prism-material-catalog-")).resolve()
    original = temporary / "originals"
    shutil.copytree(ROOT.parent / "prism-material-samples/wood_planks", original / "wood")
    shutil.copytree(ROOT.parent / "prism-material-samples/rusty_metal_04", original / "metal")
    Image.new("RGB", (20, 20), "blue").save(original / "unrelated.png")
    hashes = digest_tree(original)
    inference = Inference()
    catalog = Catalog(temporary / "library", inference=inference, watch=False)
    try:
        folder = catalog.add_folder(str(original)); settle(catalog)
        app_server.app.state.catalog = catalog
        client = TestClient(app_server.app)
        auth = {"Authorization": "Bearer " + app_server.TOKEN}
        def request(method, url, body=None, code=200):
            response = client.request(method, url, headers=auth, json=body)
            assert response.status_code == code, (url, response.text)
            return response
        assert client.post("/materials/inspect", json={"path": str(original / "wood")}).status_code == 401
        config = request("POST", "/materials/inspect", {"path": str(original / "wood")}).json()["config"]
        config["name"] = "旧木地板"
        preview = request("POST", "/materials/preview", {"config": config}).json()
        assert catalog.summary()["materials"] == 0
        url = f"/materials/previews/{preview['preview_id']}/normal/preview"
        assert client.get(url + "?token=" + app_server.TOKEN).status_code == 200
        assert client.get(url).status_code == 401
        request("GET", "/materials/previews/invalid/base_color/preview", code=400)
        wood = request("POST", "/materials", {"config": config}).json(); settle(catalog)
        wood = catalog.get_asset(wood["id"])
        assert wood["status"] == "ready", wood["error"]
        published_url = f"/assets/{wood['id']}/material/normal/preview"
        generation = wood["material"]["published"]["cache"]
        assert client.get(published_url + f"?token={app_server.TOKEN}&v={generation}").status_code == 200
        request("GET", published_url + "?v=wrong-generation", code=400)
        image = np.array(Image.open(catalog.thumbs / wood["thumbnail"]).convert("RGB"))
        assert image[100:540, 100:540].std() > 12, "Real thumbnail lost texture contrast"
        assert (image[320, 100:540] < 240).any(), "Material sphere is washed out"
        request("POST", "/materials", {"config": config}, 400)
        assert request("POST", "/assets/list", {"kind": "material"}).json()["total"] == 1
        assert request("POST", "/search", {"text": "旧木地板", "strategy": "keyword", "filters": {"kind": "material"}}).json()["items"][0]["id"] == wood["id"]
        assert request("POST", "/search", {"asset_id": wood["id"], "filters": {"kind": "material"}}).json()["total"] == 1
        assert catalog.summary()["components"] == len(config["maps"])
        assert catalog.resource_groups({})["total"] == 0, "Material texture owners leaked into model groups"
        component = catalog.rows("SELECT id FROM assets WHERE path=?", (str(original / "wood" / config["maps"]["normal"]["file"]),))[0]["id"]
        assert catalog.get_asset(component)["owners"][0]["kind"] == "material"
        exported = request("GET", f"/assets/{wood['id']}/material/export").content
        assert client.get(f"/assets/{wood['id']}/material/export?token={app_server.TOKEN}").status_code == 401
        portable = temporary / "wood.zip"; portable.write_bytes(exported)
        with zipfile.ZipFile(io.BytesIO(exported)) as archive:
            payload = json.loads(archive.read("material.json"))
            assert "source_dir" not in payload["config"]
            assert payload["config"]["normal_format"] == "opengl"
        subprocess.run([str(ROOT / ".venv/bin/python"), str(ROOT / "scripts/package-material-addon.py"),
                        str(temporary / "addon.zip")], check=True)
        subprocess.run([blender_executable(), "--background", "--factory-startup", "--disable-autoexec",
            "--python", str(ROOT / "tests/material_blender.py"), "--", str(temporary)],
            check=True, stdout=(temporary / "addon-test.log").open("w"), stderr=subprocess.STDOUT, timeout=60)
        assert (temporary / "addon-ok.json").is_file(), (temporary / "addon-test.log").read_text()
        print("REAL_BLENDER_OK", str(temporary), flush=True)
        # Additional catalog transitions use the verified render, avoiding repeated Blender startup.
        rendered = catalog.materials / wood["id"] / wood["material"]["published"]["cache"] / "view-0.png"
        verified_render = temporary / "verified.png"; shutil.copy(rendered, verified_render)
        with patch("material_catalog.render_material", lambda out: shutil.copy(verified_render, out / "view-0.png")):
            metal_config = inspect_material(str(original / "metal"))["config"]
            metal = catalog.save_material(metal_config); settle(catalog)
            metal_thumb = catalog.get_asset(metal["id"])["thumbnail"]
            catalog.update_asset(wood["id"], {"tags": ["地板"], "favorite": True})
            collection = catalog.save_collection("游戏材质")
            catalog.bulk_update([wood["id"]], {"collection_id": collection["id"]})
            changed = {**config, "name": "修订木地板", "maps": {**config["maps"]}}
            del changed["maps"]["ao"]
            changed["normal_format"] = "directx"
            changed["repeat"] = 2
            inference.block = True
            request("PATCH", f"/materials/{wood['id']}", {"config": changed})
            assert inference.entered.wait(5)
            pending = catalog.get_asset(wood["id"])
            assert pending["material"]["config"]["repeat"] == 2
            assert pending["material"]["published"]["config"]["repeat"] == 1
            request("GET", f"/assets/{wood['id']}/material/export", code=400)
            request("PATCH", f"/materials/{wood['id']}", {"config": changed}, code=400)
            request("DELETE", f"/materials/{wood['id']}", code=400)
            inference.held.set_result(np.array([1, 0, 0], dtype=np.float32)); settle(catalog)
            updated = catalog.get_asset(wood["id"])
            assert updated["id"] == wood["id"] and updated["tags"] == ["地板"] and updated["favorite"]
            assert updated["collections"][0]["id"] == collection["id"]
            assert updated["material"]["published"]["config"]["repeat"] == 2
            assert catalog.get_asset(metal["id"])["thumbnail"] == metal_thumb
            assert catalog.summary()["components"] == len(changed["maps"]) + len(metal_config["maps"])
            calls = len(inference.calls)
            catalog.rescan(folder["id"]); settle(catalog)
            assert len(inference.calls) == calls
            close(catalog)
            catalog = Catalog(temporary / "library", inference=inference, watch=False); settle(catalog)
            app_server.app.state.catalog = catalog
            assert len(inference.calls) == calls and catalog.get_asset(wood["id"])["favorite"]
            catalog.folder_exclusions(folder["id"], ["./wood"]); settle(catalog)
            assert catalog.list_assets({"kind": "material"})["total"] == 1
            assert catalog.get_asset(wood["id"])["excluded"]
            catalog.folder_exclusions(folder["id"], []); settle(catalog)
            assert catalog.list_assets({"kind": "material"})["total"] == 2
            rough = original / "wood" / changed["maps"]["roughness"]["file"]
            old_bytes = rough.read_bytes()
            Image.new("RGB", (1024, 1024), "gray").save(rough)
            catalog.rescan(folder["id"]); settle(catalog)
            assert catalog.get_asset(wood["id"])["thumbnail"] != updated["thumbnail"]
            assert catalog.get_asset(metal["id"])["thumbnail"] == metal_thumb
            rough.unlink(); catalog.rescan(folder["id"]); settle(catalog)
            assert catalog.get_asset(wood["id"])["status"] == "error"
            rough.write_bytes(old_bytes); catalog.rescan(folder["id"]); settle(catalog)
            assert catalog.get_asset(wood["id"])["status"] == "ready"
            inference.fail = True
            catalog.save_material({**changed, "repeat": 3}, wood["id"]); settle(catalog)
            assert catalog.get_asset(wood["id"])["status"] == "error"
            inference.fail = False
            assert catalog.retry_assets([wood["id"]])["queued"] == 1; settle(catalog)
            assert catalog.get_asset(wood["id"])["status"] == "ready"
            request("DELETE", f"/materials/{wood['id']}")
            assert catalog.list_assets({"kind": "material"})["total"] == 1
            assert not catalog.rows("SELECT * FROM model_resources WHERE model_id=?", (wood["id"],))
            assert catalog.get_asset(component)["owners"] == []
            assert digest_tree(original) == hashes
            catalog.remove_folder(folder["id"])
            assert not list(catalog.materials.iterdir())
        print("MATERIAL_CATALOG_OK: real render + Blender application, API auth, searches, owners, "
              "portable export, pending/public separation, busy guards, metadata, restart, exclusions, "
              "incremental changes, missing restore, retry, delete/source immutability", flush=True)
    finally:
        if inference.held and not inference.held.done():
            inference.held.set_result(np.array([1, 0, 0], dtype=np.float32))
        close(catalog)


if __name__ == "__main__":
    main()
