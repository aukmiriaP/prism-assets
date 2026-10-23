"""Blender-only material thumbnail worker; uses a factory scene."""
import json
from pathlib import Path
import sys

import bpy

sys.path.insert(0, str(Path(__file__).parent))
from blender_material import build_material


def main():
    path = Path(sys.argv[sys.argv.index("--") + 1])
    metadata = json.loads(path.read_text())
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=48)
    sphere = bpy.context.object
    for polygon in sphere.data.polygons:
        polygon.use_smooth = True
    sphere.data.materials.append(build_material(metadata["config"], metadata["maps"], path.parent))
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.cycles.device = "CPU"
    scene.render.resolution_x = scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes["Background"]
    background.inputs[0].default_value = (.18, .19, .21, 1)
    background.inputs[1].default_value = .8
    scene.view_settings.view_transform = "Standard"
    for location, energy, size in [((3, -4, 5), 450, 4), ((-4, -1, 2), 280, 3), ((1, 3, 2), 500, 2)]:
        light = bpy.data.lights.new("Softbox", "AREA")
        light.energy, light.size = energy, size
        obj = bpy.data.objects.new("Softbox", light)
        scene.collection.objects.link(obj)
        obj.location = location
        obj.rotation_euler = (-obj.location).to_track_quat("-Z", "Y").to_euler()
    camera = bpy.data.cameras.new("Camera")
    obj = bpy.data.objects.new("Camera", camera)
    scene.collection.objects.link(obj)
    obj.location = (0, -4, .3)
    obj.rotation_euler = (-obj.location).to_track_quat("-Z", "Y").to_euler()
    camera.type, camera.ortho_scale = "ORTHO", 2.5
    scene.camera = obj
    scene.render.filepath = str(path.parent / "view-0.png")
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
