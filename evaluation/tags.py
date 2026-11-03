"""Suggested-tag evaluation on a read-only snapshot of the local Prism library.

  .venv/bin/python evaluation/tags.py                  # → verification-eval/tags.{md,json}

Ground truth comes from `tag_truth.json`: category labels derived from dataset manifests and
folder conventions, never from model output. Two settings are compared per group:

- zero-shot: only the English prompts in the vocabulary;
- examples:  for each label, N truth-labelled assets act as if the user had tagged them by hand
             (repeated with several random draws; those assets are left out of scoring).

Reported per label: precision/recall of the suggestion at the group threshold, and the
coverage–accuracy curve over thresholds, so the default threshold is a measured choice.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run import LIBRARY, ROOT, open_snapshot, scope
from auto_tags import DEFAULT_VOCABULARY, MIN_EXAMPLES, PROMPT_WEIGHT, softmax
import tempfile

THRESHOLDS = (0.0, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)


def load_truth(path, assets):
    """{key: label} from prefix/suffix rules; first matching rule wins."""
    spec = json.loads(path.read_text())
    keys = sorted(a["key"] for a in assets.values())
    truth = {}
    for rule in spec["rules"]:
        for key in keys:
            if key in truth:
                continue
            if any(key == k for k in rule.get("keys", ())) or any(key.startswith(p) for p in rule.get("prefixes", ())) \
                    or any(key.endswith(s) for s in rule.get("suffixes", ())):
                truth[key] = rule["label"]
    return spec["group"], truth


def classify(vectors, prototypes, labels):
    """Best label and its softmax share for every row."""
    scores = vectors @ np.stack([prototypes[l] for l in labels]).T
    shares = np.apply_along_axis(softmax, 1, scores)
    best = shares.argmax(axis=1)
    return [labels[i] for i in best], shares[np.arange(len(best)), best]


def measure(pred, conf, truth, labels, threshold):
    pred, conf, truth = np.array(pred), np.array(conf), np.array(truth)
    shown = conf >= threshold
    per_label = {}
    for label in labels:
        suggested = shown & (pred == label)
        actual = truth == label
        per_label[label] = {"support": int(actual.sum()), "suggested": int(suggested.sum()),
                            "precision": float((suggested & actual).sum() / suggested.sum()) if suggested.any() else None,
                            "recall": float((suggested & actual).sum() / actual.sum()) if actual.any() else None}
    curve = [{"threshold": t, "coverage": float((conf >= t).mean()),
              "accuracy": float((pred[conf >= t] == truth[conf >= t]).mean()) if (conf >= t).any() else None}
             for t in THRESHOLDS]
    recalls = [v["recall"] for v in per_label.values() if v["recall"] is not None]
    return {"accuracy": float((pred == truth).mean()), "balanced_accuracy": float(np.mean(recalls_all(pred, truth, labels))),
            "coverage": float(shown.mean()), "shown_accuracy": float((pred[shown] == truth[shown]).mean()) if shown.any() else None,
            "macro_recall_at_threshold": float(np.mean(recalls)) if recalls else None,
            "per_label": per_label, "curve": curve}


def recalls_all(pred, truth, labels):
    return [(pred[truth == l] == l).mean() for l in labels if (truth == l).any()]


def average(runs):
    """Mean of numeric leaves across repeated draws; None stays None if any draw is None."""
    first = runs[0]
    if isinstance(first, dict):
        return {k: first[k] if k in ("threshold", "seeded") else average([r[k] for r in runs]) for k in first}
    if isinstance(first, list):
        return [average([r[i] for r in runs]) for i in range(len(first))]
    if isinstance(first, (int, float)) and not isinstance(first, bool) and all(r is not None for r in runs):
        return float(np.mean(runs))
    return first if all(r == first for r in runs) else None


def markdown(report):
    g = report["group"]
    lines = ["# 建议标签评测", "",
             f"- 时间：{report['created_at']}",
             f"- 分组：{g['name']}（{len(g['labels'])} 个标签），阈值 {g['threshold']}；温度、样例融合权重与应用一致"
             f"（样例与英文描述各占 {PROMPT_WEIGHT:.0%}）",
             f"- 真值：{report['truth']['assets']} 个素材，来自 `evaluation/tag_truth.json` 中按目录与清单整理的规则，"
             "不使用模型输出", "",
             "| 设置 | Top-1 准确率 | 类别平均召回 | 达到阈值的覆盖率 | 达到阈值时准确率 |", "|---|---:|---:|---:|---:|"]
    pct = lambda v: "—" if v is None else f"{v:.1%}"
    for name, r in report["settings"].items():
        lines.append(f"| {name} | {pct(r['accuracy'])} | {pct(r['balanced_accuracy'])} | {pct(r['coverage'])} | {pct(r['shown_accuracy'])} |")
    for name, r in report["settings"].items():
        lines.extend(["", f"## {name}：按标签（阈值 {g['threshold']}）", "",
                      "| 标签 | 真值数量 | 建议数 | 精确率 | 召回率 |", "|---|---:|---:|---:|---:|"])
        for label, v in r["per_label"].items():
            note = "（真值不足，未加样例，仍为零样本）" if v.get("seeded") is False else ""
            lines.append(f"| {label}{note} | {v['support']:.0f} | {v['suggested']:.1f} | {pct(v['precision'])} | {pct(v['recall'])} |")
        lines.extend(["", "| 阈值 | 覆盖率 | 准确率 |", "|---:|---:|---:|"])
        lines.extend(f"| {c['threshold']} | {pct(c['coverage'])} | {pct(c['accuracy'])} |" for c in r["curve"])
    lines.extend(["", "## 说明", "",
                  "- 准确率按单标签计算：每个素材在本分组中只有一个真值标签，建议的 Top-1 与真值一致即为正确。",
                  "- “样例”设置每次为每个标签随机抽取样例，结果为多次抽样的平均值；样例本身不计入评分。",
                  "- 分数是组内 softmax 份额，只用于排序和阈值过滤，不是校准后的概率。"])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database", type=Path, default=LIBRARY / "catalog.sqlite3")
    parser.add_argument("--truth", type=Path, default=Path(__file__).with_name("tag_truth.json"))
    parser.add_argument("--output", type=Path, default=ROOT / "verification-eval")
    parser.add_argument("--examples", type=int, default=MIN_EXAMPLES, help="每个标签模拟的人工样例数")
    parser.add_argument("--draws", type=int, default=10, help="样例设置的随机抽样次数")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="prism-tag-eval-") as temp:
        catalog = open_snapshot(args.database, temp)
        assets = scope(catalog)
        group_id, truth = load_truth(args.truth, assets)
        group = next(g for g in DEFAULT_VOCABULARY if g["id"] == group_id)
        labels = [l["label"] for l in group["labels"]]
        rows = catalog.rows("SELECT id,vector FROM assets WHERE status='ready' AND vector IS NOT NULL")
        vectors = {r["id"]: np.frombuffer(r["vector"], dtype=np.float32) for r in rows}
        catalog.db.close()
    items = [(aid, truth[a["key"]]) for aid, a in assets.items() if a["key"] in truth and aid in vectors]
    unknown = sorted({t for _, t in items} - set(labels))
    if unknown:
        raise SystemExit(f"真值标签不在词表分组「{group['name']}」中：{unknown}")
    from embed import Embedder
    model = Embedder()
    text = dict(zip(labels, model.text([l["prompt"] for l in group["labels"]][:8], task="query"))) if len(labels) <= 8 else \
        {l["label"]: model.text([l["prompt"]], task="query")[0] for l in group["labels"]}
    V = np.stack([vectors[aid] for aid, _ in items])
    y = [label for _, label in items]

    pred, conf = classify(V, text, labels)
    settings = {"零样本（英文描述）": measure(pred, conf, y, labels, group["threshold"])}
    runs = []
    rng = np.random.default_rng(0)
    for _ in range(args.draws):
        prototypes, held = dict(text), np.zeros(len(items), bool)
        for label in labels:
            idx = [i for i, t in enumerate(y) if t == label]
            if len(idx) <= args.examples:
                continue  # Not enough truth to both seed and score this label.
            pick = rng.choice(idx, args.examples, replace=False)
            held[pick] = True
            visual = V[pick].mean(axis=0)
            visual /= np.linalg.norm(visual)
            blended = PROMPT_WEIGHT * text[label] + (1 - PROMPT_WEIGHT) * visual
            prototypes[label] = blended / np.linalg.norm(blended)
        keep = ~held
        p, c = classify(V[keep], prototypes, labels)
        result = measure(p, c, [y[i] for i in np.flatnonzero(keep)], labels, group["threshold"])
        for label in labels:
            result["per_label"][label]["seeded"] = sum(t == label for t in y) > args.examples
        runs.append(result)
    settings[f"零样本 + 每个标签 {args.examples} 张样例"] = average(runs)
    report = {"created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "group": group, "truth": {"assets": len(items),
                                        "per_label": {l: sum(t == l for t in y) for l in labels}},
              "examples": args.examples, "draws": args.draws, "settings": settings}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "tags.json").write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n")
    (args.output / "tags.md").write_text(markdown(report))
    print(json.dumps({name: {k: round(v, 3) for k, v in r.items() if isinstance(v, float)}
                      for name, r in settings.items()}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
