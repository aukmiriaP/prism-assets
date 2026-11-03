"""Retrieval evaluation on a read-only snapshot of the local Prism library.

  .venv/bin/python evaluation/run.py score    # metrics for keyword / semantic / hybrid
  .venv/bin/python evaluation/run.py review   # sampled audit page → verification-eval/review.html
  .venv/bin/python evaluation/run.py merge ~/Downloads/prism-review.json   # apply audit, report agreement
  .venv/bin/python evaluation/run.py pool     # full page: every judged item + unjudged Top-K

The live database is copied with SQLite's backup API in read-only mode; nothing in the app's
library, thumbnails or settings is written. Judgments use paths relative to the linked folder,
so they survive re-indexing (asset IDs do not). An explicit 0 means “reviewed, irrelevant”.
"""
import argparse
import base64
from collections import defaultdict
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import random
import sqlite3
import sys
import tempfile
import threading
import time

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from catalog import Catalog, PROFILE
from metrics import agreement, confusion, evaluate, mean, paired_bootstrap

LIBRARY = Path.home() / "Library/Application Support/Prism Assets/library"
STRATEGIES = ("keyword", "semantic", "hybrid")
KS = (1, 5, 10, 20)
DEPTH = 100
# Same defaults as the app's search request (app_server.Filters), with a deeper Top-K for scoring.
FILTERS = {"kind": "", "include_components": False, "exclude_components": False, "folder_id": "",
           "collection_id": "", "model_id": "", "motion_package": "", "include_model": False,
           "relation": "", "status": "", "favorite": False, "ext": "", "name": "", "tag": "",
           "min_width": 0, "sort": "newest", "offset": 0, "limit": DEPTH, "top_k": DEPTH,
           "group_duplicates": True}


def open_snapshot(database, temp):
    db = sqlite3.connect(Path(temp) / "snapshot.sqlite3", check_same_thread=False)
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as source:
        source.backup(db)
    db.row_factory = sqlite3.Row
    profile = db.execute("SELECT value FROM meta WHERE key='profile'").fetchone()
    if not profile or profile["value"] != PROFILE:
        raise SystemExit(f"索引向量的模型配置与当前代码不一致：{profile and profile['value']}")
    # Bypass Catalog.__init__: no scanner, watcher or migrations against the snapshot.
    catalog = Catalog.__new__(Catalog)
    catalog.db, catalog.lock = db, threading.RLock()
    return catalog


def scope(catalog, only=()):
    """Map every searchable asset to its judgment key and its exact-duplicate group.

    `only` keeps assets under these relative prefixes; the rest are marked excluded in the
    snapshot, which is how the app itself hides folders from search.
    """
    clauses, params = catalog.asset_filters(FILTERS)
    rows = catalog.rows("""SELECT a.id,a.path,a.kind,a.hash,a.status,a.thumbnail,f.path root
        FROM assets a JOIN folders f ON f.id=a.folder_id WHERE """ + " AND ".join(clauses), params)
    assets, hidden = {}, []
    for row in rows:
        key = str(Path(row["path"]).relative_to(row["root"]))
        if only and not key.startswith(tuple(only)):
            hidden.append((row["id"],))
            continue
        group = "hash:" + row["hash"] if row["status"] == "ready" and row["hash"] else "id:" + row["id"]
        assets[row["id"]] = {"key": key, "group": group, "kind": row["kind"], "thumbnail": row["thumbnail"]}
    catalog.db.executemany("UPDATE assets SET excluded=1 WHERE id=?", hidden)
    return assets


def search(catalog, strategy, text, vector):
    filters = dict(FILTERS)
    if strategy == "keyword":
        result = catalog.text_assets(text, filters, strategy="keyword")
    elif strategy == "semantic":
        result = catalog.list_assets(filters, vector)
    else:
        result = catalog.text_assets(text, filters, vector)
    return [(item["member_ids"], item.get("match_kind", strategy)) for item in result["items"]]


