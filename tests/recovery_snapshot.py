"""Verify recovery on a writable copy; the user's SQLite library is opened read-only."""
import argparse
import json
from pathlib import Path
import shutil
import sqlite3
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog import Catalog


class NoInference:
    status, error = "unloaded", None

    def submit(self, *args, **kwargs):
        raise AssertionError("Existing snapshot assets must not require embedding")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source_root = Path.home() / "Library/Application Support/Prism Assets/library"
    data = args.output / "data"
    data.mkdir(parents=True, exist_ok=True)
    if (data / "catalog.sqlite3").exists():
        raise ValueError("Choose a new snapshot output directory")
    with sqlite3.connect(source_root.joinpath("catalog.sqlite3").as_uri() + "?mode=ro", uri=True) as source:
        with sqlite3.connect(data / "catalog.sqlite3") as target:
            source.backup(target)
    with patch.object(Catalog, "rescan", return_value={"status": "disabled_for_snapshot"}):
        catalog = Catalog(data, inference=NoInference(), watch=False)
    try:
        # Limit the Electron fixture to the supplied model packages, without rescanning the whole workspace.
        dataset = Path(__file__).resolve().parents[2] / "datasets/character_model"
        rows = catalog.rows("SELECT * FROM assets WHERE instr(path,?)=1", (str(dataset) + "/",))
        assert rows, "No supplied model records in the library"
        ids = [r["id"] for r in rows]
        placeholders = ",".join("?" for _ in ids)
        catalog.execute("DELETE FROM assets WHERE id NOT IN (" + placeholders + ")", ids)
        fid = rows[0]["folder_id"]
        catalog.execute("UPDATE assets SET folder_id=?", (fid,))
        catalog.execute("DELETE FROM folders WHERE id!=?", (fid,))
        catalog.execute("UPDATE folders SET path=?,name='模型恢复验证',exclusions='[]',status='online' WHERE id=?", (str(dataset), fid))
        catalog.execute("DELETE FROM jobs")
        # A running development app may already have applied recovery.
        # Replay its retained old-path rows only inside this isolated copy.
        replayed = catalog.execute("UPDATE assets SET archived=0,replacements='[]' WHERE archived=1")
        if replayed:
            catalog.execute("DELETE FROM relocation_history")
        (data / "thumbnails").mkdir(exist_ok=True)
        for row in rows:
            if row["thumbnail"] and (source_root / "thumbnails" / row["thumbnail"]).is_file():
                shutil.copyfile(source_root / "thumbnails" / row["thumbnail"], data / "thumbnails" / row["thumbnail"])
        before = catalog.summary()
        before_annotation = {r["id"]: (json.loads(r["tags"]), r["favorite"]) for r in rows if r["status"] != "missing"}
        recovery = catalog.recover_missing()
        catalog.refresh_model_groups(fid)
        after = catalog.summary()
        groups = catalog.resource_groups({})
        assert before["counts"].get("missing", 0) == sum(recovery.values())
        assert after["counts"].get("missing", 0) == recovery["missing"] + recovery["ambiguous"]
        assert all(not r["archived"] for r in catalog.rows("SELECT * FROM assets WHERE status='ready'"))
        assert all((catalog.get_asset(aid)["tags"], int(catalog.get_asset(aid)["favorite"])) == value
                   for aid, value in before_annotation.items())
        counts = [{"name": g["name"], "textures": g["resource_count"], "bound": g["bound_count"],
                   "auxiliary": g["auxiliary_count"]} for g in groups["items"]]
        report = {"live_library_modified": False, "historical_rows_replayed_in_copy": replayed,
                  "missing_before": before["counts"].get("missing", 0),
                  "recovery": recovery, "missing_after": after["counts"].get("missing", 0),
                  "groups": counts, "components": after["components"]}
        (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False), flush=True)
    finally:
        catalog.close(); catalog.worker.join(2); catalog.db.close()


if __name__ == "__main__":
    main()
