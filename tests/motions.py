"""Real VMD + hostile/truncated records + isolated catalog/API. No model inference."""
import hashlib
import json
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from motion_assets import parse_vmd, read_vmd
from catalog import Catalog


class NoInference:
    status, error = "unloaded", None
    def submit(self, *args, **kwargs):
        raise AssertionError("Motion indexing/search must not load embedding")


def settle(c):
    deadline = time.monotonic() + 15
    while c.active and time.monotonic() < deadline:
        time.sleep(.02)
    assert not c.active


def main():
    samples = Path(__file__).resolve().parents[2] / "datasets/motion/EX_HAPPY"
    originals = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in samples.iterdir() if p.is_file()}
    parsed = {p.name: read_vmd(p) for p in samples.glob("*.vmd")}
    assert parsed["motion.vmd"]["info"]["bone_keys"] == 9539
    assert len(parsed["motion.vmd"]["info"]["active_bones"]) == 50
    assert parsed["motion.vmd"]["info"]["ik_keys"] == 1
    assert parsed["facial.vmd"]["info"]["type"] == "facial"
    assert parsed["camera.vmd"]["info"]["type"] == "camera"
    head = b"Vocaloid Motion Data 0002".ljust(30, b"\0") + "両目".encode("cp932").ljust(20, b"\0")
    empty = head + struct.pack("<6I", 0, 0, 0, 0, 0, 0)
    assert parse_vmd(empty)["info"]["frames"] == 1
    switches = head + struct.pack("<6I", 0, 0, 0, 0, 0, 1) + struct.pack("<IBI", 30, 1, 1) + "左足ＩＫ".encode("cp932").ljust(20, b"\0") + b"\0"
    assert parse_vmd(switches)["switches"][0]["iks"] == [{"name": "左足ＩＫ", "enabled": False}]
    bad = [b"", empty[:12], head + struct.pack("<I", 2**32-1), empty + b"unexpected"]
    bone = "センター".encode("cp932").ljust(15, b"\0") + struct.pack("<I7f", 0, float("nan"), 0, 0, 0, 0, 0, 1) + bytes(64)
    bad.append(head + struct.pack("<I", 1) + bone)
    for data in bad:
        try:
            parse_vmd(data)
            raise AssertionError("Invalid VMD accepted")
        except ValueError:
            pass
    with tempfile.TemporaryDirectory(prefix="prism-motion-api-") as temporary:
        root = Path(temporary)
        source = root / "source"
        shutil.copytree(samples, source)
        c = Catalog(root / "library", inference=NoInference(), watch=False)
        try:
            folder = c.add_folder(source)
            settle(c)
            assert c.summary()["motions"] == 3
            assets = {a["name"]: a for a in c.list_assets({"kind": "motion"})["items"]}
            aid = assets["motion.vmd"]["id"]
            assert c.get_asset(aid)["status"] == "ready"
            c.update_asset(aid, {"tags": ["舞蹈"], "favorite": True})
            collection = c.save_collection("人形动作")
            c.bulk_update([aid], {"collection_id": collection["id"]})
            import app_server
            from fastapi.testclient import TestClient
            app_server.app.state.catalog = c
            client = TestClient(app_server.app)
            auth = {"Authorization": "Bearer " + app_server.TOKEN}
            route = f"/assets/{aid}"
            assert client.get(route + "/motion").status_code == 401
            assert client.get(route + "/motion?token=" + app_server.TOKEN).status_code == 401
            assert client.get(route + "/motion", headers=auth).json()["info"]["bones"] == 510
            result = client.post("/search", headers=auth, json={"text": "舞蹈", "filters": {"kind": "motion"}}).json()
            assert result["items"][0]["id"] == aid
            assert client.get(route + "/motion-model", headers=auth).status_code == 400
            files = client.get(route + "/motion-companions", headers=auth).json()["files"]
            music = next(f for f in files if f["kind"] == "audio")
            assert client.get(route + "/motion-files/" + music["id"], headers=auth).content[:4] == b"RIFF"
            assert client.get(route + "/motion-files/unknown", headers=auth).status_code == 400
            outside = root / "outside.wav"
            outside.write_bytes(b"private")
            (source / "unsafe.wav").symlink_to(outside)
            assert not any(f["name"] == "unsafe.wav" for f in c.motion_companions(aid)["files"])
            # File-level source replaced by a symlink must also be refused.
            (source / "motion.vmd").unlink()
            (source / "motion.vmd").symlink_to(samples / "motion.vmd")
            assert client.get(route + "/motion", headers=auth).status_code == 400
            (source / "motion.vmd").unlink()
            shutil.copyfile(samples / "motion.vmd", source / "motion.vmd")
            c.rescan(folder["id"]); settle(c)
            assert c.get_asset(aid)["tags"] == ["舞蹈"]
            assert c.get_asset(aid)["collections"][0]["id"] == collection["id"]
            # Bad edit -> error; repaired source -> retry -> metadata retained.
            (source / "motion.vmd").write_bytes(b"bad")
            c.rescan(folder["id"]); settle(c)
            assert c.get_asset(aid)["status"] == "error"
            shutil.copyfile(samples / "motion.vmd", source / "motion.vmd")
            c.retry_assets([aid], {}, False); settle(c)
            assert c.get_asset(aid)["status"] == "ready"
            (source / "camera.vmd").unlink()
            c.rescan(folder["id"]); settle(c)
            assert c.get_asset(assets["camera.vmd"]["id"])["status"] == "missing"
            c.close()
            c = Catalog(root / "library", inference=NoInference(), watch=False)
            settle(c)
            assert c.get_asset(aid)["motion"]["bone_keys"] == 9539
            assert c.get_asset(aid)["favorite"]
            # Package identity is its full directory, including when identical files/names repeat.
            package = c.motion_packages({})["items"][0]["motion_package"]
            assert package["name"] == "source" and package["count"] == 2
            assert c.summary()["motion_packages"] == 1
            duplicate = source / "another" / "source"
            duplicate.mkdir(parents=True)
            shutil.copyfile(samples / "motion.vmd", duplicate / "motion.vmd")
            c.rescan(folder["id"]); settle(c)
            packages = c.motion_packages({"limit": 1})
            assert packages["total"] == 2 and len(packages["items"]) == 1
            both = c.motion_packages({"sort": "name"})["items"]
            assert both[0]["name"] == both[1]["name"] == "source"
            assert both[0]["id"] != both[1]["id"]
            assert c.summary()["motion_packages"] == 2
            assert c.motion_packages({}, "motion")["total"] == 2
            assert c.motion_packages({}, "facial")["total"] == 1
            assert c.motion_packages({"name": "source"})["total"] == 2
            assert c.list_assets({"motion_package": str(duplicate.resolve())})["total"] == 1
            assert c.text_assets("facial", {"motion_package": str(duplicate.resolve())}, strategy="keyword")["total"] == 0
            assert c.list_assets({"motion_package": str(root / "outside")})["total"] == 0
            app_server.app.state.catalog = c
            assert client.post("/assets/motion-packages", json={}).status_code == 401
            assert client.post("/assets/motion-packages", headers=auth, json={"text": "facial"}).json()["total"] == 1
            c.folder_exclusions(folder["id"], ["another"]); settle(c)
            assert c.motion_packages({})["total"] == 1
            assert c.summary()["motion_packages"] == 1
        finally:
            c.close()
    assert all(hashlib.sha256(p.read_bytes()).hexdigest() == digest for p, digest in originals.items())
    print("MOTION_API_OK: real CP932 VMD, bounds, IK switches, no inference, authenticated files, symlinks, metadata/retry/restart, source hashes")


if __name__ == "__main__":
    main()