def run_queries(catalog, queries, assets):
    from embed import Embedder
    model = Embedder()
    by_key = {a["key"]: aid for aid, a in assets.items()}
    unknown = sorted({k for q in queries for k in q["judgments"] if k not in by_key})
    if unknown:
        print(f"警告：{len(unknown)} 个标注路径不在当前检索范围内（已失联、被排除或未索引）：", file=sys.stderr)
        for key in unknown[:20]:
            print("  " + key, file=sys.stderr)
    runs = []
    for query in queries:
        started = time.perf_counter()
        vector = model.text([query["text"]])[0]
        encode_ms = (time.perf_counter() - started) * 1000
        # A duplicate group is judged by its best copy, mirroring how results are collapsed.
        groups = defaultdict(int)
        for key, grade in query["judgments"].items():
            if key in by_key:
                group = assets[by_key[key]]["group"]
                groups[group] = max(groups[group], grade)
        record = {"query": query, "encode_ms": encode_ms, "ideal": list(groups.values()), "results": {}}
        for strategy in STRATEGIES:
            started = time.perf_counter()
            hits = search(catalog, strategy, query["text"], vector)
            record["results"][strategy] = {
                "ms": (time.perf_counter() - started) * 1000,
                "hits": [{"ids": ids, "match": match, "key": assets[ids[0]]["key"],
                          "grade": max((query["judgments"].get(assets[i]["key"], 0) for i in ids), default=0)}
                         for ids, match in hits],
            }
        runs.append(record)
        print(f"{query['id']} {query['text']}", file=sys.stderr, flush=True)
    return runs


