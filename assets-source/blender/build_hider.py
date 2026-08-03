"""Build the neutral Fold & Seek Mimic source used for Mixamo auto-rigging."""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "assets-source" / "blender"
PREVIEW_DIR = ROOT / "assets-source" / "previews"
SOURCE_DIR.mkdir(parents=True, exist_ok=True)
PREVIEW_DIR.mkdir(parents=True, exist_ok=True)


def mat(name, color, metallic=0.0, roughness=0.4, emission=None, strength=0.0):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1)
    value.use_nodes = True
    bsdf = value.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1)
        bsdf.inputs["Emission Strength"].default_value = strength
    return value


def finish(obj, name, material, smooth=True, bevel=0.0):
    obj.name = name
    if obj.data and hasattr(obj.data, "materials"):
        obj.data.materials.append(material)
    if smooth and obj.type == "MESH":
        for face in obj.data.polygons:
            face.use_smooth = True
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new("Rounded shell", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    for old in list(obj.users_collection):
        old.objects.unlink(obj)
    MODEL.objects.link(obj)
    return obj


def sphere(name, location, scale, material, segments=28):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=14, location=location)
    obj = bpy.context.object
    obj.scale = scale
    return finish(obj, name, material)


def box(name, location, scale, material, bevel=0.025):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.scale = scale
    return finish(obj, name, material, False, bevel)


def cyl(name, a, b, radius, material, vertices=24):
    a, b = Vector(a), Vector(b)
    delta = b-a
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=delta.length,
                                        location=(a+b)*0.5)
    obj = bpy.context.object
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = delta.to_track_quat("Z", "Y")
    return finish(obj, name, material)


def capsule(name, a, b, radius, material):
    cyl(name+"_Shell", a, b, radius, material)
    sphere(name+"_CapA", a, (radius, radius, radius), material, 20)
    sphere(name+"_CapB", b, (radius, radius, radius), material, 20)


