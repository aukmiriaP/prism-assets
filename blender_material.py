"""Shared node construction for the isolated renderer and Blender add-on."""
from pathlib import Path


def linear_color(hex_color):
    def linear(v):
        return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
    return tuple(linear(int(hex_color[i:i + 2], 16) / 255) for i in (1, 3, 5)) + (1,)


def build_material(config, maps, directory):
    import bpy
    material = bpy.data.materials.new(config["name"])
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get("Principled BSDF")
    shader.location = (650, 100)
    nodes.get("Material Output").location = (960, 100)
    shader.inputs["Base Color"].default_value = linear_color(config["color"])
    shader.inputs["Roughness"].default_value = config["roughness"]
    shader.inputs["Metallic"].default_value = config["metallic"]
    shader.inputs["Alpha"].default_value = config["opacity"]
    shader.inputs["Emission Color"].default_value = (0, 0, 0, 1)
    shader.inputs["Emission Strength"].default_value = config["emissive_strength"]
    uv = nodes.new("ShaderNodeTexCoord")
    uv.location = (-1000, 200)
    mapping = nodes.new("ShaderNodeMapping")
    mapping.location = (-800, 200)
    mapping.inputs["Scale"].default_value = (config["repeat"],) * 3
    links.new(uv.outputs["UV"], mapping.inputs["Vector"])
    for index, (role, info) in enumerate(maps.items()):
        texture = nodes.new("ShaderNodeTexImage")
        texture.name = f"Prism {role}"
        texture.label = role
        texture.location = (-530, 500 - index * 270)
        # Separate images preserve data/color interpretation even for shared source maps.
        texture.image = bpy.data.images.load(str(Path(directory) / info["cache_file"]), check_existing=False)
        texture.image.colorspace_settings.name = "sRGB" if role in ("base_color", "emissive") else "Non-Color"
        texture.extension = "REPEAT"
        texture.image.pack()
        links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
        output = texture.outputs["Color"]
        if role == "ao":
            texture.label = "Ambient Occlusion · engine data (unconnected)"
            continue
        if role == "normal":
            normal = nodes.new("ShaderNodeNormalMap")
            normal.name = "Prism Normal"
            normal.location = (300, -250)
            normal.inputs["Strength"].default_value = config["normal_strength"]
            links.new(output, normal.inputs["Color"])
            links.new(normal.outputs["Normal"], shader.inputs["Normal"])
            continue
        if role in ("base_color", "emissive"):
            if role == "base_color":
                tint = nodes.new("ShaderNodeMixRGB")
                tint.blend_type = "MULTIPLY"
                tint.inputs[0].default_value = 1
                tint.inputs[2].default_value = linear_color(config["color"])
                tint.location = (50, 450)
                links.new(output, tint.inputs[1])
                output = tint.outputs[0]
            target = "Base Color" if role == "base_color" else "Emission Color"
        else:
            multiplier = nodes.new("ShaderNodeMath")
            multiplier.operation = "MULTIPLY"
            multiplier.name = f"Prism {role} factor"
            multiplier.location = (40, 150 - index * 130)
            multiplier.inputs[1].default_value = config[role]
            # Normalized scalar RGB maps have equal components; RGB->value is exact.
            links.new(output, multiplier.inputs[0])
            output = multiplier.outputs[0]
            target = {"roughness": "Roughness", "metallic": "Metallic", "opacity": "Alpha"}[role]
        links.new(output, shader.inputs[target])
    if hasattr(material, "surface_render_method"):
        material.surface_render_method = "DITHERED"
    return material
