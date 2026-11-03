"""Local suggested tags: zero-shot prompts, learned examples and pixel colours. Nothing is written to
`assets.tags` until the user accepts a suggestion; dismissed suggestions are remembered per asset.

Scores are softmax shares within one group of mutually exclusive labels. They rank labels for
one asset and are thresholded, but they are not calibrated probabilities.
"""
import json
import threading
import time

import numpy as np
from PIL import Image

TEMPERATURE = 100      # Cosine gaps between labels are ~0.01–0.05; this spreads them before softmax.
MIN_EXAMPLES = 3       # Fewer tagged examples than this give an unstable prototype.
PROMPT_WEIGHT = 0.5    # Blend of text prompt and visual prototype once examples exist.
SUGGEST_LIMIT = 1000

DEFAULT_VOCABULARY = [
    {"id": "category", "name": "类别", "kind": "prompt", "enabled": True, "threshold": 0.6, "labels": [
        {"label": "场景", "prompt": "environment concept art"},
        {"label": "道具", "prompt": "game prop"},
        {"label": "材质", "prompt": "material texture sphere"},
        {"label": "UI", "prompt": "game UI interface"},
        {"label": "图标", "prompt": "app icon"},
        {"label": "角色立绘", "prompt": "anime character illustration"},
        {"label": "3D角色", "prompt": "3D character model render"},
        {"label": "软件截图", "prompt": "screenshot of a desktop software application"},
    ]},
    {"id": "style", "name": "画风", "kind": "prompt", "enabled": False, "threshold": 0.6, "labels": [
        {"label": "写实", "prompt": "photorealistic rendering"},
        {"label": "二次元", "prompt": "anime style illustration"},
        {"label": "风格化", "prompt": "stylized cartoon game art"},
        {"label": "像素风", "prompt": "pixel art"},
    ]},
    {"id": "lighting", "name": "光照", "kind": "prompt", "enabled": False, "threshold": 0.6, "labels": [
        {"label": "白天", "prompt": "a scene in bright daylight"},
        {"label": "夜晚", "prompt": "a scene at night"},
        {"label": "黄昏", "prompt": "a scene at sunset with warm light"},
    ]},
    {"id": "color", "name": "主色", "kind": "color", "enabled": True, "threshold": 0.3, "labels": [
        {"label": label, "prompt": ""} for label in
        ("红色", "橙色", "黄色", "绿色", "青色", "蓝色", "紫色", "粉色", "棕色", "黑色", "白色", "灰色")]},
]


def color_name(h, s, v):
    """HSV in 0–1 → one of the colour labels. Brown is a dark red/orange; pink a light magenta."""
    if v < 0.2:
        return "黑色"
    if s < 0.15:
        return "白色" if v > 0.85 else "灰色"
    hue = h * 360
    if hue < 15 or hue >= 345:
        return "棕色" if v < 0.55 else "粉色" if s < 0.45 and v > 0.8 else "红色"
    if hue < 40:
        return "棕色" if v < 0.6 else "橙色"
    if hue < 70:
        return "黄色"
    if hue < 165:
        return "绿色"
    if hue < 195:
        return "青色"
    if hue < 255:
        return "蓝色"
    if hue < 290:
        return "紫色"
    return "粉色"


def color_shares(path, ignore_background=False):
    """Fraction of pixels per colour label, from a small copy of the thumbnail."""
    with Image.open(path) as image:
        image = image.convert("RGBA")
        image.thumbnail((64, 64))
    rgba = np.asarray(image).reshape(-1, 4)
    pixels = rgba[rgba[:, 3] > 128, :3]
    if ignore_background and len(pixels):
        # Model and material covers are rendered on a flat backdrop; drop pixels matching its corners.
        corners = np.asarray(image)[[0, 0, -1, -1], [0, -1, 0, -1], :3].astype(int)
        backdrop = np.median(corners, axis=0)
        pixels = pixels[np.abs(pixels.astype(int) - backdrop).sum(axis=1) > 24]
    if not len(pixels):
        return {}
    hsv = np.asarray(Image.fromarray(pixels.reshape(1, -1, 3).astype(np.uint8)).convert("HSV")).reshape(-1, 3) / 255
    counts = {}
    for h, s, v in hsv:
        name = color_name(h, s, v)
        counts[name] = counts.get(name, 0) + 1
    return {name: n / len(hsv) for name, n in counts.items()}


NEUTRALS = {"黑色", "白色", "灰色"}


