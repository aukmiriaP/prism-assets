"""Blender-only fixture generator: one textured mesh in three interchange formats."""
import json
from pathlib import Path
import sys
import bpy

out = Path(sys.argv[sys.argv.index("--") + 1])
out.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8)
obj = bpy.context.object
obj.name = "Fixture sphere"
material = bpy.data.materials.new("Red fixture material")
material.use_nodes = True
image = bpy.data.images.new("Fixture texture", 32, 32)
image.generated_color = (1, .04, .02, 1)
image.filepath_raw = str(out / "color.png")
image.file_format = "PNG"
image.save()
node = material.node_tree.nodes.new("ShaderNodeTexImage")
node.image = image
material.node_tree.links.new(node.outputs["Color"], material.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
obj.data.materials.append(material)
bpy.ops.export_scene.gltf(filepath=str(out / "sphere.glb"), export_format="GLB", use_selection=True)
bpy.ops.export_scene.gltf(filepath=str(out / "sphere.gltf"), export_format="GLTF_SEPARATE", use_selection=True)
bpy.ops.export_scene.fbx(filepath=str(out / "sphere.fbx"), use_selection=True, bake_anim=False, path_mode="RELATIVE")
# Missing external texture is a valid geometry-only fallback case.
doc = json.loads((out / "sphere.gltf").read_text())
doc["images"][0]["uri"] = "missing.png"
(out / "missing.gltf").write_text(json.dumps(doc))
# Truncation must fail only the bad model, not its whole folder job.
(out / "broken.pmx").write_bytes(b"PMX \x00")
print("FIXTURES_READY")