def ring(name, location, major, minor, material, rotation=(math.pi/2, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor,
                                    major_segments=24, minor_segments=8,
                                    location=location, rotation=rotation)
    return finish(bpy.context.object, name, material)


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for collection in list(bpy.data.collections):
    bpy.data.collections.remove(collection)

MODEL = bpy.data.collections.new("Mimic_Model")
RIG = bpy.data.collections.new("Mimic_Rig")
STAGE = bpy.data.collections.new("Presentation")
bpy.context.scene.collection.children.link(MODEL)
bpy.context.scene.collection.children.link(RIG)
bpy.context.scene.collection.children.link(STAGE)

scene = bpy.context.scene
scene.name = "FoldSeek_Mimic"
scene.unit_settings.system = "METRIC"
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1000
scene.render.resolution_y = 1200
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.view_settings.look = "AgX - Medium High Contrast"

PORCELAIN = mat("Mimic Porcelain", (0.74, 0.78, 0.73), 0.02, 0.30)
GRAPHITE = mat("Mimic Bellows", (0.012, 0.018, 0.022), 0.62, 0.25)
BRASS = mat("Mimic Socket Brass", (0.52, 0.25, 0.045), 0.78, 0.23)
TEAL = mat("Mimic Eyes", (0.01, 0.63, 0.66), 0.14, 0.15, (0.01, 0.9, 0.92), 3.0)
CORAL = mat("Mimic Forge Mark", (0.87, 0.055, 0.025), 0.08, 0.25, (1.0, 0.03, 0.01), 0.55)

# Compact modular torso; seams remain readable after player-applied paint.
sphere("PelvisShell", (0, 0, 0.75), (0.17, 0.12, 0.14), PORCELAIN)
ring("PelvisBellows", (0, 0, 0.86), 0.115, 0.018, GRAPHITE, rotation=(0,0,0))
box("LowerTorsoShell", (0, 0, 0.94), (0.15, 0.11, 0.13), PORCELAIN, 0.055)
ring("WaistBellows", (0, 0, 1.06), 0.13, 0.018, GRAPHITE, rotation=(0,0,0))
box("UpperTorsoShell", (0, 0, 1.16), (0.205, 0.13, 0.14), PORCELAIN, 0.065)
cyl("NeckBellows", (0,0,1.28), (0,0,1.37), 0.065, GRAPHITE)
sphere("HeadPod", (0, 0, 1.49), (0.155, 0.135, 0.18), PORCELAIN)

# Two bright eyes and a dark shutter brow reproduce the in-game head pod.
for side in (-1, 1):
    sphere(f"Eye_{side}", (side*0.058, -0.128, 1.515), (0.040, 0.014, 0.048), TEAL, 20)
    ring(f"EyeBezel_{side}", (side*0.058, -0.139, 1.515), 0.047, 0.008, BRASS)
box("EyeShutter", (0, -0.137, 1.575), (0.125, 0.012, 0.018), GRAPHITE, 0.012)
ring("CrownSocket", (0, -0.03, 1.65), 0.035, 0.010, BRASS)
sphere("CrownSignal", (0, -0.03, 1.65), (0.024, 0.018, 0.024), CORAL, 16)

# Neutral T-pose limbs closely follow the current TypeScript rig proportions.
for side, label in ((1, "Left"), (-1, "Right")):
    sx = side
    sphere(f"{label}ShoulderBellows", (sx*0.245, 0, 1.20), (0.073,0.073,0.073), GRAPHITE)
    capsule(f"{label}UpperArm", (sx*0.27,0,1.20), (sx*0.52,0,1.20), 0.070, PORCELAIN)
    ring(f"{label}ElbowSocket", (sx*0.57,0,1.20), 0.055, 0.014, BRASS, rotation=(0,math.pi/2,0))
    sphere(f"{label}ElbowBellows", (sx*0.57,0,1.20), (0.058,0.058,0.058), GRAPHITE)
    capsule(f"{label}ForeArm", (sx*0.60,0,1.20), (sx*0.80,0,1.20), 0.060, PORCELAIN)
    ring(f"{label}WristSocket", (sx*0.85,0,1.20), 0.048, 0.012, BRASS, rotation=(0,math.pi/2,0))
    box(f"{label}Hand", (sx*0.91,-0.005,1.20), (0.075,0.05,0.065), PORCELAIN, 0.035)
    # One flush Forge panel on each forearm communicates the editable shell system.
    box(f"{label}ForgePanel", (sx*0.70,-0.065,1.20), (0.075,0.012,0.035), CORAL, 0.012)

for side, label in ((1, "Left"), (-1, "Right")):
    x = side*0.10
    sphere(f"{label}HipBellows", (x,0,0.72), (0.075,0.075,0.075), GRAPHITE)
    capsule(f"{label}Thigh", (x,0,0.68), (x,0,0.46), 0.09, PORCELAIN)
    ring(f"{label}KneeSocket", (x,0,0.40), 0.065, 0.014, BRASS, rotation=(0,0,0))
    sphere(f"{label}KneeBellows", (x,0,0.40), (0.065,0.065,0.065), GRAPHITE)
    capsule(f"{label}Shin", (x,0,0.35), (x,0,0.16), 0.07, PORCELAIN)
    box(f"{label}Foot", (x,-0.075,0.07), (0.09,0.15,0.065), PORCELAIN, 0.045)
    sphere(f"{label}AnkleSignal", (x,-0.115,0.145), (0.022,0.014,0.022), TEAL, 16)

# Editable humanoid rig matching the runtime Mimic skeleton. Runtime keeps its
# own deformable interpretation so forging can still resize shells and panels;
# this armature is the clean Blender source used for posing, visual audits, and
# future Mixamo retargets instead of leaving the master as an unrigged upload.
arm_data = bpy.data.armatures.new("MimicArmature")
armature = bpy.data.objects.new("Mimic_Rig", arm_data)
RIG.objects.link(armature)
bpy.context.view_layer.objects.active = armature
armature.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")


def bone(name, head, tail, parent=None):
    value = arm_data.edit_bones.new(name)
    value.head, value.tail = head, tail
    if parent:
        value.parent = arm_data.edit_bones.get(parent)
    return value


bone("Root", (0, 0, 0), (0, 0, 0.12))
bone("Hips", (0, 0, 0.72), (0, 0, 0.88), "Root")
bone("Spine", (0, 0, 0.88), (0, 0, 1.06), "Hips")
bone("Spine1", (0, 0, 1.06), (0, 0, 1.28), "Spine")
bone("Neck", (0, 0, 1.28), (0, 0, 1.37), "Spine1")
bone("Head", (0, 0, 1.37), (0, 0, 1.68), "Neck")
for side, label in ((1, "Left"), (-1, "Right")):
    bone(f"{label}Shoulder", (0, 0, 1.20), (side * 0.245, 0, 1.20), "Spine1")
    bone(f"{label}Arm", (side * 0.245, 0, 1.20), (side * 0.57, 0, 1.20), f"{label}Shoulder")
    bone(f"{label}ForeArm", (side * 0.57, 0, 1.20), (side * 0.85, 0, 1.20), f"{label}Arm")
    bone(f"{label}Hand", (side * 0.85, 0, 1.20), (side * 0.99, 0, 1.20), f"{label}ForeArm")
    bone(f"{label}UpLeg", (side * 0.10, 0, 0.74), (side * 0.10, 0, 0.40), "Hips")
    bone(f"{label}Leg", (side * 0.10, 0, 0.40), (side * 0.10, 0, 0.145), f"{label}UpLeg")
    bone(f"{label}Foot", (side * 0.10, 0, 0.145), (side * 0.10, -0.22, 0.07), f"{label}Leg")
bpy.ops.object.mode_set(mode="OBJECT")
armature.show_in_front = True


def owner_bone(name):
    if name.startswith(("Pelvis",)):
        return "Hips"
    if name.startswith(("LowerTorso", "PelvisBellows")):
        return "Spine"
    if name.startswith(("UpperTorso", "WaistBellows")):
        return "Spine1"
    if name.startswith("Neck"):
        return "Neck"
    if name.startswith(("Head", "Eye", "Crown")):
        return "Head"
    for label in ("Left", "Right"):
        if name.startswith(f"{label}Shoulder"):
            return f"{label}Arm"
        if name.startswith((f"{label}UpperArm", f"{label}Elbow")):
            return f"{label}Arm"
        if name.startswith((f"{label}ForeArm", f"{label}Wrist", f"{label}ForgePanel")):
            return f"{label}ForeArm"
        if name.startswith(f"{label}Hand"):
            return f"{label}Hand"
        if name.startswith((f"{label}Hip", f"{label}Thigh")):
            return f"{label}UpLeg"
        if name.startswith((f"{label}Knee", f"{label}Shin")):
            return f"{label}Leg"
        if name.startswith((f"{label}Foot", f"{label}Ankle")):
            return f"{label}Foot"
    raise RuntimeError(f"No Mimic rig owner for {name}")


for obj in list(MODEL.objects):
    world = obj.matrix_world.copy()
    obj.parent = armature
    obj.parent_type = "BONE"
    obj.parent_bone = owner_bone(obj.name)
    obj.matrix_world = world

# Editable master first, before the one-mesh upload conversion.
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE_DIR / "mimic-hider.blend"))

