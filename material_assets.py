"""PBR texture-set inspection and normalization. Source files are read-only."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys

from PIL import Image, ImageOps

ROLES = ("base_color", "normal", "roughness", "metallic", "ao", "emissive", "opacity")
COLOR_ROLES = {"base_color", "emissive"}
RGB_ROLES = COLOR_ROLES | {"normal"}
IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".tga"}
ALIASES = {
    "base_color": ("base_color", "basecolor", "albedo", "diffuse", "diff", "颜色", "基础色"),
    "normal": ("nor_gl", "nor_dx", "normal_gl", "normal_dx", "normal", "nrm", "法线"),
    "roughness": ("roughness", "rough", "smoothness", "smooth", "glossiness", "gloss", "粗糙度", "光滑度"),
    "metallic": ("metallic", "metalness", "metal", "金属度"),
    "ao": ("ambient_occlusion", "ambientocclusion", "occlusion", "ao", "环境遮蔽"),
    "emissive": ("emissive", "emission", "emit", "自发光"),
    "opacity": ("opacity", "alpha", "transparency", "透明度"),
}
PACKED = {"orm": {"ao": "r", "roughness": "g", "metallic": "b"},
          "arm": {"ao": "r", "roughness": "g", "metallic": "b"},
          "rma": {"roughness": "r", "metallic": "g", "ao": "b"},
          "metallicroughness": {"roughness": "g", "metallic": "b"},
          "metalrough": {"roughness": "g", "metallic": "b"}}


def source_directory(value):
    if not isinstance(value, str) or not value or "\0" in value:
        raise ValueError("请选择独立的材质贴图文件夹")
    selected = Path(value).expanduser()
    if selected.is_symlink():
        raise ValueError("请选择实际材质目录，不支持符号链接")
    path = selected.resolve(strict=True)
    if not path.is_dir():
        raise ValueError("材质包需要选择一个文件夹")
    return path


def texture_file(base, relative):
    if base.is_symlink():
        raise ValueError("材质目录已变为符号链接，请重新关联实际目录")
    if not isinstance(relative, str) or not relative or len(relative) > 1000 or "\0" in relative:
        raise ValueError("请选择材质包内的贴图")
    path = Path(relative)
    if path.is_absolute() or not path.parts or ".." in path.parts or any(p.startswith(".") for p in path.parts):
        raise ValueError("贴图必须位于当前材质目录内，不支持隐藏路径或 ..")
    target = base
    for part in path.parts:
        target /= part
        if target.is_symlink():
            raise ValueError("不支持符号链接贴图")
    if not target.resolve(strict=True).is_relative_to(base) or not target.is_file():
        raise ValueError("贴图必须位于当前材质目录内")
    if target.suffix.lower() not in IMAGE_TYPES:
        raise ValueError("首版支持 PNG、JPEG、WebP、TIFF、BMP、TGA 贴图")
    return target


def image_info(path):
    if path.stat().st_size > 100 * 1024**2:
        raise ValueError(f"{path.name} 超过 100 MB")
    try:
        with Image.open(path) as image:
            if image.width * image.height > 40_000_000:
                raise ValueError(f"{path.name} 超过 4000 万像素")
            if image.mode not in ("RGB", "RGBA", "L", "LA", "P"):
                raise ValueError(f"{path.name} 不是支持的 8 位贴图，请先转换为 RGB 或灰度 PNG")
            return {"width": image.width, "height": image.height, "format": image.format,
                    "alpha": "A" in image.getbands() or "transparency" in image.info}
    except (OSError, Image.DecompressionBombError) as exc:
        raise ValueError(f"{path.name} 无法读取，请检查图片是否损坏") from exc


def words(name):
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "_", Path(name).stem.casefold()).strip("_")


def has_word(name, word):
    return f"_{word}_" in f"_{name}_"


def inferred_role(name):
    # A material name can contain a role word ("rusty_metal_04_diff").
    # Prefer the rightmost explicit suffix, and longer aliases at the same position.
    value = f"_{words(name)}_"
    matches = [(value.rfind(f"_{alias}_"), len(alias), role)
               for role, aliases in ALIASES.items() for alias in aliases
               if f"_{alias}_" in value]
    if not matches:
        return None
    best = max(matches)
    if any(value.rfind(f"_{packed}_") > best[0] for packed in PACKED):
        return None
    return best[2]


def inspect_material(value):
    base = source_directory(value)
    files, warnings = [], []
    examined, directories = 0, 0
    for parent, dirs, names in os.walk(base, followlinks=False):
        directories += 1
        if directories > 2048:
            raise ValueError("当前包含过多子目录，请选择一个独立材质包")
        depth = len(Path(parent).relative_to(base).parts)
        dirs[:] = [d for d in dirs if not d.startswith(".") and not (Path(parent) / d).is_symlink()]
        if depth >= 8:
            if dirs:
                warnings.append("超过 8 层的子目录未读取，请选择一个独立材质包。")
            dirs[:] = []
        for name in sorted(names, key=str.casefold):
            path = Path(parent) / name
            if name.startswith(".") or path.suffix.lower() not in IMAGE_TYPES or path.is_symlink():
                continue
            examined += 1
            if examined > 256:
                raise ValueError("当前文件夹超过 256 张贴图，请选择一个独立材质包")
            relative = path.relative_to(base).as_posix()
            try:
                info = image_info(path)
                files.append({"file": relative, "name": name, **info})
            except ValueError as exc:
                warnings.append(str(exc))
    files.sort(key=lambda item: item["file"].casefold())
    if not files:
        raise ValueError("此文件夹没有可读取的 8 位贴图，请选择含 PNG/JPEG 等贴图的材质包")
    maps = {}
    for role, aliases in ALIASES.items():
        candidates = [item for item in files if inferred_role(item["name"]) == role]
        if len(candidates) == 1:
            item = candidates[0]
            maps[role] = {"file": item["file"], "channel": "rgb" if role in RGB_ROLES else "r",
                          "invert": role == "roughness" and any(has_word(words(item["name"]), word)
                              for word in ("smoothness", "smooth", "glossiness", "gloss", "光滑度"))}
        elif len(candidates) > 1:
            warnings.append(f"{role} 有多个候选，请手动指定贴图，避免混用不同材质或分辨率。")
    packed = [(item, channels) for item in files for word, channels in PACKED.items()
              if has_word(words(item["name"]), word)]
    if len(packed) == 1:
        item, channels = packed[0]
        for role, channel in channels.items():
            # Ambiguous separate maps still need an explicit human choice.
            if role not in maps and not any(w.startswith(f"{role} 有多个候选") for w in warnings):
                maps[role] = {"file": item["file"], "channel": channel, "invert": False}
        warnings.append("已识别打包贴图，请核对 R/G/B 与实际制作约定是否一致。")
    elif len(packed) > 1:
        warnings.append("发现多个打包贴图，请手动选择文件及通道。")
    normal_name = words(maps.get("normal", {}).get("file", ""))
    convention = "directx" if any(has_word(normal_name, word) for word in ("nor_dx", "normal_dx")) else "opengl"
    if "normal" in maps and not any(has_word(normal_name, word) for word in ("nor_dx", "normal_dx", "nor_gl", "normal_gl")):
        warnings.append("法线方向默认 OpenGL；若来自 DirectX 工作流，请切换法线约定。")
    config = {"version": 1, "source_dir": str(base), "name": base.name, "maps": maps,
              "normal_format": convention, "color": "#ffffff",
              "roughness": 1 if "roughness" in maps else .6,
              "metallic": 1 if "metallic" in maps else 0,
              "normal_strength": 1, "emissive_strength": 1, "opacity": 1, "repeat": 1}
    return {"files": files, "config": config, "warnings": list(dict.fromkeys(warnings))}


def normalize_material(config):
    if not isinstance(config, dict):
        raise ValueError("材质配置无效")
    base = source_directory(config.get("source_dir"))
    name = str(config.get("name", "")).strip()
    if not name or len(name) > 128:
        raise ValueError("材质名称需要 1–128 个字符")
    supplied = config.get("maps", {})
    if not isinstance(supplied, dict) or not supplied or set(supplied) - set(ROLES):
        raise ValueError("请至少指定一张贴图，且只使用支持的 PBR 通道")
    maps = {}
    for role in ROLES:
        if role not in supplied:
            continue
        binding = supplied[role]
        if not isinstance(binding, dict):
            raise ValueError("贴图绑定无效")
        path = texture_file(base, binding.get("file"))
        info = image_info(path)
        channel = binding.get("channel", "rgb" if role in RGB_ROLES else "r")
        if channel not in ({"rgb"} if role in RGB_ROLES else {"r", "g", "b", "a"}):
            raise ValueError(f"{role} 的贴图通道无效")
        if channel == "a" and not info["alpha"]:
            raise ValueError(f"{path.name} 没有 Alpha 通道，请选择 R/G/B")
        invert = binding.get("invert", False)
        if not isinstance(invert, bool) or (role in RGB_ROLES and invert):
            raise ValueError("只支持标量贴图通道反相；法线请切换 OpenGL/DirectX")
        maps[role] = {"file": path.relative_to(base).as_posix(), "channel": channel, "invert": invert}
    convention = config.get("normal_format", "opengl")
    if convention not in ("opengl", "directx"):
        raise ValueError("法线约定需要选择 OpenGL 或 DirectX")
    color = config.get("color", "#ffffff")
    if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise ValueError("材质颜色需要六位十六进制颜色")
    result = {"version": 1, "source_dir": str(base), "name": name, "maps": maps,
              "normal_format": convention, "color": color.lower()}
    for key, default, low, high in [("roughness", 1 if "roughness" in maps else .6, 0, 1),
                                   ("metallic", 1 if "metallic" in maps else 0, 0, 1),
                                   ("normal_strength", 1, 0, 4), ("emissive_strength", 1, 0, 10),
                                   ("opacity", 1, 0, 1), ("repeat", 1, .25, 16)]:
        value = config.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"{key} 必须在 {low}–{high} 之间")
        result[key] = float(value)
    return result


def material_stamp(config):
    """Includes missing/replaced paths, so restoration triggers a new scan."""
    base = Path(config["source_dir"])
    dependencies = []
    for relative in sorted({binding["file"] for binding in config["maps"].values()}):
        try:
            path = texture_file(base, relative)
            stat = path.stat()
            value = [relative, stat.st_mtime_ns, stat.st_size]
        except (OSError, ValueError):
            value = [relative, "unavailable"]
        dependencies.append(value)
    payload = json.dumps([config, dependencies], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def prepare_material(config, output):
    config = normalize_material(config)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    base, maps = Path(config["source_dir"]), {}
    sizes = set()
    for role, binding in config["maps"].items():
        path = texture_file(base, binding["file"])
        try:
            with Image.open(path) as original:
                image = ImageOps.exif_transpose(original)
                image.load()
                sizes.add(image.size)
                image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
                if binding["channel"] == "rgb":
                    image = image.convert("RGB")
                    if role == "normal" and config["normal_format"] == "directx":
                        red, green, blue = image.split()
                        image = Image.merge("RGB", (red, ImageOps.invert(green), blue))
                else:
                    image = image.convert("RGBA").getchannel(binding["channel"].upper())
                    if binding["invert"]:
                        image = ImageOps.invert(image)
                    image = image.convert("RGB")
                filename = f"{role}.png"
                image.save(output / filename, "PNG")
                maps[role] = {**binding, "cache_file": filename, "width": image.width, "height": image.height,
                              "color_space": "srgb" if role in COLOR_ROLES else "linear"}
        except OSError as exc:
            raise ValueError(f"{path.name} 无法解码，请检查贴图是否损坏") from exc
    warnings = []
    if len(sizes) > 1:
        warnings.append("贴图尺寸不同；请检查是否属于同一套材质。")
    if "base_color" not in maps:
        warnings.append("未指定基础色贴图，将使用材质颜色。")
    if "ao" in maps:
        warnings.append("AO 用于标准预览的间接光；Blender 导出保留独立 AO 节点供引擎使用。")
    if config["opacity"] < 1 or "opacity" in maps:
        warnings.append("透明材质为标准混合预览，排序效果可能与目标引擎不同。")
    metadata = {"config": config, "maps": maps, "warnings": warnings,
                "dependency_stamp": material_stamp(config)}
    (output / "material.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
    return metadata


def render_material(output):
    from model_assets import blender_executable
    executable = blender_executable()
    if not executable:
        raise ValueError("材质球封面需要 Blender，请安装后重试；导入前的交互预览仍可使用")
    output = Path(output)
    worker = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "material_worker.py"
    with (output / "render.log").open("w") as log:
        try:
            result = subprocess.run([executable, "--background", "--factory-startup", "--disable-autoexec",
                                     "--threads", "4", "--python", str(worker), "--", str(output / "material.json")],
                                    stdout=log, stderr=subprocess.STDOUT, timeout=120)
        except subprocess.TimeoutExpired as exc:
            raise ValueError("材质球渲染超过 2 分钟，请检查贴图或重试") from exc
    if result.returncode or not (output / "view-0.png").is_file():
        lines = (output / "render.log").read_text(errors="replace").splitlines()
        errors = [line for line in lines if line.startswith(("ValueError:", "RuntimeError:", "TypeError:", "KeyError:"))]
        raise ValueError("材质球渲染失败：" + (errors[-1] if errors else "\n".join(lines[-4:]))[-800:])
