"""Audit sampling and merge for evaluation/run.py. Temporary files only; no model or library access."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "evaluation"))
from run import audit_sample, audit_summary, merge


def document():
    return {"version": 1, "queries": [
        {"id": "q1", "text": "a", "judgments": {"x": 3, "y": 2, "z": 1, "w": 0, "v": 3}},
        {"id": "q2", "text": "b", "judgments": {"x": 0, "y": 0}},
    ]}


class Audit(unittest.TestCase):
    def test_sample_is_deterministic_and_spreads_over_grades(self):
        queries = document()["queries"]
        first = audit_sample(queries, 4, seed=7)
        self.assertEqual(first, audit_sample(queries, 4, seed=7))
        grades = {queries[0]["judgments"][k] for k in first["q1"]}
        self.assertEqual(grades, {0, 1, 2, 3})
        self.assertEqual(len(audit_sample(queries, 10, seed=0)["q2"]), 2)

    def test_merge_records_agreement_and_applies_grades(self):
        doc = document()
        review = {"mode": "audit", "reviewed": "now", "grades": {"q1": {"x": 3, "y": 1, "new": 2}, "q2": {"x": 0}}}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "queries.json"
            result = merge(doc, review, path)
            saved = json.loads(path.read_text())
        # Only previously judged items count towards agreement; "new" is an addition.
        self.assertEqual(result["agreement"]["items"], 3)
        self.assertAlmostEqual(result["agreement"]["exact"], 2 / 3)
        self.assertEqual([(c["key"], c["from"], c["to"]) for c in result["changes"]], [("y", 2, 1), ("new", None, 2)])
        self.assertEqual(saved["queries"][0]["judgments"]["y"], 1)
        self.assertEqual(saved["queries"][0]["judgments"]["new"], 2)
        self.assertEqual(saved["audits"][0]["changed"], 2)
        self.assertEqual(audit_summary(saved)["items"], 3)

    def test_merge_rejects_unknown_queries_and_bad_grades(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "queries.json"
            with self.assertRaises(SystemExit):
                merge(document(), {"mode": "audit", "grades": {"q9": {"x": 1}}}, path)
            with self.assertRaises(SystemExit):
                merge(document(), {"mode": "audit", "grades": {"q1": {"x": 5}}}, path)
            self.assertFalse(path.exists())
        self.assertIsNone(audit_summary(document()))


if __name__ == "__main__":
    unittest.main()
