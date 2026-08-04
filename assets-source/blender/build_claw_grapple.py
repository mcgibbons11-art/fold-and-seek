import bpy
import math
import os
from mathutils import Vector

PREFIX = "GrappleV1_"
OUTPUT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MODEL_DIR = os.path.join(OUTPUT_ROOT, "apps", "client", "public", "assets", "models", "gameplay")
BLEND_PATH = os.path.join(os.path.dirname(__file__), "claw-machine-grapple.blend")
os.makedirs(MODEL_DIR, exist_ok=True)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.actions):
    for block in list(datablocks):
        if block.users == 0:
            datablocks.remove(block)

scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = 26
scene.render.engine = "BLENDER_EEVEE"
scene.world.color = (0.035, 0.045, 0.06)

def mat(name, color, metallic, roughness, emission=None):
    material = bpy.data.materials.new(PREFIX + "MAT_" + name)
    material.diffuse_color = (*color, 1)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1)
        bsdf.inputs["Emission Strength"].default_value = 3.5
    return material

STEEL = mat("Gunmetal", (0.035, 0.05, 0.065), 0.85, 0.25)
BRASS = mat("AgedBrass", (0.48, 0.22, 0.055), 0.78, 0.28)
YELLOW = mat("WarmYellow", (0.95, 0.4, 0.018), 0.5, 0.25)
RED = mat("Vermilion", (0.72, 0.045, 0.018), 0.46, 0.29)
RUBBER = mat("Rubber", (0.012, 0.016, 0.022), 0.02, 0.86)
CYAN = mat("CyanLamp", (0.015, 0.48, 0.68), 0.3, 0.18, (0.01, 0.8, 1.0))
SILVER = mat("EdgeSteel", (0.3, 0.36, 0.4), 0.92, 0.2)

def finish(obj, material, bevel=0):
    obj.data.materials.append(material)
    for polygon in getattr(obj.data, "polygons", []):
        polygon.use_smooth = True
    if bevel:
        mod = obj.modifiers.new("Edge bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    return obj

def box(name, loc, dims, material, bevel=0.004, rot=(0, 0, 0), parent=None):
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rot)
    obj = bpy.context.object
    obj.name = PREFIX + name
    obj.dimensions = dims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish(obj, material, bevel)
    obj.parent = parent
    return obj

def cylinder(name, loc, radius, depth, material, rot=(0, 0, 0), vertices=24, bevel=0.0015, parent=None):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rot)
    obj = bpy.context.object
    obj.name = PREFIX + name
    finish(obj, material, bevel)
    obj.parent = parent
    return obj

def sphere(name, loc, radius, material, parent=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=radius, location=loc)
    obj = bpy.context.object
    obj.name = PREFIX + name
    finish(obj, material)
    obj.parent = parent
    return obj

def torus(name, loc, major, minor, material, rot=(0, 0, 0), parent=None):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=24, minor_segments=8, location=loc, rotation=rot)
    obj = bpy.context.object
    obj.name = PREFIX + name
    finish(obj, material)
    obj.parent = parent
    return obj

def beam(name, start, end, radius, material, parent=None):
    start = Vector(start)
    end = Vector(end)
    delta = end - start
    obj = cylinder(name, (start + end) * 0.5, radius, delta.length, material, vertices=12, bevel=0.001, parent=parent)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(delta.normalized())
    return obj

def empty(name, parent=None):
    obj = bpy.data.objects.new(PREFIX + name, None)
    scene.collection.objects.link(obj)
    obj.parent = parent
    return obj

def animate(obj, values, attr, action_name, interpolation="BEZIER"):
    action = bpy.data.actions.new(action_name + "__" + obj.name)
    obj.animation_data_create()
    obj.animation_data.action = action
    for frame, value in values:
        setattr(obj, attr, value)
        obj.keyframe_insert(data_path=attr, frame=frame)
    return action

def descendants(root):
    result = [root]
    for child in root.children_recursive:
        result.append(child)
    return result

def export_selected(path, roots):
    bpy.ops.object.select_all(action="DESELECT")
    for root in roots:
        for obj in descendants(root):
            obj.select_set(True)
    bpy.context.view_layer.objects.active = roots[0]
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_apply=True,
        export_yup=True,
    )

