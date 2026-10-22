"""Real filesystem/SQLite recovery and resource groups; no embedding weights needed."""
import json
from pathlib import Path
import shutil
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog import Catalog
from model_assets import dependency_stamp
import governance
from governance import Inference


class Recovery(governance.Governance):
    # Inherited governance checks run alongside the recovery regressions.
    def scan(self, automatic=False):
        self.catalog.rescan(self.folder["id"], automatic=automatic)
        self.settle()

    def test_move_rename_and_alias_metadata_restart(self):
        old = self.asset("blue.png")
        self.catalog.update_asset(old["id"], {"tags": ["旧标签"], "favorite": True})
        collection = self.catalog.save_collection("模型参考")
        self.catalog.bulk_update([old["id"]], {"collection_id": collection["id"]})
        (self.files / "blue.png").rename(self.files / "renamed.png")
        self.scan()
        recovered = self.catalog.get_asset(old["id"])
        self.assertEqual(recovered["name"], "renamed.png")
        self.assertEqual(recovered["tags"], ["旧标签"])
        self.assertTrue(recovered["favorite"])
        self.assertEqual(recovered["collections"][0]["id"], collection["id"])
        self.assertEqual(recovered["history"][0]["old_path"], old["path"])
        self.assertEqual(self.catalog.summary()["counts"].get("missing", 0), 0)
        self.assertEqual(self.catalog.rows("SELECT archived FROM assets WHERE id=?", (old["id"],))[0]["archived"], 1)
        # References held by the old detail view still address the restored file.
        self.catalog.update_asset(old["id"], {"tags": ["更新"]})
        self.catalog.bulk_update([old["id"]], {"favorite": False})
        self.assertEqual(self.catalog.get_asset(recovered["id"])["tags"], ["更新"])
        self.catalog.close(); self.catalog.worker.join(2); self.catalog.db.close()
        self.catalog = Catalog(self.base / "library", inference=Inference(), watch=False)
        self.settle()
        self.assertEqual(self.catalog.get_asset(old["id"])["path"], recovered["path"])
        self.assertEqual(len(self.catalog.rows("SELECT * FROM relocation_history")), 1)

    def test_existing_target_merge_reuses_vector_and_preserves_both_annotations(self):
        old, target = self.asset("red.png"), self.asset("red-copy.png")
        self.catalog.update_asset(old["id"], {"tags": ["旧"], "favorite": True})
        self.catalog.update_asset(target["id"], {"tags": ["新"]})
        c1, c2 = self.catalog.save_collection("旧集"), self.catalog.save_collection("新集")
        self.catalog.bulk_update([old["id"]], {"collection_id": c1["id"]})
        self.catalog.bulk_update([target["id"]], {"collection_id": c2["id"]})
        calls = self.inference.calls
        (self.files / "red.png").unlink()
        self.scan(automatic=True)
        value = self.catalog.get_asset(old["id"])
        self.assertEqual(value["id"], target["id"])
        self.assertEqual(value["tags"], ["新", "旧"])
        self.assertTrue(value["favorite"])
        self.assertEqual({c["id"] for c in value["collections"]}, {c1["id"], c2["id"]})
        self.assertEqual(self.inference.calls, calls)
        self.assertEqual(self.catalog.summary()["favorites"], 1)
        self.assertTrue(all(c["count"] == 1 for c in self.catalog.summary()["collections"]))

    def test_ambiguous_annotations_require_explicit_authenticated_choice(self):
        old = self.asset("red.png")
        shutil.copyfile(self.files / "red.png", self.files / "second-red.png")
        self.scan()
        self.catalog.update_asset(old["id"], {"tags": ["归属待确认"]})
        (self.files / "red.png").unlink()
        self.scan()
        missing = self.catalog.get_asset(old["id"])
        self.assertEqual(missing["status"], "missing")
        self.assertEqual(len(missing["recovery_candidates"]), 2)
        target = missing["recovery_candidates"][0]
        import app_server
        from fastapi.testclient import TestClient
        app_server.app.state.catalog = self.catalog
        client = TestClient(app_server.app)
        auth = {"Authorization": "Bearer " + app_server.TOKEN}
        route = f"/assets/{old['id']}/reconnect"
        self.assertEqual(client.post(route, json={"target_id": target["id"]}).status_code, 401)
        self.assertEqual(client.post(route, headers=auth, json={"target_id": "unknown"}).status_code, 400)
        response = client.post(route, headers=auth, json={"target_id": target["id"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["tags"], ["归属待确认"])
        self.assertEqual(self.catalog.summary()["counts"].get("missing", 0), 0)
        self.assertEqual(client.post(route, headers=auth, json={"target_id": target["id"]}).status_code, 400)

    def test_shared_duplicates_archive_without_guessing_model(self):
        old = self.asset("red.png")
        for folder in ["model-a", "model-b"]:
            (self.files / folder).mkdir()
            shutil.copyfile(self.files / "red.png", self.files / folder / "red.png")
        (self.files / "red.png").unlink()
        self.scan()
        archived = self.catalog.rows("SELECT * FROM assets WHERE id=?", (old["id"],))[0]
        self.assertEqual(archived["archived"], 1)
        self.assertEqual(len(json.loads(archived["replacements"])), 2)
        self.assertEqual(self.catalog.summary()["counts"].get("missing", 0), 0)
        self.scan()
        self.assertEqual(len(self.catalog.rows("SELECT * FROM relocation_history")), 1)

    def test_true_missing_exclusions_and_changed_candidate_never_recover(self):
        blue = self.asset("blue.png")
        (self.files / "blue.png").unlink()
        self.scan()
        self.assertEqual(self.catalog.get_asset(blue["id"])["status"], "missing")
        red = self.asset("red.png")
        self.catalog.folder_exclusions(self.folder["id"], ["copies"])
        self.settle()
        (self.files / "red.png").unlink()
        self.scan()
        self.assertEqual(self.catalog.get_asset(red["id"])["status"], "missing")
        self.catalog.folder_exclusions(self.folder["id"], [])
        self.settle()
        self.assertEqual(self.catalog.get_asset(red["id"])["name"], "red-copy.png")
        target = self.catalog.get_asset(red["id"])
        self.catalog.execute("UPDATE assets SET status='missing',archived=0,replacements='[]' WHERE id=?", (red["id"],))
        (self.files / "copies/red-copy.png").write_bytes(b"changed")
        self.assertEqual(self.catalog.recovery_candidates(self.catalog.rows("SELECT * FROM assets WHERE id=?", (red["id"],))[0]), [])
        self.assertTrue(Path(target["path"]).exists())

    def test_old_path_reappears_after_archive(self):
        old = self.asset("red.png")
        (self.files / "red.png").unlink()
        self.scan()
        shutil.copyfile(self.files / "copies/red-copy.png", self.files / "red.png")
        self.scan()
        self.assertEqual(self.catalog.get_asset(old["id"])["path"], old["path"])
        self.assertEqual(self.catalog.get_asset(old["id"])["status"], "ready")
        self.assertEqual(self.catalog.list_assets({"group_duplicates": False})["scope_total"], 4)

    def install_cached_model(self, name, resources):
        path = self.files / name
        path.write_bytes(b"fixture placeholder")
        aid = name.replace(".", "-")
        stat = path.stat()
        metadata = {"cache": "fixture", "name": name, "materials": [], "resources": resources,
                    "vertices": 1, "triangles": 1, "bound_textures": 1, "auxiliary_files": 1,
                    "missing_resources": 0, "comment": "", "warnings": []}
        self.catalog.execute("""INSERT INTO assets(id,folder_id,path,name,ext,size,mtime,status,kind,
            model_data,dependency_stamp,tags,added,updated) VALUES(?,?,?,?,?,?,?,'ready','model',?,?,'[]',0,0)""",
            (aid, self.folder["id"], str(path), path.name, "pmx", stat.st_size, stat.st_mtime_ns,
             json.dumps(metadata), dependency_stamp(path, metadata)))
        return aid

    def test_model_root_group_shared_reference_filters_exclusions_and_removal(self):
        blue, green = self.asset("blue.png"), self.asset("green.png")
        resources = [{"path": blue["path"], "relation": "bound", "kind": "texture"},
                     {"path": green["path"], "relation": "auxiliary", "kind": "texture"}]
        first = self.install_cached_model("first.pmx", resources)
        self.catalog.refresh_model_groups(self.folder["id"])
        groups = self.catalog.resource_groups({})
        self.assertEqual(groups["total"], 1)
        self.assertEqual(groups["items"][0]["resource_count"], 2)
        self.assertEqual(self.catalog.list_assets({"kind": "texture", "model_id": first, "relation": "auxiliary"})["scope_total"], 1)
        self.assertEqual(self.catalog.list_assets({"kind": "texture", "model_id": first}, self.catalog.similar_vector(blue["id"]))["scope_total"], 2)
        second = self.install_cached_model("second.pmx", resources)
        self.catalog.refresh_model_groups(self.folder["id"])
        shared = self.catalog.resource_groups({})
        self.assertEqual((shared["total"], shared["scope_total"], shared["resource_total"]), (2, 2, 1))
        self.assertEqual(self.catalog.list_assets({"kind": "texture"})["scope_total"], 1)
        self.assertEqual(len(self.catalog.get_asset(blue["id"])["owners"]), 2)
        self.assertEqual(self.catalog.resource_groups({"name": "green"})["total"], 0)
        self.catalog.execute("UPDATE assets SET excluded=1 WHERE id=?", (second,))
        self.assertEqual(self.catalog.resource_groups({})["total"], 1)
        self.catalog.execute("UPDATE assets SET status='missing' WHERE id=?", (first,))
        self.assertEqual(self.catalog.resource_groups({})["total"], 0)
        self.assertEqual(self.catalog.list_assets({"kind": "texture"})["scope_total"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
