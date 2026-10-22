"""Executed by Blender only. Produces a static GLB proxy and two visual views."""
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def texture_image(path):
    try:
        return bpy.data.images.load(path, check_existing=True)
    except Exception:
        return None


def material_from_pmx(data):
    material = bpy.data.materials.new(data["name"])
    material.use_nodes = True
    material.use_backface_culling = not data["double_sided"]
    nodes = material.node_tree.nodes
    shader = nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = data["diffuse"]
    shader.inputs["Alpha"].default_value = data["diffuse"][3]
    shader.inputs["Roughness"].default_value = .8
    for binding in data["bindings"]:
        if binding["role"] == "Base Color" and binding["exists"]:
            image = texture_image(binding["path"])
            if image:
                node = nodes.new("ShaderNodeTexImage")
                node.image = image
                material.node_tree.links.new(node.outputs["Color"], shader.inputs["Base Color"])
                material.node_tree.links.new(node.outputs["Alpha"], shader.inputs["Alpha"])
    material.surface_render_method = "DITHERED"
    return material


def load_pmx(data):
    mesh = bpy.data.meshes.new(data["name"])
    mesh.from_pydata(data["positions"], [], data["faces"])
    mesh.update()
    obj = bpy.data.objects.new(data["name"], mesh)
    bpy.context.collection.objects.link(obj)
    uv = mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        polygon.use_smooth = True
        for loop_index in polygon.loop_indices:
            uv.data[loop_index].uv = data["uvs"][mesh.loops[loop_index].vertex_index]
    start = 0
    for index, material in enumerate(data["materials"]):
        mesh.materials.append(material_from_pmx(material))
        for polygon in mesh.polygons[start:start + material["triangles"]]:
            polygon.material_index = index
        start += material["triangles"]


def inspect_materials(source):
    result = []
    for material in bpy.data.materials:
        if material.users == 0:
            continue
        bindings = []
        if material.use_nodes:
            for node in material.node_tree.nodes:
                if node.type != "TEX_IMAGE" or not node.image:
                    continue
                image = node.image
                embedded = bool(image.packed_file)
                value = Path(bpy.path.abspath(image.filepath))
                roles = set()
                # Follow short converter chains (Normal Map, Separate Color, etc.).
                def trace(output, depth=0):
                    if depth > 4:
                        return
                    for link in output.links:
                        if link.to_node.type in ("BSDF_PRINCIPLED", "NORMAL_MAP", "BUMP"):
                            roles.add("Normal" if link.to_node.type in ("NORMAL_MAP", "BUMP") else link.to_socket.name)
                        else:
                            for next_output in link.to_node.outputs:
                                trace(next_output, depth + 1)
                for output in node.outputs:
                    trace(output)
                bindings.append({"role": " / ".join(sorted(roles)) or "Texture",
                                 "reference": image.name if embedded else image.filepath,
                                 "path": "" if embedded else str(value.resolve()),
                                 "embedded": embedded, "exists": embedded or value.is_file(), "active": True})
        result.append({"name": material.name, "bindings": bindings})
    return result


def main():
    payload = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
    source, out = Path(payload["source"]), Path(payload["output"])
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for material in list(bpy.data.materials):
        bpy.data.materials.remove(material)
    ext = source.suffix.lower()
    if ext == ".pmx":
        load_pmx(payload["pmx"])
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(source), use_anim=False)
    else:
        bpy.ops.import_scene.gltf(filepath=str(source))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and len(o.data.vertices)]
    if not meshes:
        raise ValueError("模型不包含可预览网格")
    materials = payload["pmx"]["materials"] if ext == ".pmx" else inspect_materials(source)
    # Missing external textures must not abort Cycles or yield an empty thumbnail.
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        for node in list(material.node_tree.nodes):
            if node.type == "TEX_IMAGE" and node.image and not node.image.packed_file:
                image_path = Path(bpy.path.abspath(node.image.filepath))
                if not image_path.is_file() and node.image.source != "GENERATED":
                    material.node_tree.nodes.remove(node)
    bounds = [o.matrix_world @ Vector(v) for o in meshes for v in o.bound_box]
    low = Vector(tuple(min(v[i] for v in bounds) for i in range(3)))
    high = Vector(tuple(max(v[i] for v in bounds) for i in range(3)))
    center, extent = (low + high) / 2, max(high - low)
    if not math.isfinite(extent) or extent <= 0:
        raise ValueError("模型边界无效")
    # Bake evaluated meshes at their current pose; strips actions, constraints and scripts.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    static = []
    for old in meshes:
        mesh = bpy.data.meshes.new_from_object(old.evaluated_get(depsgraph), depsgraph=depsgraph)
        obj = bpy.data.objects.new(old.name + " preview", mesh)
        bpy.context.collection.objects.link(obj)
        for vertex in mesh.vertices:
            vertex.co = (old.matrix_world @ vertex.co - center) * (2 / extent)
        static.append(obj)
    for obj in list(bpy.context.scene.objects):
        if obj not in static:
            bpy.data.objects.remove(obj, do_unlink=True)
    # Normalize images into cache. This supports BMP/TGA and self-contained GLB textures.
    for index, image in enumerate(list(bpy.data.images)):
        if image.type != "IMAGE" or not image.has_data:
            continue
        try:
            image.filepath_raw = str(out / f"texture-{index}.png")
            image.file_format = "PNG"
            image.save()
            image.pack()
        except Exception:
            pass
    bpy.ops.object.select_all(action="DESELECT")
    for obj in static:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = static[0]
    bpy.ops.export_scene.gltf(filepath=str(out / "model.glb"), export_format="GLB",
                              use_selection=True, export_animations=False, export_cameras=False,
                              export_lights=False, export_yup=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = True
    scene.cycles.device = "CPU"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (.55, .58, .64, 1)
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = .65
    scene.view_settings.view_transform = "Standard"
    scene.render.film_transparent = False
    for location, energy, size in [((3, -4, 5), 350, 5), ((-3, 1, 3), 220, 4)]:
        light = bpy.data.lights.new("Preview softbox", "AREA")
        light.energy, light.shape, light.size = energy, "DISK", size
        obj = bpy.data.objects.new("Preview softbox", light)
        scene.collection.objects.link(obj)
        obj.location = location
        obj.rotation_euler = (-obj.location).to_track_quat("-Z", "Y").to_euler()
    camera = bpy.data.cameras.new("Preview camera")
    obj = bpy.data.objects.new("Preview camera", camera)
    scene.collection.objects.link(obj)
    scene.camera = obj
    camera.type, camera.ortho_scale = "ORTHO", 2.75
    for index, location in enumerate([(1.0, -4, .55), (-2.8, 3, .7)]):
        obj.location = location
        obj.rotation_euler = (-obj.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(out / f"view-{index}.png")
        bpy.ops.render.render(write_still=True)
    metadata = {"name": payload.get("pmx", {}).get("name", source.stem),
                "format": ext[1:], "vertices": sum(len(o.data.vertices) for o in static),
                "triangles": sum(len(p.vertices) - 2 for o in static for p in o.data.polygons),
                "meshes": len(static), "materials": materials,
                "bones": payload.get("pmx", {}).get("bones"),
                "comment": payload.get("pmx", {}).get("comment", ""),
                "warnings": (["PMX 为静态基础材质预览；Sphere、Toon、描边与 MMD 特效未还原。"] if ext == ".pmx"
                             else ["展示导入时的静态姿态；不播放动画，复杂着色器可能与原软件不同。"])}
    (out / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False))


if __name__ == "__main__":
    main()
