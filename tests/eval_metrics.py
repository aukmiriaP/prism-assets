"""Hand-computed checks for evaluation/metrics.py. No model, catalog or library access."""
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "evaluation"))
from metrics import (agreement, confusion, dcg, evaluate, kappa, mean, ndcg, paired_bootstrap,
                     recall, reciprocal_rank)


class Metrics(unittest.TestCase):
    def test_dcg_uses_exponential_gain_and_log_discount(self):
        # (2^3-1)/log2(2) + (2^0-1)/log2(3) + (2^2-1)/log2(4)
        self.assertAlmostEqual(dcg([3, 0, 2]), 7 + 0 + 3 / 2)

    def test_ndcg_is_one_for_ideal_order_and_bounded_by_judged_pool(self):
        self.assertAlmostEqual(ndcg([3, 2, 1], [1, 3, 2], 3), 1.0)
        expected = (7 + 3 / math.log2(3)) / (7 + 3 / math.log2(3) + 1 / 2)
        self.assertAlmostEqual(ndcg([3, 2, 0], [3, 2, 1], 3), expected)
        # Fewer results than k still compare against the full ideal list.
        self.assertAlmostEqual(ndcg([3], [3, 3], 5), 7 / (7 + 7 / math.log2(3)))
        self.assertIsNone(ndcg([0, 0], [], 10))

    def test_recall_counts_grade_two_and_above(self):
        self.assertAlmostEqual(recall([1, 2, 0, 3], [3, 2, 2, 1], 2), 1 / 3)
        self.assertAlmostEqual(recall([1, 2, 0, 3], [3, 2, 2, 1], 4), 2 / 3)
        self.assertIsNone(recall([1], [1, 1], 10))

    def test_reciprocal_rank_skips_partial_matches(self):
        self.assertEqual(reciprocal_rank([1, 0, 2]), 1 / 3)
        self.assertEqual(reciprocal_rank([0, 1]), 0.0)

    def test_evaluate_marks_undefined_metrics(self):
        result = evaluate([1, 0], [1], ks=(5,))
        self.assertIsNone(result["mrr"])
        self.assertIsNone(result["recall@5"])
        self.assertAlmostEqual(result["ndcg@5"], 1.0)
        self.assertEqual(mean([{"m": None}, {"m": 0.5}, {"m": 1.0}], "m"), 0.75)
        # More relevant hits than judged units means duplicate grouping diverged; fail loudly.
        with self.assertRaises(ValueError):
            evaluate([1, 1], [1])
        with self.assertRaises(ValueError):
            evaluate([3, 0], [2, 2])

    def test_paired_bootstrap_reports_direction_and_counts(self):
        stats = paired_bootstrap([1, 1, 1, 0.5], [0, 0, 1, 0.5], samples=2000)
        self.assertAlmostEqual(stats["mean"], 0.5)
        self.assertEqual((stats["wins"], stats["losses"], stats["ties"]), (2, 0, 2))
        self.assertLessEqual(stats["low"], stats["mean"])
        self.assertGreaterEqual(stats["high"], stats["mean"])
        self.assertIsNone(paired_bootstrap([], []))

    def test_quadratic_kappa_matches_hand_computation(self):
        self.assertAlmostEqual(kappa(confusion([0, 1, 2, 3], [0, 1, 2, 3])), 1.0)
        # Observed weighted disagreement 1.0, chance 0.5 → 1 - 1 / 0.5.
        self.assertAlmostEqual(kappa(confusion([0, 0, 3, 3], [3, 3, 0, 0])), -1.0)
        self.assertIsNone(kappa(confusion([], [])))
        self.assertIsNone(kappa(confusion([2, 2], [2, 2])))  # No variation: chance agreement is total.

    def test_agreement_collapses_to_relevant_threshold(self):
        stats = agreement(confusion([0, 2, 3, 0], [0, 2, 0, 0]))
        self.assertEqual(stats["items"], 4)
        self.assertAlmostEqual(stats["exact"], 0.75)
        self.assertAlmostEqual(stats["within_one"], 0.75)
        # Binary: observed 0.75, chance 0.5·0.75 + 0.5·0.25 = 0.5 → (0.75 - 0.5) / 0.5.
        self.assertAlmostEqual(stats["binary_kappa"], 0.5)
        summed = [[a + b for a, b in zip(r1, r2)] for r1, r2 in
                  zip(confusion([0, 1], [0, 1]), confusion([1, 3], [1, 2]))]
        self.assertEqual(agreement(summed)["items"], 4)
        self.assertEqual(agreement(confusion([], [])), {"items": 0})


if __name__ == "__main__":
    unittest.main()
