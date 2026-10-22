"""Blender regression: transparent coplanar overlays must keep the opaque base visible."""
from pathlib import Path
import sys
import tempfile

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model_worker import separate_preview_layers

output = Path(tempfile.mkdtemp(prefix="prism-preview-layers-"))
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
mesh = bpy.data.meshes.new("Coplanar hair fixture")
points = [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)]
mesh.from_pydata(points + points, [], [(0, 1, 2), (0, 2, 3), (4, 5, 6), (4, 6, 7)])
mesh.update()
obj = bpy.data.objects.new("Hair and transparent highlight", mesh)
bpy.context.collection.objects.link(obj)
for name, alpha in [("Opaque hair", 1), ("Transparent highlight", 0)]:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (1, 0, 0, 1)
    shader.inputs["Emission Color"].default_value = (1, 0, 0, 1)
    shader.inputs["Emission Strength"].default_value = 1
    shader.inputs["Alpha"].default_value = alpha
    mesh.materials.append(mat)
for polygon in mesh.polygons:
    polygon.material_index = 0 if polygon.index < 2 else 1
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 4
scene.cycles.use_denoising = False
scene.render.resolution_x = scene.render.resolution_y = 64
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.world.use_nodes = True
scene.world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0
scene.view_settings.view_transform = "Standard"
camera = bpy.data.cameras.new("Camera")
camera.type, camera.ortho_scale = "ORTHO", 2.4
camera_obj = bpy.data.objects.new("Camera", camera)
scene.collection.objects.link(camera_obj)
camera_obj.location = (0, 0, 3)
camera_obj.rotation_euler = Vector((0, 0, -1)).to_track_quat("-Z", "Y").to_euler()
scene.camera = camera_obj


def coverage(name):
    path = output / (name + ".png")
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(str(path), check_existing=False)
    pixels = list(image.pixels)
    red = sum(pixels[4 * (y * 64 + x)] > .9 for y in range(16, 48) for x in range(16, 48))
    bpy.data.images.remove(image)
    return red / 1024


before = coverage("before")
faces = separate_preview_layers([obj])
after = coverage("after")
assert faces == 2
assert len(mesh.polygons) == 4
assert after > .99, ("Opaque base still lost", before, after)
assert after > before + .1, ("Fixture did not reproduce the coplanar ray issue", before, after)
print("PREVIEW_LAYERS_OK", {"before_red_coverage": before, "after_red_coverage": after, "output": str(output)})
