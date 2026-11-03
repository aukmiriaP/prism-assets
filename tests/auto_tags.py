"""Suggested tags against a real temporary catalog. Controlled vectors; no model, Blender or library."""
import concurrent.futures
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from auto_tags import DEFAULT_VOCABULARY, color_name, dominant_colors, normalize_vocabulary
from catalog import Catalog

AXES = {"environment concept art": 0, "game prop": 1, "material texture sphere": 2}


class Inference:
    """Text prompts map to fixed axes; anything else lands on an unused axis."""
    status, error = "ready", None

    def __init__(self):
        self.texts = []

    def submit(self, kind, value, priority=0):
        self.texts.append(value)
        vector = np.zeros(8, dtype=np.float32)
        vector[AXES.get(value, 7)] = 1
        future = concurrent.futures.Future()
        future.set_result(vector)
        return future


def unit(*values):
    vector = np.array(values + (0,) * (8 - len(values)), dtype=np.float32)
    return vector / np.linalg.norm(vector)


VOCABULARY = [
    {"id": "category", "name": "类别", "kind": "prompt", "enabled": True, "threshold": 0.6, "labels": [
        {"label": "场景", "prompt": "environment concept art"},
        {"label": "道具", "prompt": "game prop"},
        {"label": "材质", "prompt": "material texture sphere"}]},
    {"id": "color", "name": "主色", "kind": "color", "enabled": True, "threshold": 0.3, "labels": []},
]


class AutoTags(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prism-autotags-")
        self.root = Path(self.temp.name)
        self.inference = Inference()
        self.catalog = Catalog(self.root / "library", inference=self.inference, watch=False)
        self.catalog.save_tag_vocabulary(VOCABULARY)

    def tearDown(self):
        self.catalog.close()
        self.catalog.worker.join(3)
        self.catalog.db.close()
        self.temp.cleanup()

    def add(self, aid, vector, color=(128, 128, 128), tags=(), status="ready"):
        thumbnail = f"{aid}.webp"
        Image.new("RGB", (32, 32), color).save(self.catalog.thumbs / thumbnail)
        self.catalog.execute("""INSERT INTO assets(id,path,name,ext,size,mtime,hash,thumbnail,vector,tags,status,added,updated)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (aid, str(self.root / f"{aid}.png"), f"{aid}.png", "png", 1, 1, aid,
            thumbnail, None if vector is None else vector.tobytes(), json.dumps(list(tags), ensure_ascii=False),
            status, time.time(), time.time()))
        return aid

    def labels(self, aid):
        return {s["label"]: s for s in self.catalog.suggest_tags([aid])[aid]}

    def test_zero_shot_suggestion_threshold_and_prompt_cache(self):
        clear = self.add("clear", unit(1, 0.1, 0.1), color=(200, 30, 30))
        unsure = self.add("unsure", unit(1, 1, 0.98))
        result = self.labels(clear)
        self.assertEqual(result["场景"]["source"], "prompt")
        self.assertGreater(result["场景"]["score"], 0.99)
        self.assertEqual(result["红色"]["source"], "color")
        # Near-equal cosine to two labels stays under the 0.6 share threshold.
        self.assertNotIn("场景", self.labels(unsure))
        self.assertNotIn("道具", self.labels(unsure))
        encoded = len(self.inference.texts)
        self.catalog.suggest_tags([clear, unsure])
        self.assertEqual(len(self.inference.texts), encoded, "prompt vectors are cached in SQLite")

    def test_existing_choice_or_dismissal_suppresses_suggestions(self):
        tagged = self.add("tagged", unit(1, 0, 0), tags=["道具"])
        self.assertNotIn("场景", self.labels(tagged), "the user already picked a label in this group")
        plain = self.add("plain", unit(1, 0, 0), color=(30, 30, 200))
        self.catalog.dismiss_tag([plain], "场景")
        self.catalog.dismiss_tag([plain], "蓝色")
        self.assertEqual(self.labels(plain), {})
        with self.assertRaises(ValueError):
            self.catalog.dismiss_tag([], "场景")

    def test_examples_teach_a_label_the_prompt_misses(self):
        # These assets resemble the prop prompt, but the user calls them 材质.
        for n in range(3):
            self.add(f"example-{n}", unit(0.2, 1, 0, 0, 1), tags=["材质"])
        target = self.add("target", unit(0.2, 1, 0, 0, 1.1))
        result = self.labels(target)
        self.assertEqual(result["材质"]["source"], "prompt+examples")
        self.assertNotIn("道具", result)
        # Leave-one-out: an example asset does not vote for itself, so two remaining examples are too few.
        self.catalog.update_asset("example-0", {"tags": []})
        self.assertEqual(self.labels("example-1").get("材质", {}).get("source"), None)

    def test_assets_without_vectors_only_get_colours(self):
        pending = self.add("pending", None, color=(240, 200, 20), status="pending")
        self.assertEqual({s["source"] for s in self.catalog.suggest_tags([pending])[pending]}, {"color"})
        self.assertEqual(self.inference.texts, [], "no prompt encoding needed without vectors")

    def test_vocabulary_validation_and_reset(self):
        with self.assertRaises(ValueError):
            normalize_vocabulary([{**VOCABULARY[0], "labels": VOCABULARY[0]["labels"][:1]}])
        with self.assertRaises(ValueError):
            normalize_vocabulary([VOCABULARY[0], {**VOCABULARY[0], "id": "copy"}])
        with self.assertRaises(ValueError):
            normalize_vocabulary([{**VOCABULARY[0], "threshold": 1.5}])
        saved = normalize_vocabulary([VOCABULARY[1]])
        self.assertEqual(len(saved[0]["labels"]), 12, "colour labels are fixed")
        self.assertEqual(self.catalog.reset_tag_vocabulary(), DEFAULT_VOCABULARY)
        self.assertEqual(normalize_vocabulary(DEFAULT_VOCABULARY), DEFAULT_VOCABULARY)

    def test_colour_names_and_neutral_handling(self):
        self.assertEqual(color_name(0, 0.9, 0.9), "红色")
        self.assertEqual(color_name(0.6, 0.8, 0.8), "蓝色")
        self.assertEqual(color_name(0.08, 0.8, 0.4), "棕色")
        self.assertEqual(color_name(0, 0, 0.1), "黑色")
        self.assertEqual(color_name(0, 0.05, 0.95), "白色")
        self.assertEqual(color_name(0.9, 0.5, 0.9), "粉色")
        # Grey backdrop with a 20 % blue subject: report blue, not grey.
        self.assertEqual(dominant_colors({"灰色": 0.8, "蓝色": 0.2}, 0.3), [("蓝色", 1.0)])
        self.assertEqual(dominant_colors({"灰色": 0.9, "蓝色": 0.1}, 0.3), [("灰色", 0.9)])


if __name__ == "__main__":
    unittest.main()