def score(runs):
    per_query = []
    for run in runs:
        row = {k: run["query"][k] for k in ("id", "text", "intent", "lang", "style")}
        for strategy in STRATEGIES:
            hits = run["results"][strategy]["hits"]
            grades = [h["grade"] for h in hits]
            row[strategy] = {**evaluate(grades, run["ideal"], KS), "returned": len(hits),
                             "keyword_hits": sum(h["match"] in ("keyword", "both") for h in hits),
                             "search_ms": round(run["results"][strategy]["ms"], 2)}
        per_query.append(row)
    metrics = ["mrr"] + [f"{m}@{k}" for k in KS for m in ("recall", "ndcg")]

    def summarize(rows):
        return {s: {m: mean([r[s] for r in rows], m) for m in metrics} for s in STRATEGIES} | {"queries": len(rows)}

    breakdown = {}
    for field in ("intent", "lang", "style"):
        values = sorted({r[field] for r in per_query})
        breakdown[field] = {v: summarize([r for r in per_query if r[field] == v]) for v in values}
    comparisons = {}
    for a, b in (("hybrid", "semantic"), ("hybrid", "keyword"), ("semantic", "keyword")):
        rows = [r for r in per_query if r[a]["ndcg@10"] is not None]
        comparisons[f"{a} - {b}"] = {
            "ndcg@10": paired_bootstrap([r[a]["ndcg@10"] for r in rows], [r[b]["ndcg@10"] for r in rows]),
            "mrr": paired_bootstrap([r[a]["mrr"] for r in rows if r[a]["mrr"] is not None],
                                    [r[b]["mrr"] for r in rows if r[b]["mrr"] is not None]),
        }
    latency = {s: {"median_ms": sorted(r[s]["search_ms"] for r in per_query)[len(per_query) // 2]} for s in STRATEGIES}
    latency["encode_median_ms"] = round(sorted(r["encode_ms"] for r in runs)[len(runs) // 2], 2)
    # Hubs: items that reach the semantic Top-10 of many queries without being relevant to them.
    hubs = defaultdict(int)
    for run in runs:
        for hit in run["results"]["semantic"]["hits"][:10]:
            if hit["grade"] == 0:
                hubs[hit["key"]] += 1
    hubs = [{"key": k, "irrelevant_top10": n} for k, n in sorted(hubs.items(), key=lambda kv: (-kv[1], kv[0]))
            if n >= max(3, len(runs) // 10)]
    return {"overall": summarize(per_query), "breakdown": breakdown, "comparisons": comparisons,
            "latency": latency, "hubs": hubs, "per_query": per_query}


def markdown(report):
    audit = report["audit"]
    audit_line = ("- 标注复核：尚未进行人工抽样复核，指标基于 AI 初稿。" if not audit else
                  f"- 标注复核：人工抽样 {audit['items']} 条（{audit['audits']} 轮），完全一致 {audit['exact']:.0%}，"
                  f"相差 ≤1 分 {audit['within_one']:.0%}，加权 κ = {audit['weighted_kappa']:.2f}，"
                  f"相关/不相关 κ = {audit['binary_kappa']:.2f}。")
    lines = [f"# 检索评测报告", "",
             f"- 时间：{report['created_at']}",
             f"- 检索范围：{report['scope']['assets']} 个文件 / {report['scope']['groups']} 个去重单元"
             + (f"（仅 {', '.join(report['scope']['only'])}）" if report["scope"]["only"] else "（日常库全部可检索素材）")
             + f"；{report['queries']} 条查询，{report['judgments']} 条非零标注",
             f"- 模型：`{PROFILE}`", audit_line,
             "- 二值指标（Recall、MRR）以 2 分及以上为相关；nDCG 使用 0–3 分级增益 `2^g − 1`。", ""]
    metrics = ["mrr", "recall@5", "recall@10", "recall@20", "ndcg@5", "ndcg@10", "ndcg@20"]

    def table(title, summary):
        lines.extend([f"### {title}（{summary['queries']} 条）", "",
                      "| 策略 | " + " | ".join(m.replace("recall", "Recall").replace("ndcg", "nDCG").upper() if m == "mrr"
                                              else m.replace("recall", "Recall").replace("ndcg", "nDCG") for m in metrics) + " |",
                      "|---|" + "---:|" * len(metrics)])
        for s in STRATEGIES:
            cells = [f"{summary[s][m]:.3f}" if summary[s][m] is not None else "—" for m in metrics]
            lines.append(f"| {s} | " + " | ".join(cells) + " |")
        lines.append("")

    lines.append("## 总体")
    lines.append("")
    table("全部查询", report["overall"])
    lines.extend(["## 配对差异（按查询自助法重采样 10000 次，95% 区间）", "",
                  "| 对比 | ΔnDCG@10 | 区间 | 胜/负/平 | ΔMRR | 区间 |", "|---|---:|---|---|---:|---|"])
    for name, c in report["comparisons"].items():
        n, m = c["ndcg@10"], c["mrr"]
        lines.append(f"| {name} | {n['mean']:+.3f} | [{n['low']:+.3f}, {n['high']:+.3f}] | "
                     f"{n['wins']}/{n['losses']}/{n['ties']} | {m['mean']:+.3f} | [{m['low']:+.3f}, {m['high']:+.3f}] |")
    lines.append("")
    names = {"intent": "按素材类型", "lang": "按查询语言", "style": "按查询方式"}
    for field, groups in report["breakdown"].items():
        lines.extend([f"## {names[field]}", ""])
        for value, summary in groups.items():
            table(value, summary)
    lines.extend(["## 延迟（中位数）", "",
                  f"- 文本编码：{report['latency']['encode_median_ms']} ms",
                  *[f"- {s} 排序：{report['latency'][s]['median_ms']} ms" for s in STRATEGIES], "",
                  f"## 高频干扰项（语义检索中不相关却进入 Top-10 的查询数，共 {report['queries']} 条）", "",
                  "| 素材 | 次数 |", "|---|---:|",
                  *[f"| `{h['key']}` | {h['irrelevant_top10']} |" for h in report["hubs"]], "",
                  "## 逐条 nDCG@10（由低到高，便于定位 badcase）", "",
                  "| ID | 查询 | keyword | semantic | hybrid | hybrid 关键词命中数 |", "|---|---|---:|---:|---:|---:|"])
    fmt = lambda v: "—" if v is None else f"{v:.2f}"
    for r in sorted(report["per_query"], key=lambda r: (r["hybrid"]["ndcg@10"] or 0, r["id"])):
        lines.append(f"| {r['id']} | {r['text']} | {fmt(r['keyword']['ndcg@10'])} | {fmt(r['semantic']['ndcg@10'])} | "
                     f"{fmt(r['hybrid']['ndcg@10'])} | {r['hybrid']['keyword_hits']} |")
    return "\n".join(lines) + "\n"


def thumbnail_uri(library, name, cache={}):
    """Inline data URI: browsers block file:// images from a local page in another folder."""
    if name not in cache:
        path = library / "thumbnails" / name if name else None
        if path and path.is_file():
            with Image.open(path) as image:
                image.thumbnail((360, 360))
                buffer = io.BytesIO()
                image.save(buffer, "WEBP", quality=75)
            cache[name] = "data:image/webp;base64," + base64.b64encode(buffer.getvalue()).decode()
        else:
            cache[name] = ""
    return cache[name]


def audit_sample(queries, per_query, seed):
    """Stratified sample so a short review covers every grade, including explicit zeros."""
    rng = random.Random(seed)
    sample = {}
    for query in queries:
        strata = defaultdict(list)
        for key, grade in query["judgments"].items():
            strata[grade].append(key)
        picked = []
        order = sorted(strata)
        rng.shuffle(order)
        for grade in order:
            rng.shuffle(strata[grade])
        # Round-robin over grades in a per-query random order, so across queries every grade
        # (explicit zeros included) is drawn about equally often even with two items per query.
        while len(picked) < per_query and any(strata.values()):
            for grade in order:
                if strata[grade] and len(picked) < per_query:
                    picked.append(strata[grade].pop())
        sample[query["id"]] = sorted(picked)
    return sample


def review_page(queries, items, assets, library, mode):
    """Self-contained HTML. Grades start hidden in audit mode so the reviewer judges independently."""
    by_key = {a["key"]: a for a in assets.values()}
    data = {"mode": mode, "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "queries": [{k: q[k] for k in ("id", "text", "intent", "lang", "style")} for q in queries],
            "items": {qid: [{"key": key, "draft": next(q for q in queries if q["id"] == qid)["judgments"].get(key),
                             "thumb": thumbnail_uri(library, by_key[key]["thumbnail"]) if key in by_key else ""}
                            for key in keys] for qid, keys in items.items()}}
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    total = sum(len(v) for v in items.values())
    hint = ("抽样复核：初稿分数先隐藏，请独立打分；提交后再显示差异。" if mode == "audit"
            else "完整复核：显示初稿分数，可直接修改；蓝色虚线为未标注的新候选。")
    return """<!doctype html><meta charset="utf-8"><title>Prism 检索标注</title>
<style>
body{font:14px -apple-system,sans-serif;margin:0;background:#f4f4f5;color:#18181b}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 20px;display:flex;gap:14px;align-items:center;z-index:2;flex-wrap:wrap}
header p{margin:0;color:#52525b;flex:1;min-width:240px}.keys{color:#71717a;font-size:12px}
section{padding:12px 20px;border-bottom:1px solid #e4e4e7}h2{font-size:15px;margin:4px 0 8px}h2 small{color:#71717a;font-weight:normal}
.grid{display:flex;flex-wrap:wrap;gap:10px}.card{width:220px;background:#fff;border:2px solid #e4e4e7;border-radius:8px;padding:6px;outline:none}
.card:focus{box-shadow:0 0 0 3px #93c5fd}.card img{width:100%;height:140px;object-fit:contain;background:#e4e4e7;border-radius:4px}
.card small{display:block;word-break:break-all;color:#71717a;font-size:11px;height:28px;overflow:hidden;margin-top:4px}
.g3{border-color:#16a34a}.g2{border-color:#65a30d}.g1{border-color:#ca8a04}.g0{border-color:#a1a1aa}.new{border-style:dashed;border-color:#3b82f6}
.bar{display:flex;gap:3px;margin-top:4px}.bar button{flex:1;padding:4px;border:1px solid #d4d4d8;background:#fafafa;border-radius:4px;cursor:pointer}
.bar .on{background:#18181b;color:#fff}.diff{font-size:12px;margin-top:4px;color:#b91c1c;min-height:16px}
button.primary{padding:8px 14px;background:#18181b;color:#fff;border:0;border-radius:6px;cursor:pointer}
</style>
<header><b>Prism 检索标注</b><span id=stat></span><p>""" + hint + """</p>
<span class=keys>点击卡片后按 0–3 打分，自动跳到下一张；进度自动保存在本浏览器</span>
<button class=primary onclick=save()>导出复核结果</button></header><main id=main></main>
<script>
const D=""" + payload + """;
const audit=D.mode==='audit', grades={}, cards=[], store='prism-review:'+D.mode+':'+D.created;
for(const q of D.queries){grades[q.id]={};for(const it of D.items[q.id]||[]) if(!audit&&it.draft!=null) grades[q.id][it.key]=it.draft}
// Progress survives reloads; a regenerated page has a new `created` and starts fresh.
try{const saved=JSON.parse(localStorage.getItem(store)||'{}');for(const q in saved) if(grades[q]) Object.assign(grades[q],saved[q])}catch{}
function paint(c){const g=grades[c.q][c.it.key];c.el.className='card'+(g==null?(audit?'':' new'):' g'+g);
 c.el.querySelectorAll('.bar button').forEach((b,v)=>b.classList.toggle('on',v===g));
 c.el.querySelector('.diff').textContent=audit&&g!=null&&c.it.draft!=null&&g!==c.it.draft?`初稿 ${c.it.draft} 分`:''}
function set(c,v){grades[c.q][c.it.key]=v;paint(c);stat();try{localStorage.setItem(store,JSON.stringify(grades))}catch{}const n=cards[cards.indexOf(c)+1];if(n)n.el.focus()}
function render(){const m=document.getElementById('main');for(const q of D.queries){const list=D.items[q.id]||[];if(!list.length)continue;
 const s=document.createElement('section');s.innerHTML=`<h2>${q.id} · ${q.text} <small>${q.intent} / ${q.lang} / ${q.style} · ${list.length} 张</small></h2>`;
 const g=document.createElement('div');g.className='grid';
 for(const it of list){const el=document.createElement('div');el.tabIndex=0;
  el.innerHTML=`<img loading=lazy alt="" src="${it.thumb}"><small>${it.key}</small><div class=bar>${[0,1,2,3].map(v=>`<button>${v}</button>`).join('')}</div><div class=diff></div>`;
  const c={q:q.id,it,el};cards.push(c);el.querySelectorAll('.bar button').forEach((b,v)=>b.onclick=()=>set(c,v));
  el.onkeydown=e=>{if('0123'.includes(e.key)&&e.key.length===1){e.preventDefault();set(c,+e.key)}};paint(c);g.append(el)}
 s.append(g);m.append(s)}}
function stat(){const done=cards.filter(c=>grades[c.q][c.it.key]!=null).length;const diff=cards.filter(c=>{const g=grades[c.q][c.it.key];return g!=null&&c.it.draft!=null&&g!==c.it.draft}).length;
 document.getElementById('stat').textContent=`已打分 ${done} / ${cards.length}`+(audit?` · 与初稿不同 ${diff}`:'')}
function save(){const out={mode:D.mode,created:D.created,reviewed:new Date().toISOString(),grades:{}};
 for(const c of cards){const g=grades[c.q][c.it.key];if(g!=null)(out.grades[c.q]??={})[c.it.key]=g}
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)+'\\n'],{type:'application/json'}));a.download='prism-review.json';a.click()}
render();stat();if(cards[0])cards[0].el.focus();
</script>""", total


def merge(document, review, path):
    """Apply reviewed grades. Audit mode also reports agreement against the draft before it is overwritten."""
    by_id = {q["id"]: q for q in document["queries"]}
    drafts, reviewed, changes = [], [], []
    for qid, grades in review["grades"].items():
        if qid not in by_id:
            raise SystemExit(f"复核文件包含未知查询 {qid}，请确认它来自当前 queries.json")
        judgments = by_id[qid]["judgments"]
        for key, grade in grades.items():
            if grade not in (0, 1, 2, 3):
                raise SystemExit(f"{qid} {key} 的分数无效：{grade}")
            if key in judgments:
                drafts.append(judgments[key])
                reviewed.append(grade)
            if judgments.get(key) != grade:
                changes.append({"query": qid, "text": by_id[qid]["text"], "key": key, "from": judgments.get(key), "to": grade})
            judgments[key] = grade
        by_id[qid]["judgments"] = dict(sorted(judgments.items(), key=lambda kv: (-kv[1], kv[0])))
    matrix = confusion(drafts, reviewed)
    audits = document.setdefault("audits", [])
    audits.append({"mode": review["mode"], "reviewed": review.get("reviewed"), "items": len(reviewed),
                   "changed": len(changes), "confusion": matrix})
    path.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n")
    return {"agreement": agreement(matrix), "changes": changes}


def audit_summary(document):
    """Pooled agreement over every audit recorded in queries.json."""
    audits = [a for a in document.get("audits", []) if a["mode"] == "audit"]
    if not audits:
        return None
    matrix = [[sum(a["confusion"][i][j] for a in audits) for j in range(4)] for i in range(4)]
    return {"audits": len(audits), **agreement(matrix)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["score", "review", "pool", "merge"])
    parser.add_argument("review_file", nargs="?", type=Path, help="merge：review.html 导出的 prism-review.json")
    parser.add_argument("--database", type=Path, default=LIBRARY / "catalog.sqlite3")
    parser.add_argument("--queries", type=Path, default=Path(__file__).with_name("queries.json"))
    parser.add_argument("--output", type=Path, default=ROOT / "verification-eval")
    parser.add_argument("--per-query", type=int, default=2, help="review：每条查询抽样的标注数")
    parser.add_argument("--seed", type=int, default=None, help="review：抽样随机种子，默认按已完成的复核轮数递增")
    parser.add_argument("--pool-depth", type=int, default=10, help="pool：每种策略取前 N 个结果")
    parser.add_argument("--only", nargs="+", default=(), metavar="PREFIX",
                        help="只在这些相对路径前缀下检索，例如 datasets/；没有可检索目标的查询自动跳过")
    args = parser.parse_args()
    document = json.loads(args.queries.read_text())
    if args.command == "merge":
        if not args.review_file:
            parser.error("merge 需要 review.html 导出的 JSON 文件路径")
        result = merge(document, json.loads(args.review_file.read_text()), args.queries)
        print(json.dumps({**result, "pooled": audit_summary(document)}, ensure_ascii=False, indent=1))
        return
    queries = document["queries"]
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="prism-eval-") as temp:
        catalog = open_snapshot(args.database, temp)
        assets = scope(catalog, args.only)
        keys = {a["key"] for a in assets.values()}
        queries = [q for q in queries if any(k in keys and g for k, g in q["judgments"].items())]
        if args.command == "review":
            seed = args.seed if args.seed is not None else len(document.get("audits", []))
            items = audit_sample(queries, args.per_query, seed)
            items = {qid: [k for k in ks if k in keys] for qid, ks in items.items()}
            page, total = review_page(queries, items, assets, args.database.parent, "audit")
            (args.output / "review.html").write_text(page)
            print(json.dumps({"review_page": str(args.output / "review.html"), "items": total, "seed": seed}, ensure_ascii=False))
            catalog.db.close()
            return
        runs = run_queries(catalog, queries, assets)
        catalog.db.close()
    if args.command == "pool":
        items = {}
        for run in runs:
            pooled = [assets[hit["ids"][0]]["key"] for strategy in STRATEGIES
                      for hit in run["results"][strategy]["hits"][:args.pool_depth]]
            judged = [k for k, g in run["query"]["judgments"].items() if g and k in keys]
            items[run["query"]["id"]] = list(dict.fromkeys(judged + pooled))
        page, total = review_page(queries, items, assets, args.database.parent, "full")
        (args.output / "review.html").write_text(page)
        unjudged = sum(k not in q["judgments"] for q in queries for k in items[q["id"]])
        print(json.dumps({"review_page": str(args.output / "review.html"), "items": total,
                          "unjudged_candidates": unjudged}, ensure_ascii=False))
        return
    report = {"created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "profile": PROFILE, "depth": DEPTH, "queries": len(queries),
              "judgments": sum(1 for q in queries for g in q["judgments"].values() if g),
              "scope": {"assets": len(assets), "groups": len({a["group"] for a in assets.values()}),
                        "only": list(args.only)},
              "audit": audit_summary(document), **score(runs)}
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n")
    (args.output / "report.md").write_text(markdown(report))
    print(json.dumps({"output": str(args.output), **{s: {m: round(v, 3) for m, v in report["overall"][s].items()}
                                                     for s in STRATEGIES}}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
