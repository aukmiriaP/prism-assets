"""Executed inside an isolated factory Blender process."""
import json
from pathlib import Path
import sys
import zipfile

import bpy

base = Path(sys.argv[sys.argv.index("--") + 1])
with zipfile.ZipFile(base / "addon.zip") as archive:
    archive.extractall(base / "addon")
sys.path.insert(0, str(base / "addon"))
import prism_pbr

prism_pbr.register()
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add()
cube = bpy.context.object
bpy.ops.mesh.primitive_uv_sphere_add()
sphere = bpy.context.object
cube.select_set(True)
material = prism_pbr.import_pack(base / "wood.zip", list(bpy.context.selected_objects))
assert cube.data.materials[0] == sphere.data.materials[0] == material
nodes, links = material.node_tree.nodes, material.node_tree.links
shader = nodes.get("Principled BSDF")
assert shader.inputs["Base Color"].is_linked
assert shader.inputs["Roughness"].is_linked
assert shader.inputs["Normal"].is_linked
assert shader.inputs["Emission Color"].default_value[:3] == (0, 0, 0)
assert nodes["Prism normal"].image.colorspace_settings.name == "Non-Color"
assert nodes["Prism base_color"].image.colorspace_settings.name == "sRGB"
assert nodes["Prism roughness"].image.colorspace_settings.name == "Non-Color"
assert all(node.image.packed_file for node in nodes if node.type == "TEX_IMAGE")
assert all(not output.is_linked for output in nodes["Prism ao"].outputs)
assert nodes["Prism roughness factor"].inputs[1].default_value == 1
assert nodes["Prism Normal"].inputs["Strength"].default_value == 1
assert nodes.get("Mapping").inputs["Scale"].default_value[:] == (1, 1, 1)

# Archives cannot smuggle paths/scripts, out-of-range values or oversized images.
with zipfile.ZipFile(base / "wood.zip") as archive:
    entries = {item.filename: archive.read(item.filename) for item in archive.infolist()}
advanced = json.loads(entries["material.json"])
advanced["config"].update(color="#80a0c0", roughness=.65, metallic=.35, opacity=.8,
                          normal_strength=1.7, emissive_strength=2.4, repeat=2)
advanced_entries = dict(entries)
for role, source in [("metallic", "roughness"), ("opacity", "roughness"), ("emissive", "base_color")]:
    filename = f"textures/{role}.png"
    advanced["maps"][role] = {"cache_file": filename}
    advanced["config"]["maps"][role] = {"file": filename, "channel": "rgb" if role == "emissive" else "r", "invert": False}
    advanced_entries[filename] = entries[f"textures/{source}.png"]
advanced_entries["material.json"] = json.dumps(advanced).encode()
with zipfile.ZipFile(base / "advanced.zip", "w") as archive:
    for name, content in advanced_entries.items():
        archive.writestr(name, content)
advanced_material = prism_pbr.import_pack(base / "advanced.zip", [sphere])
advanced_nodes = advanced_material.node_tree.nodes
advanced_shader = advanced_nodes.get("Principled BSDF")
assert all(advanced_shader.inputs[name].is_linked for name in ("Base Color", "Normal", "Roughness", "Metallic", "Alpha", "Emission Color"))
assert abs(advanced_shader.inputs["Emission Strength"].default_value - 2.4) < 1e-6
assert abs(advanced_nodes["Prism Normal"].inputs["Strength"].default_value - 1.7) < 1e-6
for role, value in [("roughness", .65), ("metallic", .35), ("opacity", .8)]:
    assert abs(advanced_nodes[f"Prism {role} factor"].inputs[1].default_value - value) < 1e-6
assert advanced_nodes.get("Mapping").inputs["Scale"].default_value[:] == (2, 2, 2)
assert advanced_nodes["Prism emissive"].image.colorspace_settings.name == "sRGB"
assert all(advanced_nodes[f"Prism {role}"].image.colorspace_settings.name == "Non-Color" for role in ("metallic", "opacity"))
expected_tint = prism_pbr.blender_material.linear_color("#80a0c0")
tint = next(n for n in advanced_nodes if n.type == "MIX_RGB")
assert all(abs(a - b) < 1e-6 for a, b in zip(tint.inputs[2].default_value, expected_tint))
assert all(node.image.packed_file for node in advanced_nodes if node.type == "TEX_IMAGE")
cases = []
cases.append({**entries, "../bad.py": b"raise Exception()"})
payload = json.loads(entries["material.json"])
payload["config"]["repeat"] = 100
cases.append({**entries, "material.json": json.dumps(payload).encode()})
payload["config"]["repeat"] = 1
payload["maps"]["normal"]["cache_file"] = "/tmp/escaped.png"
cases.append({**entries, "material.json": json.dumps(payload).encode()})
header = bytearray(entries["textures/normal.png"])
header[16:20] = (100000).to_bytes(4, "big")
cases.append({**entries, "textures/normal.png": bytes(header)})
before = len(bpy.data.materials), len(bpy.data.images)
for index, case in enumerate(cases):
    path = base / f"invalid-{index}.zip"
    with zipfile.ZipFile(path, "w") as archive:
        for name, value in case.items():
            archive.writestr(name, value)
    try:
        prism_pbr.import_pack(path, [cube])
        raise AssertionError("Unsafe archive accepted")
    except ValueError:
        pass
    assert (len(bpy.data.materials), len(bpy.data.images)) == before
    assert cube.data.materials[0] == material
assert bpy.ops.import_material.prism_pbr(filepath=str(base / "wood.zip")) == {"FINISHED"}
bpy.ops.wm.save_as_mainfile(filepath=str(base / "applied.blend"))
prism_pbr.unregister()
(base / "addon-ok.json").write_text(json.dumps({"nodes": len(nodes), "images_packed": True, "safe_archives": len(cases)}))
print("MATERIAL_BLENDER_OK")