def dominant_colors(shares, threshold, limit=2):
    """Chromatic colours win when they cover enough of the image; neutrals only describe
    images that are mostly neutral (backdrops and shading otherwise always come first)."""
    chromatic = sum(v for k, v in shares.items() if k not in NEUTRALS)
    pool = {k: v / chromatic for k, v in shares.items() if k not in NEUTRALS} if chromatic >= 0.15 else shares
    ranked = sorted(pool.items(), key=lambda kv: (-kv[1], kv[0]))
    return [(name, share) for name, share in ranked[:limit] if share >= threshold]


def normalize_vocabulary(groups):
    if not isinstance(groups, list) or not 1 <= len(groups) <= 20:
        raise ValueError("词表需要 1–20 个分组")
    seen_ids, seen_labels, result = set(), set(), []
    for group in groups:
        gid = str(group.get("id", "")).strip()
        name = str(group.get("name", "")).strip()
        kind = group.get("kind", "prompt")
        if not gid or gid in seen_ids or not 1 <= len(name) <= 32:
            raise ValueError("每个分组需要唯一 ID 和 1–32 字的名称")
        if kind not in ("prompt", "color"):
            raise ValueError(f"分组「{name}」的类型无效")
        threshold = float(group.get("threshold", 0.6 if kind == "prompt" else 0.3))
        if not 0.05 <= threshold <= 0.95:
            raise ValueError(f"分组「{name}」的阈值需在 0.05–0.95 之间")
        labels = []
        for item in group.get("labels", []):
            label, prompt = str(item.get("label", "")).strip(), str(item.get("prompt", "")).strip()
            if not 1 <= len(label) <= 64 or len(prompt) > 300:
                raise ValueError("标签名需 1–64 字，英文描述不超过 300 字")
            if label in seen_labels:
                raise ValueError(f"标签「{label}」在词表中重复")
            seen_labels.add(label)
            labels.append({"label": label, "prompt": prompt})
        if kind == "color":
            # Colour names are computed from pixels; the list itself is not editable.
            labels = next(g["labels"] for g in DEFAULT_VOCABULARY if g["kind"] == "color")
        elif not 2 <= len(labels) <= 40:
            raise ValueError(f"分组「{name}」需要 2–40 个标签，组内标签会相互比较")
        seen_ids.add(gid)
        result.append({"id": gid, "name": name, "kind": kind, "enabled": bool(group.get("enabled", True)),
                       "threshold": threshold, "labels": labels})
    return result


def softmax(scores):
    z = np.asarray(scores, dtype=np.float64) * TEMPERATURE
    z -= z.max()
    p = np.exp(z)
    return p / p.sum()


