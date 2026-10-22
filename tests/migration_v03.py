"""Migrate a consistent read-only snapshot of the user's library; never edit it."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog import Catalog


class MigrationOnly(Catalog):
    def rescan(self, *args, **kwargs):
        return {"status": "skipped-for-schema-check"}


def fingerprint(db):
    result = {}
    columns = "id,path,tags,favorite,vector"
    for row in db.execute(f"SELECT {columns} FROM assets ORDER BY id"):
        result[row[0]] = hashlib.sha256(repr(tuple(row)).encode()).hexdigest()
    return result


source = Path.home() / "Library/Application Support/Prism Assets/library/catalog.sqlite3"
out = Path(tempfile.mkdtemp(prefix="prism-v03-migration-"))
original = sqlite3.connect("file:" + str(source) + "?mode=ro", uri=True)
destination = sqlite3.connect(out / "catalog.sqlite3")
original.backup(destination)
original.close()
before = fingerprint(destination)
collections = destination.execute("SELECT * FROM collection_assets ORDER BY collection_id,asset_id").fetchall()
destination.close()
catalog = MigrationOnly(out, inference=object(), watch=False)
try:
    assert before == fingerprint(catalog.db)
    assert collections == [tuple(r) for r in catalog.db.execute("SELECT * FROM collection_assets ORDER BY collection_id,asset_id")]
    assert catalog.db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    print(json.dumps({"ok": True, "preserved_assets": len(before), "collection_members": len(collections),
                      "integrity_check": "ok", "snapshot": str(out),
                      "mode": "additive schema migration; original database read-only"}, ensure_ascii=False))
finally:
    catalog.close()
    catalog.worker.join(2)
    catalog.db.close()
