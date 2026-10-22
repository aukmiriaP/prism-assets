"""Read-only model adapters and cache orchestration. No source files are modified."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys

MODEL_EXTENSIONS = {".pmx", ".fbx", ".glb", ".gltf"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".tga", ".sph", ".spa"}
CACHE_VERSION = "static-model-v3"


def blender_executable():
    for value in [os.environ.get("PRISM_BLENDER"), "/Applications/Blender.app/Contents/MacOS/Blender",
                  shutil.which("blender")]:
        if value and Path(value).is_file():
            return str(value)
    return None


def resolve_reference(base, value):
    """Resolve Windows separators/case; refuse network and absolute references."""
    value = value.replace("\\", "/")
    if not value or "://" in value or value.startswith("/") or ":" in value:
        return None
    candidate = base / value
    # References to a sibling texture folder are common and supported.
    current = base
    for part in Path(value).parts:
        if part == "..":
            current = current.parent
        else:
            try:
                found = next((p for p in current.iterdir() if p.name.casefold() == part.casefold()), None)
            except OSError:
                return candidate.absolute()
            if found is None:
                return candidate.absolute()
            current = found
    return current.resolve()


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def dependency_stamp(path, metadata=None):
    """Cheap watch fingerprint, including missing refs and auxiliary additions."""
    source = Path(path)
    paths = {source}
    # A model package can contain shader resources not reported by the importer.
    paths.update(p for p in source.parent.rglob("*") if p.is_file() and not p.is_symlink()
                 and p.suffix.lower() in IMAGE_EXTENSIONS | {".bin", ".mtl", ".txt", ".md"})
    for resource in (metadata or {}).get("resources", []):
        if resource.get("path"):
            paths.add(Path(resource["path"]))
    digest = hashlib.sha256(CACHE_VERSION.encode())
    for p in sorted(paths):
        try:
            st = p.stat()
            value = (str(p), st.st_mtime_ns, st.st_size)
        except OSError:
            value = (str(p), "missing")
        digest.update(repr(value).encode())
    return digest.hexdigest()


class PMXReader:
    def __init__(self, path):
        if path.stat().st_size > 512 * 1024**2:
            raise ValueError("模型超过 512 MB")
        self.data, self.pos = path.read_bytes(), 0

    def take(self, size):
        if size < 0 or self.pos + size > len(self.data):
            raise ValueError("PMX 数据截断或长度无效")
        data = self.data[self.pos:self.pos + size]
        self.pos += size
        return data

    def unpack(self, fmt):
        values = struct.unpack("<" + fmt, self.take(struct.calcsize("<" + fmt)))
        return values[0] if len(values) == 1 else list(values)

    def count(self, maximum):
        value = self.unpack("i")
        if not 0 <= value <= maximum:
            raise ValueError("PMX 元素数量超出限制")
        return value

    def text(self):
        return self.take(self.count(4_000_000)).decode(self.encoding, errors="replace")

    def index(self, size):
        return self.unpack({1: "b", 2: "h", 4: "i"}[size])


def read_pmx(path):
    """PMX 2.0/2.1 static geometry/materials. Bone/physics data is not executed."""
    r = PMXReader(path)
    if r.take(4) != b"PMX ":
        raise ValueError("不是有效的 PMX 文件")
    version = r.unpack("f")
    if not 1.99 < version < 2.11:
        raise ValueError("支持 PMX 2.0 / 2.1")
    settings = list(r.take(r.unpack("B")))
    if len(settings) < 8 or settings[0] not in (0, 1) or settings[1] > 4 or any(x not in (1, 2, 4) for x in settings[2:8]):
        raise ValueError("PMX 头部无效")
    encoding, extra, vs, ts, _, bs, _, _ = settings[:8]
    r.encoding = "utf-16-le" if encoding == 0 else "utf-8"
    name, english, comment, _ = [r.text() for _ in range(4)]
    positions, uvs = [], []
    vertices = r.count(2_000_000)
    for _ in range(vertices):
        p = r.unpack("3f")
        r.take(12)  # Imported normals are recalculated for the static proxy.
        uv = r.unpack("2f")
        # MMD: +Y up, +Z forward. Blender: +Z up; preserve handedness.
        positions.append([p[0], p[2], p[1]])
        uvs.append([uv[0], 1 - uv[1]])
        r.take(extra * 16)
        weight = r.unpack("B")
        lengths = {0: bs, 1: bs * 2 + 4, 2: bs * 4 + 16, 3: bs * 2 + 40, 4: bs * 4 + 16}
        if weight not in lengths:
            raise ValueError("PMX 权重类型无效")
        r.take(lengths[weight] + 4)
    index_count = r.count(12_000_000)
    if index_count % 3:
        raise ValueError("PMX 三角形索引无效")
    indices = [x[0] for x in struct.iter_unpack("<" + {1: "B", 2: "H", 4: "I"}[vs], r.take(index_count * vs))]
    if indices and max(indices) >= vertices:
        raise ValueError("PMX 顶点索引越界")
    textures = [r.text() for _ in range(r.count(100_000))]
    materials = []
    for i in range(r.count(10_000)):
        mat_name, mat_english = r.text(), r.text()
        diffuse = r.unpack("4f")
        r.take(12 + 4 + 12)
        flags = r.unpack("B")
        r.take(16 + 4)
        tex, sphere = r.index(ts), r.index(ts)
        sphere_mode, toon_shared = r.unpack("B"), r.unpack("B")
        if sphere_mode > 3 or toon_shared > 1:
            raise ValueError("PMX 材质参数无效")
        toon = r.unpack("B") if toon_shared else r.index(ts)
        memo, count = r.text(), r.count(index_count)
        bindings = []
        for role, value in [("Base Color", tex), ("Sphere", sphere), ("Toon", -1 if toon_shared else toon)]:
            if value < 0:
                continue
            if value >= len(textures):
                raise ValueError("PMX 贴图索引越界")
            reference = textures[value]
            target = resolve_reference(path.parent, reference)
            bindings.append({"role": role, "reference": reference,
                             "path": str(target) if target else "", "embedded": False,
                             "exists": bool(target and target.is_file()),
                             "active": role != "Sphere" or sphere_mode != 0})
        materials.append({"name": mat_name or mat_english or f"Material {i + 1}", "diffuse": diffuse,
                          "double_sided": bool(flags & 1), "triangles": count // 3,
                          "bindings": bindings, "toon_builtin": toon if toon_shared else None,
                          "sphere_mode": sphere_mode, "memo": memo})
    if sum(m["triangles"] * 3 for m in materials) != index_count:
        raise ValueError("PMX 材质面数不匹配")
    bones = r.count(100_000)
    return {"name": name or english or path.stem, "comment": comment,
            "positions": positions, "uvs": uvs,
            "faces": [[indices[i], indices[i + 2], indices[i + 1]] for i in range(0, index_count, 3)],
            "vertices": vertices, "triangles": index_count // 3, "bones": bones,
            "materials": materials}


def gltf_document(path):
    if path.suffix.lower() == ".gltf":
        return json.loads(path.read_text())
    with path.open("rb") as stream:
        header = stream.read(20)
        if header.startswith(b"CTV1"):
            raise ValueError("这是 ComfyTV 的 CTV1 封装资源，不是标准 GLB；请导出标准 GLB 后重试")
        if header.startswith(b"version https://git-"):
            raise ValueError("这是 Git LFS 指针，请拉取真实模型文件后重试")
        if len(header) != 20:
            raise ValueError("GLB 文件截断")
        magic, version, total, length, kind = struct.unpack("<5I", header)
        if magic != 0x46546C67 or version != 2 or kind != 0x4E4F534A or length > 64 * 1024**2:
            raise ValueError("GLB 头部无效，文件可能损坏或并非标准 GLB")
        if total != path.stat().st_size or length > total - 20:
            raise ValueError("GLB 文件截断或长度不匹配，请获取完整文件后重试")
        try:
            return json.loads(stream.read(length))
        except (ValueError, UnicodeError) as exc:
            raise ValueError("GLB 的 JSON 数据无效，请重新导出模型后重试") from exc


def gltf_materials(path, document):
    from urllib.parse import unquote
    result = []
    for index, material in enumerate(document.get("materials", [])):
        bindings = []
        pbr = material.get("pbrMetallicRoughness", {})
        entries = [("Base Color", pbr.get("baseColorTexture")), ("Metallic / Roughness", pbr.get("metallicRoughnessTexture")),
                   ("Normal", material.get("normalTexture")), ("Occlusion", material.get("occlusionTexture")),
                   ("Emission", material.get("emissiveTexture"))]
        for role, info in entries:
            if not info:
                continue
            texture = document["textures"][info["index"]]
            image = document["images"][texture["source"]]
            uri = image.get("uri", "")
            embedded = not uri or uri.startswith("data:")
            target = None if embedded else resolve_reference(path.parent, unquote(uri))
            bindings.append({"role": role, "reference": image.get("name", f"Image {texture['source']}") if embedded else uri,
                             "path": str(target) if target else "", "embedded": embedded,
                             "exists": embedded or bool(target and target.is_file()), "active": True})
        result.append({"name": material.get("name", f"Material {index + 1}"), "bindings": bindings})
    return result


def prepare_model(path, output):
    if path.stat().st_size > 512 * 1024**2:
        raise ValueError("当前支持 512 MB 以内的模型")
    if path.suffix.lower() in {".glb", ".gltf"}:
        gltf_document(path)
    executable = blender_executable()
    if not executable:
        raise ValueError("3D 预览需要 Blender，请安装到 /Applications/Blender.app 后重试索引")
    output.mkdir(parents=True, exist_ok=True)
    worker = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "model_worker.py"
    payload = {"source": str(path), "output": str(output)}
    if path.suffix.lower() == ".pmx":
        payload["pmx"] = read_pmx(path)
    request = output / "request.json"
    request.write_text(json.dumps(payload, ensure_ascii=False))
    try:
        with (output / "convert.log").open("w") as log:
            result = subprocess.run([executable, "--background", "--factory-startup", "--disable-autoexec",
                                     "--threads", "4", "--python", str(worker), "--", str(request)],
                                    stdout=log, stderr=subprocess.STDOUT, timeout=240)
        if result.returncode or not (output / "metadata.json").is_file():
            lines = (output / "convert.log").read_text(errors="replace").splitlines()
            errors = [line.strip() for line in lines if line.strip().startswith(
                ("RuntimeError:", "ValueError:", "AttributeError:", "KeyError:", "OSError:", "Error:"))]
            detail = errors[-1] if errors else "\n".join(lines[-5:])[-800:]
            raise ValueError("3D 转换失败：" + detail)
    except subprocess.TimeoutExpired as exc:
        raise ValueError("3D 转换超过 4 分钟，请简化模型后重试") from exc
    finally:
        request.unlink(missing_ok=True)
    metadata = json.loads((output / "metadata.json").read_text())
    if path.suffix.lower() in {".glb", ".gltf"}:
        metadata["materials"] = gltf_materials(path, gltf_document(path))
    resources, by_key = [], {}
    for material in metadata["materials"]:
        for binding in material["bindings"]:
            key = binding["path"] or "embedded:" + binding["reference"]
            if key not in by_key:
                by_key[key] = len(resources)
                resources.append({**binding, "kind": "texture", "relation": "bound", "materials": []})
            index = by_key[key]
            binding["resource_index"] = index
            resources[index]["materials"].append({"name": material["name"], "role": binding["role"]})
    # Include glTF binary buffers as explicit dependencies.
    if path.suffix.lower() == ".gltf":
        from urllib.parse import unquote
        document = gltf_document(path)
        for item in document.get("buffers", []):
            uri = item.get("uri", "")
            if uri and not uri.startswith("data:"):
                target = resolve_reference(path.parent, unquote(uri))
                if target:
                    resources.append({"path": str(target), "reference": uri, "exists": target.is_file(),
                                      "kind": "buffer", "relation": "bound", "embedded": False, "materials": []})
    bound = {r["path"] for r in resources}
    for p in sorted(path.parent.rglob("*")):
        if not p.is_file() or p.is_symlink() or str(p.resolve()) in bound:
            continue
        if p.suffix.lower() in IMAGE_EXTENSIONS | {".txt", ".md", ".pdf"}:
            resources.append({"path": str(p.resolve()), "reference": str(p.relative_to(path.parent)),
                              "exists": True, "kind": "texture" if p.suffix.lower() in IMAGE_EXTENSIONS else "document",
                              "relation": "auxiliary", "embedded": False, "materials": []})
    metadata.update(resources=resources, cache_version=CACHE_VERSION)
    digest = hashlib.sha256((CACHE_VERSION + file_hash(path)).encode())
    # Model identity includes actual dependencies; different texture variants never collapse.
    for resource in resources:
        if resource["relation"] == "bound" and resource["path"]:
            digest.update(resource["reference"].encode())
            digest.update(file_hash(resource["path"]).encode() if resource["exists"] else b"MISSING")
    metadata["content_hash"] = "model:" + digest.hexdigest()
    metadata["dependency_stamp"] = dependency_stamp(path, metadata)
    (output / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False))
    return metadata