# Preview stage.
bpy.ops.mesh.primitive_plane_add(size=8, location=(0,0,-0.005))
floor = bpy.context.object
floor.data.materials.append(mat("Preview Floor", (0.015,0.018,0.024), 0, 0.5))
for old in list(floor.users_collection): old.objects.unlink(floor)
STAGE.objects.link(floor)

world = bpy.data.worlds.new("Mimic Preview World")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.01,0.014,0.022,1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.3
scene.world = world

def light(name, location, energy, color, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.color, data.size = energy, color, size
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    obj.rotation_euler = (Vector((0,0,0.82))-obj.location).to_track_quat("-Z","Y").to_euler()
    STAGE.objects.link(obj)

light("Forge Key", (-2.5,-3.8,3.2), 800, (0.35,0.85,1.0), 2.6)
light("Brass Rim", (2.8,0.8,2.4), 900, (1.0,0.32,0.10), 2.0)

cam_data = bpy.data.cameras.new("MimicPreviewCamera")
cam = bpy.data.objects.new("MimicPreviewCamera", cam_data)
cam.location = (2.4,-4.6,1.85)
cam.rotation_euler = (Vector((0,0,0.82))-cam.location).to_track_quat("-Z","Y").to_euler()
cam_data.lens = 70
STAGE.objects.link(cam)
scene.camera = cam
scene.render.filepath = str(PREVIEW_DIR / "mimic-hider-preview.png")
bpy.ops.render.render(write_still=True)

# Duplicate and join the character into one material-preserving upload mesh.
bpy.ops.object.select_all(action="DESELECT")
copies = []
for original in MODEL.objects:
    if original.type != "MESH":
        continue
    duplicate = original.copy()
    duplicate.data = original.data.copy()
    bpy.context.scene.collection.objects.link(duplicate)
    duplicate.select_set(True)
    copies.append(duplicate)
bpy.context.view_layer.objects.active = copies[0]
bpy.ops.object.join()
upload = bpy.context.object
upload.name = "FoldSeek_Mimic_Upload"
bpy.ops.export_scene.fbx(filepath=str(SOURCE_DIR / "mimic-mixamo-source.fbx"),
                         use_selection=True, object_types={"MESH"}, apply_unit_scale=True,
                         bake_anim=False, add_leaf_bones=False, path_mode="COPY", embed_textures=True)

print(f"BLEND={SOURCE_DIR / 'mimic-hider.blend'}")
print(f"FBX={SOURCE_DIR / 'mimic-mixamo-source.fbx'}")
print(f"PREVIEW={PREVIEW_DIR / 'mimic-hider-preview.png'}")