# ---------------------------------------------------------------- launcher
launcher = empty("Launcher_ROOT")
cuff = cylinder("Launcher_Cuff", (0, -0.018, 0), 0.06, 0.086, RUBBER, rot=(math.pi / 2, 0, 0), vertices=28, bevel=0.003, parent=launcher)
box("Launcher_Underbrace", (0, -0.012, -0.044), (0.11, 0.09, 0.03), STEEL, 0.007, parent=launcher)
box("Launcher_Housing", (0, 0.035, 0.025), (0.13, 0.105, 0.09), RED, 0.011, parent=launcher)
box("Launcher_TopPlate", (0, 0.045, 0.077), (0.105, 0.085, 0.018), YELLOW, 0.005, parent=launcher)

drum = cylinder("Launcher_Drum", (0, 0.082, 0.072), 0.037, 0.082, STEEL, rot=(0, math.pi / 2, 0), vertices=28, bevel=0.002, parent=launcher)
flanges = [
    cylinder("Launcher_DrumFlange_L", (-0.049, 0.082, 0.072), 0.048, 0.014, YELLOW, rot=(0, math.pi / 2, 0), vertices=24, bevel=0.003, parent=launcher),
    cylinder("Launcher_DrumFlange_R", (0.049, 0.082, 0.072), 0.048, 0.014, YELLOW, rot=(0, math.pi / 2, 0), vertices=24, bevel=0.003, parent=launcher),
]
coils = [torus(f"Launcher_CableCoil_{i}", (x, 0.082, 0.072), 0.032, 0.0033, SILVER, rot=(0, math.pi / 2, 0), parent=launcher) for i, x in enumerate((-0.027, -0.014, 0, 0.014, 0.027))]
guide = torus("Launcher_CableGuide", (0, 0.15, 0.065), 0.021, 0.006, BRASS, rot=(math.pi / 2, 0, 0), parent=launcher)
box("Launcher_Cheek_L", (-0.061, 0.071, 0.052), (0.016, 0.118, 0.115), BRASS, 0.005, rot=(0, 0, -0.08), parent=launcher)
box("Launcher_Cheek_R", (0.061, 0.071, 0.052), (0.016, 0.118, 0.115), BRASS, 0.005, rot=(0, 0, 0.08), parent=launcher)
box("Launcher_StatusLamp", (0, 0.012, 0.089), (0.046, 0.012, 0.016), CYAN, 0.002, parent=launcher)
for side in (-1, 1):
    for number, (y, z) in enumerate(((0.025, 0.015), (0.09, 0.02), (0.105, 0.085))):
        cylinder(f"Launcher_Bolt_{side}_{number}", (side * 0.071, y, z), 0.0075, 0.008, SILVER, rot=(0, math.pi / 2, 0), vertices=12, bevel=0.0008, parent=launcher)
cylinder("Launcher_AdjustDial", (0.047, 0.01, 0.09), 0.018, 0.014, BRASS, vertices=18, bevel=0.002, parent=launcher)
cylinder("Launcher_Nozzle", (0, 0.158, 0.065), 0.013, 0.04, STEEL, rot=(math.pi / 2, 0, 0), vertices=16, bevel=0.002, parent=launcher)

# ------------------------------------------------------------ claw-machine head
claw = empty("Claw_ROOT")
cylinder("Claw_CableCollet", (0, -0.038, 0), 0.017, 0.075, STEEL, rot=(math.pi / 2, 0, 0), vertices=16, bevel=0.002, parent=claw)
cylinder("Claw_HubShell", (0, 0.005, 0), 0.042, 0.06, BRASS, rot=(math.pi / 2, 0, 0), vertices=24, bevel=0.003, parent=claw)
sphere("Claw_HubCap", (0, 0.035, 0), 0.038, RED, parent=claw)
cylinder("Claw_StatusLens", (0, 0.068, 0), 0.015, 0.009, CYAN, rot=(math.pi / 2, 0, 0), vertices=16, bevel=0.001, parent=claw)

jaws = []
for index in range(3):
    angle = index * math.tau / 3
    pivot = empty(f"Claw_JawPivot_{index}", claw)
    pivot.rotation_mode = "XYZ"
    pivot.rotation_euler.y = angle
    jaws.append(pivot)
    sphere(f"Claw_JawHinge_{index}", (0.034, 0, 0), 0.011, SILVER, parent=pivot)
    beam(f"Claw_JawUpper_{index}", (0.034, 0, 0), (0.075, -0.055, 0), 0.009, STEEL, pivot)
    sphere(f"Claw_JawElbow_{index}", (0.075, -0.055, 0), 0.0095, BRASS, parent=pivot)
    beam(f"Claw_JawHook_{index}", (0.075, -0.055, 0), (0.052, -0.125, 0), 0.008, BRASS, pivot)
    cylinder(f"Claw_JawTip_{index}", (0.046, -0.13, 0), 0.011, 0.025, SILVER, rot=(math.pi / 2, 0, 0), vertices=10, bevel=0.001, parent=pivot)

