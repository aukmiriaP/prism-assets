"""PBR interpretation tests using temporary files; no embedding or Blender."""
import copy
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from material_assets import inspect_material, material_stamp, normalize_material, prepare_material


class Materials(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prism-pbr-unit-")
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "Material"
        self.source.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def image(self, filename, value=(32, 64, 128), mode="RGB"):
        path = self.source / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new(mode, (16, 16), value).save(path)
        return path

    def test_named_maps_and_unambiguous_convention(self):
        self.image("Wood_BaseColor.png")
        self.image("Wood_nor_dx_1k.png")
        self.image("Wood_Smoothness.png", 40, "L")
        result = inspect_material(str(self.source))
        config = normalize_material(result["config"])
        self.assertEqual(config["maps"]["base_color"]["file"], "Wood_BaseColor.png")
        self.assertTrue(config["maps"]["roughness"]["invert"])
        self.assertEqual(config["normal_format"], "directx")
        self.assertEqual((config["roughness"], config["metallic"]), (1, 0))
        self.assertEqual(len(result["files"]), 3)

    def test_ambiguous_sets_are_not_silently_combined(self):
        self.image("Wood_BaseColor.png")
        self.image("Metal_BaseColor.png")
        self.image("Wood_Normal.png")
        result = inspect_material(str(self.source))
        self.assertNotIn("base_color", result["config"]["maps"])
        self.assertTrue(any("base_color 有多个候选" in warning for warning in result["warnings"]))
        self.assertTrue(any("法线方向默认" in warning for warning in result["warnings"]))

    def test_role_words_in_material_name_do_not_override_suffix(self):
        for suffix in ("diff", "rough", "nor_gl", "metal", "ao"):
            self.image(f"rusty_metal_04_{suffix}_1k.png")
        config = inspect_material(str(self.source))["config"]
        self.assertEqual(config["maps"]["metallic"]["file"], "rusty_metal_04_metal_1k.png")
        self.assertEqual(len(config["maps"]), 5)

    def test_orm_and_rma_mapping_and_gray_cache_channels(self):
        for packing, expected in [("ORM", {"ao": 20, "roughness": 80, "metallic": 200}),
                                  ("RMA", {"roughness": 20, "metallic": 80, "ao": 200})]:
            folder = self.source / packing
            folder.mkdir()
            Image.new("RGB", (16, 16), (20, 80, 200)).save(folder / f"Stone_{packing}.png")
            inspected = inspect_material(str(folder))
            prepared = prepare_material(inspected["config"], self.root / f"cache-{packing}")
            for role, value in expected.items():
                image = Image.open(self.root / f"cache-{packing}" / prepared["maps"][role]["cache_file"])
                self.assertEqual(image.getpixel((0, 0)), (value, value, value))
                self.assertEqual(prepared["maps"][role]["color_space"], "linear")
                image.close()

    def test_dx_normal_and_smoothness_are_converted_once_without_source_changes(self):
        paths = [self.image("Metal_nor_dx.png", (90, 40, 240)), self.image("Metal_gloss.png", 37, "L"),
                 self.image("Metal_diff.png", (20, 100, 160))]
        before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
        config = inspect_material(str(self.source))["config"]
        metadata = prepare_material(config, self.root / "cache")
        with Image.open(self.root / "cache/normal.png") as normal:
            self.assertEqual(normal.getpixel((0, 0)), (90, 215, 240))
        with Image.open(self.root / "cache/roughness.png") as roughness:
            self.assertEqual(roughness.getpixel((0, 0)), (218, 218, 218))
        self.assertEqual(metadata["maps"]["base_color"]["color_space"], "srgb")
        self.assertEqual({path: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}, before)

    def test_invalid_channels_numeric_ranges_and_alpha(self):
        self.image("Wood_diff.png")
        config = inspect_material(str(self.source))["config"]
        for changes in [{"normal_format": "unknown"}, {"color": "red"}, {"roughness": 2},
                        {"metallic": float("nan")}, {"repeat": 0}, {"normal_strength": True},
                        {"maps": {}}, {"maps": {"unknown": {"file": "Wood_diff.png"}}},
                        {"maps": {"normal": {"file": "Wood_diff.png", "channel": "r"}}},
                        {"maps": {"opacity": {"file": "Wood_diff.png", "channel": "a"}}}]:
            with self.assertRaises(ValueError, msg=str(changes)):
                normalize_material({**config, **changes})
        self.image("Opacity.png", (10, 20, 30, 74), "RGBA")
        config["maps"]["opacity"] = {"file": "Opacity.png", "channel": "a"}
        prepared = prepare_material(config, self.root / "alpha")
        with Image.open(self.root / "alpha/opacity.png") as image:
            self.assertEqual(image.getpixel((0, 0)), (74, 74, 74))

    def test_traversal_hidden_symlinks_and_unsupported_data(self):
        self.image("Wood_diff.png")
        self.image(".hidden.png")
        self.image("sixteen.png", 300, "I;16")
        (self.source / "linked.png").symlink_to(self.source / "Wood_diff.png")
        (self.source / "linked").symlink_to(self.source, target_is_directory=True)
        config = inspect_material(str(self.source))["config"]
        for filename in ["../Wood_diff.png", str(self.source / "Wood_diff.png"), ".hidden.png",
                         "linked.png", "linked/Wood_diff.png", "sixteen.png", "x\0y"]:
            invalid = copy.deepcopy(config)
            invalid["maps"] = {"base_color": {"file": filename}}
            with self.assertRaises((ValueError, FileNotFoundError), msg=filename):
                normalize_material(invalid)
        self.assertTrue(any("8 位贴图" in warning for warning in inspect_material(str(self.source))["warnings"]))
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            inspect_material(str(alias))

    def test_dependency_changes_and_missing_restore(self):
        path = self.image("Wood_diff.png")
        config = normalize_material(inspect_material(str(self.source))["config"])
        first = material_stamp(config)
        stat = path.stat()
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10_000))
        second = material_stamp(config)
        self.assertNotEqual(first, second)
        path.rename(self.source / "gone.png")
        missing = material_stamp(config)
        self.assertNotEqual(second, missing)
        (self.source / "gone.png").rename(path)
        self.assertEqual(material_stamp(config), second)
        changed = {**config, "normal_strength": 2}
        self.assertNotEqual(material_stamp(changed), second)

    def test_scan_limit_also_counts_broken_images(self):
        for index in range(257):
            (self.source / f"broken-{index:03d}.png").write_bytes(b"not an image")
        with self.assertRaisesRegex(ValueError, "256"):
            inspect_material(str(self.source))

    def test_public_samples_have_real_readable_pbr_channels(self):
        samples = Path(__file__).resolve().parents[2] / "prism-material-samples"
        available = [samples / name for name in ("wood_planks", "rusty_metal_04")
                     if (samples / name / "SOURCE.json").is_file()]
        if not available:
            self.skipTest("Public samples are optional local inputs")
        for source in available:
            inspection = inspect_material(str(source))
            self.assertTrue({"base_color", "normal", "roughness"}.issubset(inspection["config"]["maps"]))
            config = normalize_material(inspection["config"])
            prepared = prepare_material(config, self.root / source.name)
            self.assertTrue(all(item["width"] == 1024 and item["height"] == 1024
                                for item in prepared["maps"].values()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
