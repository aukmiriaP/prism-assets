"""Collection hierarchy regression checks on isolated SQLite libraries."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

import numpy as np
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog import Catalog
import app_server


class NoInference:
    status, error = "unloaded", None

    def submit(self, *args, **kwargs):
        raise AssertionError("Collection operations must not load embedding")


class Collections(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prism-collection-tree-")
        self.root = Path(self.temp.name)
        self.original = self.root / "liv.png"
        self.original.write_bytes(b"original asset must remain unchanged")
        self.catalog = Catalog(self.root / "library", inference=NoInference(), watch=False)
        self.vector = np.array([1, 0, 0], dtype=np.float32).tobytes()
        self.catalog.execute("""INSERT INTO assets(id,path,name,ext,status,hash,tags,favorite,vector)
            VALUES('asset',?,'liv.png','png','ready','unique',?,1,?)""",
                             (str(self.original), json.dumps(["战双"]), self.vector))

    def close_catalog(self):
        self.catalog.close()
        self.catalog.worker.join(2)
        self.catalog.db.close()

    def tearDown(self):
        self.close_catalog()
        self.temp.cleanup()

    def tree(self):
        project = self.catalog.save_collection("xx公司测试demo")
        roles = self.catalog.save_collection("角色资产", parent_id=project["id"])
        liv = self.catalog.save_collection("丽芙", parent_id=roles["id"])
        return project, roles, liv

    def test_nested_paths_direct_membership_rename_move_and_restart(self):
        project, roles, liv = self.tree()
        scene = self.catalog.save_collection("场景资产", parent_id=project["id"])
        place = self.catalog.save_collection("xxx", parent_id=scene["id"])
        self.catalog.bulk_update(["asset"], {"collection_id": liv["id"]})
        self.assertEqual(self.catalog.list_assets({"collection_id": project["id"]})["total"], 0)
        self.assertEqual(self.catalog.list_assets({"collection_id": liv["id"]})["total"], 1)
        self.assertEqual(self.catalog.get_asset("asset")["collections"][0]["path"],
                         "xx公司测试demo / 角色资产 / 丽芙")
        summary = {c["id"]: c for c in self.catalog.summary()["collections"]}
        self.assertEqual(summary[project["id"]]["child_count"], 2)
        self.assertEqual(summary[liv["id"]]["count"], 1)
        self.assertEqual(summary[place["id"]]["path"], "xx公司测试demo / 场景资产 / xxx")
        self.assertEqual(self.catalog.text_assets("xx公司测试demo", {}, strategy="keyword")["total"], 1)
        self.catalog.save_collection("新公司demo", project["id"])
        self.assertEqual(self.catalog.text_assets("xx公司测试demo", {}, strategy="keyword")["total"], 0)
        self.assertEqual(self.catalog.text_assets("新公司demo", {}, strategy="keyword")["total"], 1)
        second = self.catalog.save_collection("另一个项目")
        self.catalog.save_collection("角色资产", roles["id"], second["id"], change_parent=True)
        self.catalog.save_collection("丽芙·仰光", liv["id"])
        self.assertEqual(self.catalog.get_asset("asset")["collections"][0]["path"],
                         "另一个项目 / 角色资产 / 丽芙·仰光")
        self.close_catalog()
        self.catalog = Catalog(self.root / "library", inference=NoInference(), watch=False)
        self.assertEqual(self.catalog.get_asset("asset")["collections"][0]["id"], liv["id"])
        row = self.catalog.get_asset("asset")
        self.assertEqual(row["tags"], ["战双"])
        self.assertTrue(row["favorite"])
        self.assertEqual(self.catalog.rows("SELECT vector FROM assets")[0]["vector"], self.vector)
        self.assertEqual(self.original.read_bytes(), b"original asset must remain unchanged")
        self.assertEqual(self.catalog.rows("PRAGMA foreign_key_check"), [])

    def test_same_names_allowed_in_other_branches_and_invalid_moves_are_atomic(self):
        project, roles, liv = self.tree()
        other = self.catalog.save_collection("另一个项目")
        other_roles = self.catalog.save_collection("角色资产", parent_id=other["id"])
        with self.assertRaises(ValueError):
            self.catalog.save_collection("角色资产", parent_id=project["id"])
        self.catalog.save_collection("DEMO")
        with self.assertRaises(ValueError):
            self.catalog.save_collection("demo")
        for parent in [project["id"], liv["id"]]:
            with self.assertRaises(ValueError):
                self.catalog.save_collection("不应改名", project["id"], parent, change_parent=True)
        with self.assertRaises(ValueError):
            self.catalog.save_collection("角色资产", roles["id"], other["id"], change_parent=True)
        with self.assertRaises(ValueError):
            self.catalog.save_collection("不应创建", parent_id="missing")
        with self.assertRaises(ValueError):
            self.catalog.save_collection("不应改名", liv["id"], "missing", change_parent=True)
        records = {c["id"]: c for c in self.catalog.collection_records()}
        self.assertEqual(records[project["id"]]["name"], "xx公司测试demo")
        self.assertEqual(records[roles["id"]]["parent_id"], project["id"])
        self.assertEqual(records[other_roles["id"]]["parent_id"], other["id"])

    def test_delete_parent_guard_and_leaf_membership_removal(self):
        project, roles, liv = self.tree()
        keep = self.catalog.save_collection("保留集合")
        for collection in [liv, keep]:
            self.catalog.bulk_update(["asset"], {"collection_id": collection["id"]})
        with self.assertRaises(ValueError):
            self.catalog.remove_collection(project["id"])
        self.catalog.remove_collection(liv["id"])
        self.catalog.remove_collection(roles["id"])
        self.catalog.remove_collection(project["id"])
        self.assertEqual([c["id"] for c in self.catalog.get_asset("asset")["collections"]], [keep["id"]])
        self.assertEqual(self.catalog.get_asset("asset")["tags"], ["战双"])
        self.assertTrue(self.original.exists())

    def test_api_omitted_parent_keeps_hierarchy_and_null_promotes_to_root(self):
        project, roles, liv = self.tree()
        app_server.app.state.catalog = self.catalog
        client = TestClient(app_server.app, headers={"Authorization": "Bearer " + app_server.TOKEN})
        self.addCleanup(client.close)
        response = client.patch("/collections/" + liv["id"], json={"name": "丽芙·仰光"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["parent_id"], roles["id"])
        response = client.patch("/collections/" + project["id"],
                                json={"name": "不应改名", "parent_id": liv["id"]})
        self.assertEqual(response.status_code, 400)
        response = client.patch("/collections/" + liv["id"],
                                json={"name": "丽芙·仰光", "parent_id": None})
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["parent_id"])
        self.assertEqual(client.post("/collections", json={"name": "无效", "parent_id": "missing"}).status_code, 400)

    def test_legacy_migration_keeps_memberships_and_creates_backup(self):
        legacy = self.catalog.save_collection("旧集合")
        self.catalog.bulk_update(["asset"], {"collection_id": legacy["id"]})
        self.close_catalog()
        database = self.root / "library/catalog.sqlite3"
        with sqlite3.connect(database) as db:
            db.executescript("""
                PRAGMA foreign_keys=OFF;
                DROP TABLE collections;
                CREATE TABLE collections(
                    id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE,created REAL);
            """)
            db.execute("INSERT INTO collections VALUES(?,?,?)", (legacy["id"], "旧集合", legacy["created"]))
        self.catalog = Catalog(database.parent, inference=NoInference(), watch=False)
        self.assertEqual(self.catalog.get_asset("asset")["collections"][0]["id"], legacy["id"])
        self.assertIsNone(self.catalog.collection_records()[0]["parent_id"])
        self.assertEqual(self.catalog.rows("SELECT vector FROM assets")[0]["vector"], self.vector)
        self.assertEqual(self.catalog.rows("PRAGMA foreign_key_check"), [])
        with sqlite3.connect(database.parent / "catalog-before-collection-tree.sqlite3") as backup:
            self.assertEqual(backup.execute("SELECT collection_id FROM collection_assets").fetchone()[0], legacy["id"])
            self.assertNotIn("parent_id", [row[1] for row in backup.execute("PRAGMA table_info(collections)")])
        child = self.catalog.save_collection("旧集合", parent_id=legacy["id"])
        self.assertEqual(child["path"], "旧集合 / 旧集合")


if __name__ == "__main__":
    unittest.main(verbosity=2)
