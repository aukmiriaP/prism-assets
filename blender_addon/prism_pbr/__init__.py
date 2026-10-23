"""Import portable Prism PBR archives. No scripts from archives are executed."""
bl_info = {
    "name": "Prism PBR Material Importer", "author": "Prism",
    "version": (1, 0, 0), "blender": (4, 2, 0),
    "location": "File > Import > Prism PBR Material",
    "description": "Import normalized PBR textures and apply to selected meshes",
    "category": "Import-Export",
}

import json
import math
from pathlib import Path
import re
import struct
import tempfile
import zipfile

import bpy
from bpy.props import StringProperty
from bpy_extras.io_utils import ImportHelper

from .blender_material import build_material

ROLES = {"base_color", "normal", "roughness", "metallic", "ao", "emissive", "opacity"}


def validate_pack(archive):
    entries = archive.infolist()
    allowed = {"material.json", "README.txt"} | {f"textures/{r}.png" for r in ROLES}
    if (len(entries) > 9 or len({e.filename for e in entries}) != len(entries)
            or any(e.filename not in allowed or e.flag_bits & 1 for e in entries)
            or sum(e.file_size for e in entries) > 256 * 1024**2):
        raise ValueError("Invalid archive entries or package exceeds 256 MB")
    info = archive.getinfo("material.json")
    if info.file_size > 65536:
        raise ValueError("Material metadata exceeds 64 KB")
    payload = json.loads(archive.read(info))
    if payload.get("format") != "prism-pbr" or payload.get("version") != 1:
        raise ValueError("Not a Prism PBR v1 package")
    config, maps = payload["config"], payload["maps"]
    if (not isinstance(maps, dict) or not maps or set(maps) - ROLES
            or not isinstance(config, dict) or not isinstance(config.get("name"), str)
            or not 1 <= len(config["name"]) <= 128
            or not re.fullmatch(r"#[0-9a-fA-F]{6}", config.get("color", ""))
            or config.get("normal_format") != "opengl"):
        raise ValueError("Invalid PBR definition")
    for key, low, high in [("roughness", 0, 1), ("metallic", 0, 1),
                          ("opacity", 0, 1), ("repeat", .25, 16),
                          ("normal_strength", 0, 4), ("emissive_strength", 0, 10)]:
        value = config.get(key)
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"Invalid {key}")
    images = {}
    for role, binding in maps.items():
        filename = f"textures/{role}.png"
        if not isinstance(binding, dict) or binding.get("cache_file") != filename:
            raise ValueError("Invalid texture path")
        entry = archive.getinfo(filename)
        if entry.file_size > 100 * 1024**2:
            raise ValueError("Texture exceeds 100 MB")
        with archive.open(entry) as file:
            header = file.read(33)
        if len(header) != 33 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
            raise ValueError("Invalid PNG texture")
        width, height = struct.unpack(">II", header[16:24])
        if not width or not height or width * height > 40_000_000 or header[24] != 8:
            raise ValueError("Unsupported PNG dimensions or bit depth")
        images[role] = archive.read(entry)
    return config, maps, images


def import_pack(filepath, objects):
    meshes = [obj for obj in objects if obj.type == "MESH"]
    if not meshes:
        raise ValueError("Select at least one mesh before importing")
    if any(not obj.data.uv_layers for obj in meshes):
        raise ValueError("Selected meshes need UV coordinates; unwrap them first")
    # Validation is completed before touching the Blender scene.
    with zipfile.ZipFile(filepath) as archive:
        config, maps, images = validate_pack(archive)
    previous_materials = set(bpy.data.materials)
    previous_images = set(bpy.data.images)
    try:
        with tempfile.TemporaryDirectory(prefix="prism-pbr-") as temporary:
            base = Path(temporary)
            (base / "textures").mkdir()
            for role, content in images.items():
                (base / "textures" / f"{role}.png").write_bytes(content)
            material = build_material(config, maps, base)
        # Images are packed, so the project does not depend on the temporary directory.
        for obj in meshes:
            if obj.data.materials:
                obj.data.materials[obj.active_material_index] = material
            else:
                obj.data.materials.append(material)
        return material
    except Exception:
        for material in set(bpy.data.materials) - previous_materials:
            bpy.data.materials.remove(material, do_unlink=True)
        for image in set(bpy.data.images) - previous_images:
            bpy.data.images.remove(image, do_unlink=True)
        raise


class PRISM_OT_import_pbr(bpy.types.Operator, ImportHelper):
    bl_idname = "import_material.prism_pbr"
    bl_label = "Import Prism PBR Material"
    bl_options = {"REGISTER", "UNDO"}
    filename_ext = ".zip"
    filter_glob: StringProperty(default="*.zip", options={"HIDDEN"})

    def execute(self, context):
        try:
            material = import_pack(self.filepath, list(context.selected_objects))
        except Exception as exc:
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}
        self.report({"INFO"}, f"Applied {material.name}; textures packed. AO retained for engine use.")
        return {"FINISHED"}


def menu_import(self, context):
    self.layout.operator(PRISM_OT_import_pbr.bl_idname, text="Prism PBR Material (.zip)")


def register():
    bpy.utils.register_class(PRISM_OT_import_pbr)
    bpy.types.TOPBAR_MT_file_import.append(menu_import)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(menu_import)
    bpy.utils.unregister_class(PRISM_OT_import_pbr)
