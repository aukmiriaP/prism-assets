"""Deterministic governance tests. Real SQLite/filesystem; controlled vectors.

No model-quality assertions. All fixtures and migration databases live in /tmp.
"""
import concurrent.futures
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog import Catalog, PROFILE


class Inference:
    status, error = "ready", None
    calls = 0

    def submit(self, kind, value, priority=0):
        self.calls += 1
        future = concurrent.futures.Future()
        # Exact copies share a vector. Distinct pictures have a deterministic score.
        with Image.open(value) as image:
            pixel = image.convert("RGB").getpixel((0, 0))
        vector = np.array([pixel[0] + 1, pixel[1] + 1, pixel[2] + 1], dtype=np.float32)
        future.set_result(vector / np.linalg.norm(vector))
        return future


class Governance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prism-governance-")
        self.base = Path(self.temp.name).resolve()
        self.files = self.base / "originals"
        self.files.mkdir()
        for name, color in [("red.png", "red"), ("blue.png", "blue"), ("green.png", "green")]:
            Image.new("RGB", (32, 32), color).save(self.files / name)
        (self.files / "copies").mkdir()
        shutil.copyfile(self.files / "red.png", self.files / "copies/red-copy.png")
        self.inference = Inference()
        self.catalog = Catalog(self.base / "library", inference=self.inference, watch=False)
        self.folder = self.catalog.add_folder(str(self.files))
        self.settle()

    def settle(self):
        deadline = time.monotonic() + 10
        while self.catalog.active and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertFalse(self.catalog.active)
        self.assertFalse(self.catalog.rows("SELECT * FROM jobs WHERE status='failed'"))

    def tearDown(self):
        self.catalog.close()
        self.catalog.worker.join(2)
        self.catalog.db.close()
        self.temp.cleanup()

    def asset(self, name):
        return next(a for a in self.catalog.list_assets({"group_duplicates": False})["items"] if a["name"] == name)

    def test_grouping_topk_scope_and_pagination(self):
        result = self.catalog.list_assets({})
        self.assertEqual((result["total"], result["scope_total"], result["collapsed_count"]), (3, 4, 1))
        red = next(a for a in result["items"] if a["copy_count"] == 2)
        self.assertEqual(len(red["member_ids"]), 2)
        query = np.array([1, 0, 0], dtype=np.float32)
        result = self.catalog.list_assets({"top_k": 2}, query)
        self.assertEqual((result["total"], result["scope_total"], len(result["items"])), (2, 4, 2))
        self.assertEqual(result["items"][0]["copy_count"], 2)
        self.assertEqual(self.catalog.list_assets({"top_k": 2, "offset": 2}, query)["items"], [])
        first = self.catalog.list_assets({"limit": 1})["items"]
        rest = self.catalog.list_assets({"limit": 2, "offset": 1})["items"]
        self.assertEqual(len({r["id"] for r in first + rest}), 3)
        filtered = self.catalog.list_assets({"name": "red-copy"})["items"][0]
        self.assertEqual(filtered["copy_count"], 1)
        self.assertEqual(len(filtered["member_ids"]), 1)
        self.assertEqual(len(self.catalog.copies(filtered["id"])), 2)

    def test_bulk_atomicity_tag_preservation_collections_restart(self):
        red, blue = self.asset("red.png"), self.asset("blue.png")
        self.catalog.update_asset(red["id"], {"tags": ["已有标签"]})
        c1 = self.catalog.save_collection("项目参考")
        c2 = self.catalog.save_collection("灯光参考")
        ids = [red["id"], blue["id"]]
        self.catalog.bulk_update(ids, {"add_tags": ["新标签", "新标签"], "favorite": True, "collection_id": c1["id"]})
        self.catalog.bulk_update(ids, {"collection_id": c2["id"]})
        self.assertEqual(self.catalog.get_asset(red["id"])["tags"], ["已有标签", "新标签"])
        self.assertEqual(len(self.catalog.get_asset(red["id"])["collections"]), 2)
        with self.assertRaises(ValueError):
            self.catalog.bulk_update(ids + ["missing"], {"add_tags": ["不应写入"]})
        with self.assertRaises(ValueError):
            self.catalog.bulk_update(ids, {"add_tags": ["x" * 65], "favorite": False})
        with self.assertRaises(ValueError):
            self.catalog.bulk_update(ids, {"add_tags": ["不应写入"], "collection_id": "missing"})
        self.assertTrue(self.catalog.get_asset(blue["id"])["favorite"])
        self.assertNotIn("不应写入", self.catalog.get_asset(red["id"])["tags"])
        self.catalog.save_collection("场景参考", c1["id"])
        self.catalog.bulk_update([blue["id"]], {"collection_id": c1["id"], "collection_action": "remove"})
        self.assertEqual(self.catalog.list_assets({"collection_id": c1["id"]})["scope_total"], 1)
        self.catalog.bulk_update(ids, {"remove_tags": ["新标签"]})
        self.assertEqual(self.catalog.get_asset(red["id"])["tags"], ["已有标签"])
        self.catalog.close()
        self.catalog.worker.join(2)
        self.catalog.db.close()
        self.catalog = Catalog(self.base / "library", inference=self.inference, watch=False)
        self.settle()
        self.assertEqual(self.catalog.list_assets({"collection_id": c1["id"]})["scope_total"], 1)
        self.assertEqual(self.catalog.get_asset(red["id"])["tags"], ["已有标签"])
        self.catalog.remove_collection(c1["id"])
        self.assertEqual(len(self.catalog.get_asset(red["id"])["collections"]), 1)
        self.assertTrue((self.files / "red.png").exists())

    def test_exclusions_preview_skip_restore_and_metadata(self):
        copy = self.asset("red-copy.png")
        self.catalog.update_asset(copy["id"], {"tags": ["保留"], "favorite": True})
        collection = self.catalog.save_collection("副本")
        self.catalog.bulk_update([copy["id"]], {"collection_id": collection["id"]})
        preview = self.catalog.folder_exclusions(self.folder["id"], ["copies"], preview=True)
        self.assertEqual(preview["newly_excluded"], 1)
        self.assertEqual(self.catalog.list_assets({})["scope_total"], 4)
        self.catalog.folder_exclusions(self.folder["id"], ["copies"])
        self.settle()
        self.assertEqual(self.catalog.list_assets({})["scope_total"], 3)
        self.assertEqual(self.catalog.list_assets({"collection_id": collection["id"]})["scope_total"], 0)
        Image.new("RGB", (32, 32), "yellow").save(self.files / "copies/new.png")
        self.catalog.rescan(self.folder["id"])
        self.settle()
        self.assertEqual(self.catalog.list_assets({})["scope_total"], 3)
        self.assertEqual(self.catalog.get_asset(copy["id"])["status"], "ready")
        self.catalog.folder_exclusions(self.folder["id"], [])
        self.settle()
        self.assertEqual(self.catalog.list_assets({})["scope_total"], 5)
        self.assertEqual(self.catalog.get_asset(copy["id"])["tags"], ["保留"])
        self.assertTrue(self.catalog.get_asset(copy["id"])["favorite"])
        self.assertEqual(self.catalog.list_assets({"collection_id": collection["id"]})["scope_total"], 1)
        self.assertTrue((self.files / "copies/red-copy.png").exists())
        for invalid in ["../copies", "/tmp", ".", "build/*"]:
            with self.assertRaises(ValueError):
                self.catalog.folder_exclusions(self.folder["id"], [invalid])
        self.assertTrue(Catalog.excluded_path(self.files / "a/build/x.png", self.files, ["build"]))
        self.assertFalse(Catalog.excluded_path(self.files / "a/building/x.png", self.files, ["build"]))
        self.assertTrue(Catalog.excluded_path(self.files / "a/build/x.png", self.files, ["a/build"]))
        self.assertFalse(Catalog.excluded_path(self.files / "b/a/build/x.png", self.files, ["a/build"]))

    def test_exclusion_change_during_scan_is_reconciled(self):
        original = self.catalog.index_one
        invoked = []
        def wrapped(*args):
            if not invoked:
                invoked.append(True)
                self.catalog.folder_exclusions(self.folder["id"], ["copies"])
            original(*args)
        self.catalog.index_one = wrapped
        Image.new("RGB", (32, 32), "yellow").save(self.files / "new.png")
        self.catalog.rescan(self.folder["id"])
        self.settle()
        self.assertEqual(self.catalog.list_assets({})["scope_total"], 4)
        self.assertEqual(self.catalog.get_asset(self.catalog.rows("SELECT id FROM assets WHERE name='red-copy.png'")[0]["id"])["excluded"], 1)

    def test_selected_directory_is_literal_and_root_relative(self):
        for relative in ["a/copies", "copies/nested", "带 空格/[草稿]?"]:
            directory = self.files / relative
            directory.mkdir(parents=True)
            shutil.copyfile(self.files / "blue.png", directory / "fixture.png")
        self.catalog.rescan(self.folder["id"])
        self.settle()
        fid = self.folder["id"]
        self.assertEqual(self.catalog.folder_exclusions(fid, ["./copies"], preview=True)["excluded_files"], 2)
        self.assertEqual(self.catalog.folder_exclusions(fid, ["copies"], preview=True)["excluded_files"], 3)
        self.catalog.folder_exclusions(fid, ["./copies"])
        self.settle()
        visible = {a["path"] for a in self.catalog.list_assets({"group_duplicates": False})["items"]}
        self.assertIn(str(self.files / "a/copies/fixture.png"), visible)
        self.assertNotIn(str(self.files / "copies/nested/fixture.png"), visible)
        # A new file is skipped under the exact selected path, but the
        # same-named directory in another branch is still scanned.
        for relative in ["copies", "a/copies"]:
            Image.new("RGB", (32, 32), "yellow").save(self.files / relative / "new.png")
        self.catalog.rescan(fid)
        self.settle()
        self.assertFalse(self.catalog.rows("SELECT id FROM assets WHERE path=?", (str(self.files / "copies/new.png"),)))
        self.assertTrue(self.catalog.rows("SELECT id FROM assets WHERE path=?", (str(self.files / "a/copies/new.png"),)))
        rules = ["./带 空格/[草稿]?"]
        self.assertEqual(self.catalog.folder_exclusions(fid, rules, preview=True)["excluded_files"], 1)
        self.catalog.folder_exclusions(fid, rules)
        self.settle()
        self.assertEqual(json.loads(self.catalog.rows("SELECT exclusions FROM folders WHERE id=?", (fid,))[0]["exclusions"]), rules)
        self.assertNotIn(str(self.files / "带 空格/[草稿]?/fixture.png"),
                         {a["path"] for a in self.catalog.list_assets({"group_duplicates": False})["items"]})
        for invalid in ["./", "./.", "././", "./../copies", "./a/../../copies", "./a\0b"]:
            with self.assertRaises(ValueError, msg=invalid):
                self.catalog.folder_exclusions(fid, [invalid])

    def test_directory_listing_is_lazy_scoped_and_does_not_index(self):
        (self.files / "Assets/嵌套").mkdir(parents=True)
        (self.files / "empty").mkdir()
        (self.files / ".hidden/child").mkdir(parents=True)
        (self.files / "Assets/.private").mkdir()
        external = self.base / "external"
        external.mkdir()
        (external / "secret").mkdir()
        (self.files / "external-link").symlink_to(external, target_is_directory=True)
        (self.files / "Assets/link").symlink_to(external, target_is_directory=True)
        (self.files / "dangling").symlink_to(self.base / "absent", target_is_directory=True)
        before = self.inference.calls
        jobs = self.catalog.rows("SELECT id FROM jobs")
        scan = __import__("os").scandir
        with patch("catalog.os.scandir", wraps=scan) as scandir:
            result = self.catalog.folder_directories(self.folder["id"])
            self.assertEqual(result["items"], [{"name": "Assets", "path": "Assets"},
                                              {"name": "copies", "path": "copies"},
                                              {"name": "empty", "path": "empty"}])
            scandir.assert_called_once_with(self.files)
        self.assertEqual(self.catalog.folder_directories(self.folder["id"], "Assets")["items"],
                         [{"name": "嵌套", "path": "Assets/嵌套"}])
        self.assertEqual(self.catalog.folder_directories(self.folder["id"], "empty")["items"], [])
        for invalid in ["..", "../external", str(external), ".hidden", "Assets/.private",
                        "external-link", "external-link/secret", "Assets/link/secret", "x\0y"]:
            with self.assertRaises(ValueError, msg=invalid):
                self.catalog.folder_directories(self.folder["id"], invalid)
        with self.assertRaises(FileNotFoundError):
            self.catalog.folder_directories(self.folder["id"], "missing")
        with self.assertRaises(ValueError):
            self.catalog.folder_directories("unknown")
        with patch("catalog.os.scandir", side_effect=PermissionError("denied")):
            with self.assertRaisesRegex(ValueError, "访问权限"):
                self.catalog.folder_directories(self.folder["id"])
        self.assertEqual(self.inference.calls, before)
        self.assertEqual(self.catalog.rows("SELECT id FROM jobs"), jobs)
        # Excluded children remain visible so the user can uncheck them.
        self.catalog.folder_exclusions(self.folder["id"], ["./copies"])
        self.settle()
        self.assertIn({"name": "copies", "path": "copies"}, self.catalog.folder_directories(self.folder["id"])["items"])
        self.files.rename(self.base / "offline")
        with self.assertRaises(FileNotFoundError):
            self.catalog.folder_directories(self.folder["id"])