# A production cable is dynamically scaled to the real target distance in Three.js.
cable = cylinder("Preview_Cable", (0, 0.57, 0.065), 0.008, 1.0, STEEL, rot=(math.pi / 2, 0, 0), vertices=12, bevel=0.001)

# -------------------------------------------------------------- authored action
# Launcher recoil and winch rotation.
for moving in [drum, *flanges, *coils]:
    moving.rotation_mode = "XYZ"
    base = tuple(moving.rotation_euler)
    values = []
    for frame, turns in ((1, 0), (5, -0.35), (18, -2.4), (24, -2.55), (26, -2.5)):
        values.append((frame, (base[0] + turns * math.tau, base[1], base[2])))
    animate(moving, values, "rotation_euler", "Fire", "BEZIER")

launcher.rotation_mode = "XYZ"
animate(launcher, [(1, (0, 0, 0)), (4, (-0.08, 0, 0)), (8, (0.025, 0, 0)), (14, (0, 0, 0))], "rotation_euler", "Fire", "BEZIER")

# Jaws spread in flight and snap closed when the head reaches the target.
for jaw in jaws:
    base = tuple(jaw.rotation_euler)
    animate(jaw, [
        (1, (base[0], base[1], 0.05)),
        (6, (base[0], base[1], -0.34)),
        (18, (base[0], base[1], -0.42)),
        (21, (base[0], base[1], 0.16)),
        (24, (base[0], base[1], 0.1)),
    ], "rotation_euler", "Latch", "BEZIER")

# Blender-authored reference deployment: one metre, normalized for arbitrary game range.
claw.location = (0, 0.18, 0.065)
animate(claw, [(1, (0, 0.18, 0.065)), (5, (0, 0.24, 0.065)), (18, (0, 1.18, 0.065)), (21, (0, 1.2, 0.065)), (24, (0, 1.16, 0.065))], "location", "DeployPreview", "BEZIER")
cable.scale = (1, 0.01, 1)
animate(cable, [(1, (1, 0.01, 1)), (5, (1, 0.07, 1)), (18, (1, 1.0, 1)), (24, (1, 0.96, 1))], "scale", "DeployPreview", "BEZIER")

scene.frame_set(1)
export_selected(os.path.join(MODEL_DIR, "claw-machine-grapple-preview.glb"), [launcher, claw, cable])

# Production exports: fixed local origins; game code supplies the real distance.
claw_deploy_action = claw.animation_data.action
cable_deploy_action = cable.animation_data.action
claw.animation_data_clear()
claw.location = (0, 0, 0)
cable.hide_render = True
export_selected(os.path.join(MODEL_DIR, "grapple-launcher.glb"), [launcher])
export_selected(os.path.join(MODEL_DIR, "grapple-claw.glb"), [claw])
cable.hide_render = False

# Restore the normalized one-metre deployment in the Blender master. Runtime
# code supplies the actual cable length, but animators must still be able to
# scrub the complete fire, travel and latch performance in this source file.
claw.animation_data_create()
claw.animation_data.action = claw_deploy_action
cable.animation_data_create()
cable.animation_data.action = cable_deploy_action
scene.frame_set(1)

# Save the fully animated source and a simple presentation camera/light setup.
bpy.ops.object.camera_add(location=(1.15, -1.45, 0.85), rotation=(math.radians(67), 0, math.radians(38)))
camera = bpy.context.object
camera.name = PREFIX + "PreviewCamera"
scene.camera = camera
bpy.ops.object.light_add(type="AREA", location=(0.6, -0.4, 1.3))
bpy.context.object.data.energy = 900
bpy.context.object.data.shape = "DISK"
bpy.context.object.data.size = 1.2
bpy.ops.object.light_add(type="AREA", location=(-0.8, 0.4, 0.6))
bpy.context.object.data.energy = 500
bpy.context.object.data.size = 1.0
bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)

print({
    "blend": BLEND_PATH,
    "launcher": os.path.join(MODEL_DIR, "grapple-launcher.glb"),
    "claw": os.path.join(MODEL_DIR, "grapple-claw.glb"),
    "preview": os.path.join(MODEL_DIR, "claw-machine-grapple-preview.glb"),
    "objects": len(bpy.data.objects),
    "actions": len(bpy.data.actions),
})
