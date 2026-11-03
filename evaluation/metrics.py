"""Ranking and agreement metrics for graded relevance (0–3). Pure functions; no catalog or model access.

`ranked` is the grade of each returned item in rank order. `ideal` holds the grades of every
judged unit in the search scope, so Recall and nDCG are bounded by what the query could find.
"""
import math

import numpy as np

RELEVANT = 2  # Binary metrics count “高度相关” and above; nDCG uses every grade.
LEVELS = 4


def dcg(grades):
    return sum((2 ** g - 1) / math.log2(rank + 2) for rank, g in enumerate(grades))


def ndcg(ranked, ideal, k):
    best = dcg(sorted(ideal, reverse=True)[:k])
    return dcg(ranked[:k]) / best if best else None


def recall(ranked, ideal, k, threshold=RELEVANT):
    total = sum(g >= threshold for g in ideal)
    return sum(g >= threshold for g in ranked[:k]) / total if total else None


def reciprocal_rank(ranked, threshold=RELEVANT):
    return next((1 / rank for rank, g in enumerate(ranked, 1) if g >= threshold), 0.0)


def evaluate(ranked, ideal, ks=(1, 5, 10, 20)):
    """Per-query metrics. None means the metric is undefined (nothing relevant was judged)."""
    if any(sum(g >= t for g in ranked) > sum(g >= t for g in ideal) for t in (1, 2, 3)):
        raise ValueError("返回结果中的相关素材多于已标注数量，检查去重分组是否一致")
    has_relevant = any(g >= RELEVANT for g in ideal)
    result = {"mrr": reciprocal_rank(ranked) if has_relevant else None}
    for k in ks:
        result[f"recall@{k}"] = recall(ranked, ideal, k)
        result[f"ndcg@{k}"] = ndcg(ranked, ideal, k)
    return result


def mean(records, metric):
    values = [r[metric] for r in records if r[metric] is not None]
    return sum(values) / len(values) if values else None


def paired_bootstrap(a, b, samples=10000, seed=0):
    """Mean of (a - b) with a 95% percentile interval, resampling queries with replacement."""
    diff = np.asarray(a, dtype=float) - np.asarray(b, dtype=float)
    if not len(diff):
        return None
    rng = np.random.default_rng(seed)
    means = diff[rng.integers(0, len(diff), (samples, len(diff)))].mean(axis=1)
    low, high = np.percentile(means, [2.5, 97.5])
    return {"mean": float(diff.mean()), "low": float(low), "high": float(high),
            "wins": int((diff > 0).sum()), "losses": int((diff < 0).sum()), "ties": int((diff == 0).sum())}


def confusion(first, second, levels=LEVELS):
    """Counts matrix [first grade][second grade]; matrices from several audits can be summed."""
    matrix = [[0] * levels for _ in range(levels)]
    for a, b in zip(first, second, strict=True):
        matrix[a][b] += 1
    return matrix


def kappa(matrix, weights="quadratic"):
    """Cohen's kappa. Quadratic weights penalise a 0↔3 disagreement nine times a 0↔1 one."""
    observed = np.asarray(matrix, dtype=float)
    if not observed.sum():
        return None
    observed /= observed.sum()
    expected = np.outer(observed.sum(axis=1), observed.sum(axis=0))
    i, j = np.indices(observed.shape)
    weight = ((i - j) / (len(observed) - 1)) ** 2 if weights == "quadratic" else (i != j).astype(float)
    chance = (weight * expected).sum()
    return float(1 - (weight * observed).sum() / chance) if chance else None


def agreement(matrix, threshold=RELEVANT):
    m = np.asarray(matrix)
    total = int(m.sum())
    if not total:
        return {"items": 0}
    i, j = np.indices(m.shape)
    binary = [[m[(i < threshold) & (j < threshold)].sum(), m[(i < threshold) & (j >= threshold)].sum()],
              [m[(i >= threshold) & (j < threshold)].sum(), m[(i >= threshold) & (j >= threshold)].sum()]]
    return {"items": total, "exact": float(m[i == j].sum() / total),
            "within_one": float(m[abs(i - j) <= 1].sum() / total),
            "weighted_kappa": kappa(m), "binary_kappa": kappa(binary, weights="nominal")}
