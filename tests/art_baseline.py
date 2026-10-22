"""Score fixed artwork queries on an isolated snapshot of the real local library.

Read-only source DB. No scanning, metadata writes or model changes in the live app.
Expected examples are positive examples only, not exhaustive relevance judgments.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog import Catalog
from embed import Embedder


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, default=Path.home() / "Library/Application Support/Prism Assets/library/catalog.sqlite3")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    queries = json.loads(Path(__file__).with_name("art_queries.json").read_text())["queries"]
    rules = ["node_modules", "build", "dist", "release", "__pycache__"]
    with tempfile.TemporaryDirectory(prefix="prism-art-baseline-") as temp:
        db = sqlite3.connect(Path(temp) / "snapshot.sqlite3")
        with sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True) as source:
            source.backup(db)
        db.row_factory = sqlite3.Row
        if "excluded" not in {r["name"] for r in db.execute("PRAGMA table_info(assets)")}:
            db.execute("ALTER TABLE assets ADD COLUMN excluded INTEGER DEFAULT 0")
        db.executescript("""CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,name TEXT,created REAL);
            CREATE TABLE IF NOT EXISTS collection_assets(collection_id TEXT,asset_id TEXT,PRIMARY KEY(collection_id,asset_id));""")
        catalog = Catalog.__new__(Catalog)
        catalog.db, catalog.lock = db, threading.RLock()
        originals = {r["id"]: r["excluded"] for r in catalog.rows("SELECT id,excluded FROM assets")}
        excluded_ids = []
        for folder in catalog.rows("SELECT id,path FROM folders"):
            for asset in catalog.rows("SELECT id,path FROM assets WHERE folder_id=?", (folder["id"],)):
                if Catalog.excluded_path(asset["path"], folder["path"], rules):
                    excluded_ids.append(asset["id"])
        model = Embedder()
        records = []
        for query in queries:
            start = time.perf_counter()
            vector = model.text([query["text"]])[0]
            encoding_ms = (time.perf_counter() - start) * 1000
            cases = {}
            for mode in ["before", "after"]:
                db.executemany("UPDATE assets SET excluded=? WHERE id=?",
                               [(value, aid) for aid, value in originals.items()])
                if mode == "after":
                    db.executemany("UPDATE assets SET excluded=1 WHERE id=?", [(aid,) for aid in excluded_ids])
                start = time.perf_counter()
                result = catalog.list_assets({"group_duplicates": mode == "after", "top_k": 50, "limit": 50}, vector)
                retrieval_ms = (time.perf_counter() - start) * 1000
                hits = result["items"]
                expected = set(query["expected_examples"])
                ranks = [rank for rank, asset in enumerate(hits, 1) if Path(asset["path"]).stem in expected]
                cases[mode] = {
                    "scope_files": result["scope_total"], "unique_candidates": result["unique_total"],
                    "returned": len(hits), "retrieval_ms": round(retrieval_ms, 2),
                    "best_known_positive_rank": min(ranks) if ranks else None,
                    "known_positive_in_top10": bool(ranks and min(ranks) <= 10),
                    "duplicate_slots_in_top10": len(hits[:10]) - len({a["hash"] or a["id"] for a in hits[:10]}),
                    "top10": [{"name": a["name"], "id": a["id"], "path": a["path"],
                               "score": a["score"], "copies": a["copy_count"]} for a in hits[:10]],
                }
            records.append({**query, "encoding_ms": round(encoding_ms, 2), **cases})
            print(json.dumps({"query": query["text"], "before_rank": cases["before"]["best_known_positive_rank"],
                              "after_rank": cases["after"]["best_known_positive_rank"]}, ensure_ascii=False), flush=True)
        report = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source": "read-only snapshot of current Prism library",
            "model_changed": False, "exclusion_rules_simulated_only": rules,
            "excluded_snapshot_files": len(excluded_ids),
            "note": "Before/after compares governance only. Positive examples are incomplete; no nDCG, precision or overall recall claim.",
            "query_count": len(records),
            "known_positive_in_top10_before": sum(r["before"]["known_positive_in_top10"] for r in records),
            "known_positive_in_top10_after": sum(r["after"]["known_positive_in_top10"] for r in records),
            "duplicate_slots_top10_before": sum(r["before"]["duplicate_slots_in_top10"] for r in records),
            "duplicate_slots_top10_after": sum(r["after"]["duplicate_slots_in_top10"] for r in records),
            "queries": records,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        db.close()
        print(json.dumps({k: v for k, v in report.items() if k != "queries"}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