class Migration(unittest.TestCase):
    def test_old_database_keeps_ids_vectors_tags_and_favorites(self):
        with tempfile.TemporaryDirectory(prefix="prism-migrate-") as temp:
            path = Path(temp)
            db = sqlite3.connect(path / "catalog.sqlite3")
            db.executescript("""CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
                CREATE TABLE folders(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,name TEXT,status TEXT DEFAULT 'online',scanned REAL);
                CREATE TABLE assets(id TEXT PRIMARY KEY,folder_id TEXT,path TEXT UNIQUE,name TEXT,ext TEXT,size INTEGER,mtime INTEGER,
                    width INTEGER DEFAULT 0,height INTEGER DEFAULT 0,hash TEXT,thumbnail TEXT,vector BLOB,
                    tags TEXT DEFAULT '[]',favorite INTEGER DEFAULT 0,status TEXT DEFAULT 'pending',error TEXT,added REAL,updated REAL);""")
            vector = np.array([1, 0, 0], dtype=np.float32).tobytes()
            db.execute("INSERT INTO meta VALUES('profile',?)", (PROFILE,))
            db.execute("INSERT INTO assets(id,path,name,status,tags,favorite,vector) VALUES('stable','/unlinked.png','kept','ready',?,1,?)",
                       (json.dumps(["保留"]), vector))
            db.commit(); db.close()
            catalog = Catalog(path, inference=Inference(), watch=False)
            try:
                row = catalog.rows("SELECT * FROM assets WHERE id='stable'")[0]
                self.assertEqual(row["vector"], vector)
                self.assertEqual(json.loads(row["tags"]), ["保留"])
                self.assertEqual(row["favorite"], 1)
                self.assertEqual(row["excluded"], 0)
            finally:
                catalog.close(); catalog.worker.join(2); catalog.db.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