class AutoTagCatalog:
    def init_auto_tags(self):
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS tag_prompt_vectors(
                prompt TEXT NOT NULL,profile TEXT NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(prompt,profile));
            CREATE TABLE IF NOT EXISTS tag_dismissals(
                asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,label TEXT NOT NULL,created REAL,
                PRIMARY KEY(asset_id,label));
        """)
        self.autotag_lock = threading.Lock()

    def tag_vocabulary(self):
        row = self.rows("SELECT value FROM meta WHERE key='autotag_vocabulary'")
        return json.loads(row[0]["value"]) if row else json.loads(json.dumps(DEFAULT_VOCABULARY))

    def save_tag_vocabulary(self, groups):
        groups = normalize_vocabulary(groups)
        self.execute("INSERT OR REPLACE INTO meta VALUES('autotag_vocabulary',?)", (json.dumps(groups, ensure_ascii=False),))
        return groups

    def reset_tag_vocabulary(self):
        self.execute("DELETE FROM meta WHERE key='autotag_vocabulary'")
        return self.tag_vocabulary()

    def prompt_vectors(self, prompts):
        """Text vectors for prompts, cached per embedding profile so model changes invalidate them."""
        from catalog import PROFILE
        prompts = sorted(set(p for p in prompts if p))
        cached = {r["prompt"]: np.frombuffer(r["vector"], dtype=np.float32) for r in self.rows(
            "SELECT prompt,vector FROM tag_prompt_vectors WHERE profile=? AND prompt IN (" +
            ",".join("?" for _ in prompts) + ")", (PROFILE, *prompts))} if prompts else {}
        missing = [p for p in prompts if p not in cached]
        if missing:
            with self.autotag_lock:
                futures = {p: self.inference.submit("text", p) for p in missing}
                for prompt, future in futures.items():
                    vector = future.result(timeout=300).astype(np.float32)
                    cached[prompt] = vector
                    self.execute("INSERT OR REPLACE INTO tag_prompt_vectors VALUES(?,?,?)", (prompt, PROFILE, vector.tobytes()))
        return cached

    def label_examples(self, labels):
        """Mean image vector of assets the user already tagged with each label."""
        examples = {}
        for label in labels:
            rows = self.rows("""SELECT a.id,a.vector FROM assets a WHERE a.status='ready' AND a.vector IS NOT NULL
                AND a.excluded=0 AND a.archived=0 AND EXISTS(SELECT 1 FROM json_each(a.tags) WHERE value=?)""", (label,))
            if len(rows) >= MIN_EXAMPLES:
                examples[label] = ([r["id"] for r in rows],
                                   np.stack([np.frombuffer(r["vector"], dtype=np.float32) for r in rows]))
        return examples

    def suggest_tags(self, ids, groups=None):
        """{asset_id: [suggestion]} for up to SUGGEST_LIMIT assets. Assets without vectors only get colours."""
        ids = list(dict.fromkeys(self.resolve_asset_id(aid) for aid in ids))[:SUGGEST_LIMIT]
        if not ids:
            return {}
        groups = [g for g in (groups or self.tag_vocabulary()) if g["enabled"]]
        rows = self.rows("SELECT id,kind,tags,vector,thumbnail,status FROM assets WHERE id IN (" +
                         ",".join("?" for _ in ids) + ")", ids)
        dismissed = {}
        for row in self.rows("SELECT asset_id,label FROM tag_dismissals WHERE asset_id IN (" +
                             ",".join("?" for _ in ids) + ")", ids):
            dismissed.setdefault(row["asset_id"], set()).add(row["label"])
        prompt_groups = [g for g in groups if g["kind"] == "prompt"]
        labels = [l for g in prompt_groups for l in g["labels"]]
        has_vectors = any(r["vector"] for r in rows)
        texts = self.prompt_vectors([l["prompt"] for l in labels]) if has_vectors else {}
        examples = self.label_examples([l["label"] for l in labels]) if has_vectors else {}
        result = {}
        for row in rows:
            own = set(json.loads(row["tags"]))
            skip = own | dismissed.get(row["id"], set())
            out = []
            vector = np.frombuffer(row["vector"], dtype=np.float32) if row["vector"] and row["status"] == "ready" else None
            for group in prompt_groups:
                if vector is None or own & {l["label"] for l in group["labels"]}:
                    continue  # The user already chose a label in this group.
                usable, sources = [], []
                for item in group["labels"]:
                    prototype, source = self.label_prototype(item, texts, examples, row["id"])
                    if prototype is not None:
                        usable.append((item["label"], prototype)); sources.append(source)
                if len(usable) < 2:
                    continue
                shares = softmax([float(p @ vector) for _, p in usable])
                best = int(np.argmax(shares))
                label = usable[best][0]
                if shares[best] >= group["threshold"] and label not in skip:
                    out.append({"label": label, "group": group["name"], "score": round(float(shares[best]), 3),
                                "source": sources[best]})
            for group in (g for g in groups if g["kind"] == "color"):
                if not row["thumbnail"]:
                    continue
                path = self.thumbs / row["thumbnail"]
                if not path.is_file():
                    continue
                shares = color_shares(path, ignore_background=row["kind"] in ("model", "material"))
                out.extend({"label": name, "group": group["name"], "score": round(share, 3), "source": "color"}
                           for name, share in dominant_colors(shares, group["threshold"]) if name not in skip)
            result[row["id"]] = out
        return result

    @staticmethod
    def label_prototype(item, texts, examples, asset_id):
        text = texts.get(item["prompt"])
        found = examples.get(item["label"])
        visual = None
        if found:
            members, vectors = found
            # Leave the asset itself out so its own vector cannot vote for it.
            keep = vectors[[aid != asset_id for aid in members]]
            if len(keep) >= MIN_EXAMPLES:
                visual = keep.mean(axis=0)
                visual /= max(float(np.linalg.norm(visual)), 1e-8)
        if text is not None and visual is not None:
            blended = PROMPT_WEIGHT * text + (1 - PROMPT_WEIGHT) * visual
            return blended / max(float(np.linalg.norm(blended)), 1e-8), "prompt+examples"
        if visual is not None:
            return visual, "examples"
        if text is not None:
            return text, "prompt"
        return None, None

    def dismiss_tag(self, ids, label):
        ids = list(dict.fromkeys(self.resolve_asset_id(aid) for aid in ids))
        if not ids or len(ids) > 5000 or not 1 <= len(label.strip()) <= 64:
            raise ValueError("请选择 1–5000 个文件和一个标签")
        with self.lock, self.db:
            self.db.executemany("INSERT OR IGNORE INTO tag_dismissals VALUES(?,?,?)",
                                [(aid, label.strip(), time.time()) for aid in ids])
        return {"dismissed": len(ids)}
