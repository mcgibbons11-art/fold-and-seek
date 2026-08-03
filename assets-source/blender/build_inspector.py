"""Build the Fold & Seek Inspector from authored Blender primitives.

The model is deliberately assembled from rigid clockwork pieces so its material
breakup stays crisp after animation. Run with Blender 5.x in background mode.
"""

from __future__ import annotations

import math
import os
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "assets-source" / "blender"
GAME_DIR = ROOT / "apps" / "client" / "public" / "assets" / "characters"
PREVIEW_DIR = ROOT / "assets-source" / "previews"
CONCEPT = ROOT / "assets-source" / "concepts" / "inspector-chatgpt-reference-v1.png"
MIXAMO_DIR = ROOT / "assets-source" / "mixamo" / "raw"

for directory in (SOURCE_DIR, GAME_DIR, PREVIEW_DIR):
    directory.mkdir(parents=True, exist_ok=True)


def material(name: str, color: tuple[float, float, float, float], *, metallic=0.0,
             roughness=0.42, emission: tuple[float, float, float, float] | None = None,
             emission_strength=0.0) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = emission
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def move_to_collection(obj: bpy.types.Object, collection: bpy.types.Collection) -> None:
    for current in list(obj.users_collection):
        current.objects.unlink(obj)
    collection.objects.link(obj)


def finish(obj: bpy.types.Object, name: str, mat: bpy.types.Material,
           bone: str, *, smooth=True, bevel=0.0) -> bpy.types.Object:
    obj.name = name
    if obj.data and hasattr(obj.data, "materials"):
        obj.data.materials.append(mat)
    if smooth and obj.type == "MESH":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0.0:
        mod = obj.modifiers.new("Soft machined edges", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    obj["rig_bone"] = bone
    move_to_collection(obj, MODEL)
    return obj


def uv(name: str, location, scale, mat, bone, *, segments=32) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=16, location=location)
    obj = bpy.context.object
    obj.scale = scale
    return finish(obj, name, mat, bone)


def cube(name: str, location, scale, mat, bone, *, bevel=0.025) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.scale = scale
    return finish(obj, name, mat, bone, smooth=False, bevel=bevel)


def cylinder(name: str, a, b, radius: float, mat, bone, *, vertices=24) -> bpy.types.Object:
    a, b = Vector(a), Vector(b)
    delta = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=delta.length,
                                        location=(a + b) * 0.5)
    obj = bpy.context.object
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = delta.to_track_quat("Z", "Y")
    return finish(obj, name, mat, bone)


def capsule(name: str, a, b, radius: float, mat, bone) -> list[bpy.types.Object]:
    return [
        cylinder(name + "_Core", a, b, radius, mat, bone),
        uv(name + "_A", a, (radius, radius, radius), mat, bone, segments=24),
        uv(name + "_B", b, (radius, radius, radius), mat, bone, segments=24),
    ]


def torus(name: str, location, major_radius, minor_radius, mat, bone,
          rotation=(math.pi / 2, 0, 0)) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(major_radius=major_radius, minor_radius=minor_radius,
                                    major_segments=32, minor_segments=10,
                                    location=location, rotation=rotation)
    return finish(bpy.context.object, name, mat, bone)


def tapered_box(name: str, z0: float, z1: float, bottom: tuple[float, float],
                top: tuple[float, float], y: float, mat, bone, bevel=0.035) -> bpy.types.Object:
    bx, by = bottom
    tx, ty = top
    verts = [
        (-bx, y-by, z0), (bx, y-by, z0), (bx, y+by, z0), (-bx, y+by, z0),
        (-tx, y-ty, z1), (tx, y-ty, z1), (tx, y+ty, z1), (-tx, y+ty, z1),
    ]
    faces = [(0,1,2,3), (4,7,6,5), (0,4,5,1), (1,5,6,2), (2,6,7,3), (4,0,3,7)]
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    MODEL.objects.link(obj)
    return finish(obj, name, mat, bone, smooth=False, bevel=bevel)


def curve(name: str, points, bevel_depth: float, mat, bone) -> bpy.types.Object:
    data = bpy.data.curves.new(name + "Curve", "CURVE")
    data.dimensions = "3D"
    data.bevel_depth = bevel_depth
    data.bevel_resolution = 3
    spline = data.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for bp, point in zip(spline.bezier_points, points):
        bp.co = point
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, data)
    MODEL.objects.link(obj)
    obj.data.materials.append(mat)
    obj["rig_bone"] = bone
    return obj


# Clean scene and establish editable collections.
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for collection in list(bpy.data.collections):
    bpy.data.collections.remove(collection)

MODEL = bpy.data.collections.new("Inspector_Model")
RIG = bpy.data.collections.new("Inspector_Rig")
REFERENCE = bpy.data.collections.new("Reference")
PRESENTATION = bpy.data.collections.new("Presentation")
for collection in (MODEL, RIG, REFERENCE, PRESENTATION):
    bpy.context.scene.collection.children.link(collection)

scene = bpy.context.scene
scene.name = "FoldSeek_Inspector"
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1000
scene.render.resolution_y = 1200
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.view_settings.look = "AgX - Medium High Contrast"

NAVY = material("Curator Navy", (0.035, 0.075, 0.145, 1), metallic=0.08, roughness=0.3)
OXBLOOD = material("Oxblood Leather", (0.30, 0.055, 0.055, 1), roughness=0.36)
IVORY = material("Aged Ivory Ceramic", (0.82, 0.73, 0.56, 1), metallic=0.02, roughness=0.28)
BRASS = material("Worn Brass", (0.55, 0.27, 0.055, 1), metallic=0.78, roughness=0.24)
DARK = material("Joint Graphite", (0.018, 0.024, 0.032, 1), metallic=0.72, roughness=0.2)
TEAL = material("Teal Lens", (0.01, 0.54, 0.58, 1), metallic=0.16, roughness=0.18,
                emission=(0.01, 0.8, 0.85, 1), emission_strength=2.6)
CORAL = material("Warrant Red", (0.83, 0.045, 0.025, 1), metallic=0.12, roughness=0.26,
                 emission=(1.0, 0.025, 0.008, 1), emission_strength=0.7)
GLASS = material("Clock Glass", (0.08, 0.22, 0.24, 1), metallic=0.15, roughness=0.1)

# Reference is retained in the master but hidden from renders/exports.
if CONCEPT.exists():
    image = bpy.data.images.load(str(CONCEPT), check_existing=True)
    ref = bpy.data.objects.new("REF_Inspector_Concept", None)
    ref.empty_display_type = "IMAGE"
    ref.data = image
    ref.empty_display_size = 2.1
    ref.location = (0, 0.5, 1.0)
    ref.rotation_euler = (math.pi / 2, 0, 0)
    ref.hide_render = True
    ref.hide_viewport = True
    REFERENCE.objects.link(ref)

# Pelvis, layered coat torso, collar, and clockwork chest.
uv("Pelvis", (0, 0, 0.91), (0.22, 0.14, 0.17), NAVY, "Hips")
tapered_box("CoatTorso", 0.95, 1.40, (0.22, 0.135), (0.29, 0.16), 0, NAVY, "Spine1")
tapered_box("VestInset", 1.00, 1.35, (0.135, 0.016), (0.18, 0.016), -0.158,
            OXBLOOD, "Spine1", bevel=0.012)
for x in (-0.10, 0.10):
    for z in (1.08, 1.18, 1.28):
        uv(f"VestStud_{x}_{z}", (x, -0.184, z), (0.012, 0.008, 0.012), BRASS, "Spine1", segments=16)
cube("TealCravat", (0, -0.195, 1.385), (0.075, 0.018, 0.05), TEAL, "Neck", bevel=0.018)
for side in (-1, 1):
    cube(f"CoatSkirt_{side}", (side * 0.18, -0.01, 0.79), (0.075, 0.09, 0.22),
         OXBLOOD, "Hips", bevel=0.035)

# Pocket watch stack.
uv("ChestClockCase", (0.13, -0.19, 1.29), (0.064, 0.018, 0.064), BRASS, "Spine1", segments=32)
uv("ChestClockFace", (0.13, -0.211, 1.29), (0.050, 0.009, 0.050), GLASS, "Spine1", segments=32)
for angle in range(0, 360, 45):
    rad = math.radians(angle)
    uv(f"ClockTick_{angle}", (0.13 + math.sin(rad)*0.039, -0.222, 1.29 + math.cos(rad)*0.039),
       (0.004, 0.003, 0.009), IVORY, "Spine1", segments=12)
curve("WatchChain", [(0.13, -0.19, 1.35), (0.09, -0.205, 1.39), (0.04, -0.19, 1.37)],
      0.006, BRASS, "Spine1")

# Neck, ceramic face, helmet, glowing lenses, and readable expression.
cylinder("NeckPost", (0, 0, 1.40), (0, 0, 1.53), 0.075, DARK, "Neck")
torus("NeckBrassRing", (0, 0, 1.49), 0.078, 0.014, BRASS, "Neck", rotation=(0, 0, 0))
uv("HeadCeramic", (0, 0, 1.72), (0.205, 0.165, 0.225), IVORY, "Head")
uv("HelmetCrown", (0, 0.025, 1.88), (0.215, 0.17, 0.105), NAVY, "Head")
torus("HelmetBand", (0, -0.005, 1.84), 0.195, 0.019, BRASS, "Head", rotation=(math.pi/2, 0, 0))
cube("HelmetFin", (0, -0.002, 1.98), (0.025, 0.06, 0.065), BRASS, "Head", bevel=0.012)
for side in (-1, 1):
    uv(f"EarCup_{side}", (side*0.205, 0, 1.73), (0.045, 0.055, 0.07), BRASS, "Head")
    uv(f"EyeLens_{side}", (side*0.078, -0.158, 1.75), (0.050, 0.018, 0.064), TEAL, "Head")
    torus(f"EyeBezel_{side}", (side*0.078, -0.168, 1.75), 0.059, 0.010, BRASS, "Head")
    uv(f"BrowPin_{side}", (side*0.078, -0.164, 1.835), (0.012, 0.008, 0.012), BRASS, "Head", segments=16)
uv("ForeheadLens", (0, -0.108, 1.945), (0.042, 0.016, 0.042), TEAL, "Head")
torus("ForeheadBezel", (0, -0.115, 1.945), 0.049, 0.009, BRASS, "Head")
curve("SmileSeam", [(-0.065, -0.164, 1.655), (0, -0.177, 1.64), (0.065, -0.164, 1.655)],
      0.006, DARK, "Head")
curve("FaceCenterSeam", [(0, -0.166, 1.69), (0, -0.169, 1.79)], 0.003, BRASS, "Head")

# T-pose arms. Character left is +X while facing -Y.
for side, label in ((1, "Left"), (-1, "Right")):
    sx = side
    uv(f"{label}ShoulderJoint", (sx*0.31, 0, 1.39), (0.095, 0.12, 0.105), BRASS, f"{label}Arm")
    uv(f"{label}ShoulderPad", (sx*0.33, 0, 1.46), (0.15, 0.14, 0.075), OXBLOOD, f"{label}Arm")
    capsule(f"{label}UpperArm", (sx*0.36, 0, 1.39), (sx*0.61, 0, 1.39), 0.095, NAVY, f"{label}Arm")
    uv(f"{label}Elbow", (sx*0.66, 0, 1.39), (0.075, 0.075, 0.075), BRASS, f"{label}ForeArm")
    capsule(f"{label}ForeArm", (sx*0.69, 0, 1.39), (sx*0.90, 0, 1.39), 0.085, NAVY, f"{label}ForeArm")
    torus(f"{label}WristRing", (sx*0.94, 0, 1.39), 0.075, 0.014, BRASS, f"{label}Hand", rotation=(0, math.pi/2, 0))
    cube(f"{label}Palm", (sx*1.00, -0.005, 1.39), (0.075, 0.065, 0.082), DARK, f"{label}Hand", bevel=0.035)
    # Three broad clockwork fingers keep the silhouette readable at game distance.
    for index, zoff in enumerate((-0.045, 0.0, 0.045)):
        capsule(f"{label}Finger{index}", (sx*1.045, -0.018, 1.39+zoff),
                (sx*1.15, -0.018, 1.39+zoff), 0.020, BRASS, f"{label}Hand")
    uv(f"{label}HandLens", (sx*1.00, -0.072, 1.39), (0.022, 0.010, 0.022), TEAL, f"{label}Hand", segments=16)

# Legs and weighty curator boots.
for side, label in ((1, "Left"), (-1, "Right")):
    x = side * 0.13
    uv(f"{label}HipJoint", (x, 0, 0.88), (0.07, 0.07, 0.07), BRASS, f"{label}UpLeg")
    capsule(f"{label}Thigh", (x, 0, 0.84), (x, 0, 0.60), 0.105, IVORY, f"{label}UpLeg")
    uv(f"{label}Knee", (x, -0.012, 0.52), (0.09, 0.085, 0.09), BRASS, f"{label}Leg")
    capsule(f"{label}Shin", (x, 0, 0.47), (x, 0, 0.24), 0.09, NAVY, f"{label}Leg")
    cube(f"{label}ShinInset", (x, -0.082, 0.35), (0.025, 0.018, 0.095), OXBLOOD, f"{label}Leg", bevel=0.012)
    uv(f"{label}AnkleLens", (x, -0.088, 0.23), (0.028, 0.012, 0.028), CORAL, f"{label}Foot", segments=16)
    cube(f"{label}Boot", (x, -0.055, 0.105), (0.125, 0.18, 0.105), OXBLOOD, f"{label}Foot", bevel=0.055)
    cube(f"{label}BootToe", (x, -0.19, 0.075), (0.13, 0.10, 0.07), OXBLOOD, f"{label}Foot", bevel=0.05)
    torus(f"{label}BootTrim", (x, -0.195, 0.075), 0.075, 0.014, BRASS, f"{label}Foot", rotation=(math.pi/2, 0, 0))

# Mixamo-friendly humanoid armature. Mesh pieces use rigid bone parenting.
arm_data = bpy.data.armatures.new("InspectorArmature")
armature = bpy.data.objects.new("Inspector_Rig", arm_data)
RIG.objects.link(armature)
bpy.context.view_layer.objects.active = armature
armature.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")

def bone(name, head, tail, parent=None):
    b = arm_data.edit_bones.new(name)
    b.head, b.tail = head, tail
    if parent:
        b.parent = arm_data.edit_bones.get(parent)
    return b

bone("Root", (0,0,0), (0,0,0.12))
bone("Hips", (0,0,0.86), (0,0,1.00), "Root")
bone("Spine", (0,0,1.00), (0,0,1.20), "Hips")
bone("Spine1", (0,0,1.20), (0,0,1.40), "Spine")
bone("Neck", (0,0,1.40), (0,0,1.54), "Spine1")
bone("Head", (0,0,1.54), (0,0,1.98), "Neck")
for side, label in ((1, "Left"), (-1, "Right")):
    bone(f"{label}Shoulder", (0,0,1.40), (side*0.30,0,1.40), "Spine1")
    bone(f"{label}Arm", (side*0.30,0,1.40), (side*0.65,0,1.40), f"{label}Shoulder")
    bone(f"{label}ForeArm", (side*0.65,0,1.40), (side*0.94,0,1.40), f"{label}Arm")
    bone(f"{label}Hand", (side*0.94,0,1.40), (side*1.16,0,1.40), f"{label}ForeArm")
    bone(f"{label}UpLeg", (side*0.13,0,0.90), (side*0.13,0,0.52), "Hips")
    bone(f"{label}Leg", (side*0.13,0,0.52), (side*0.13,0,0.18), f"{label}UpLeg")
    bone(f"{label}Foot", (side*0.13,0,0.18), (side*0.13,-0.25,0.08), f"{label}Leg")
bpy.ops.object.mode_set(mode="OBJECT")
armature.show_in_front = True

for obj in list(MODEL.objects):
    target = obj.get("rig_bone")
    if not target:
        continue
    world = obj.matrix_world.copy()
    obj.parent = armature
    obj.parent_type = "BONE"
    obj.parent_bone = target
    obj.matrix_world = world

# A real weapon socket, authored in the rig rather than inferred in Three.js.
# Its origin is the centre of the right palm and its local -Z points forward,
# which is the warrant gun's native aiming axis. The game finds this exact node,
# solves it onto the live aim target, and parents the gun beneath it.
weapon_socket = bpy.data.objects.new("WeaponSocket_R", None)
weapon_socket.empty_display_type = "ARROWS"
weapon_socket.empty_display_size = 0.12
RIG.objects.link(weapon_socket)
weapon_socket.parent = armature
weapon_socket.parent_type = "BONE"
weapon_socket.parent_bone = "RightHand"
weapon_socket.matrix_world = Matrix.LocRotScale(
    Vector((-1.00, -0.02, 1.39)),
    Euler((-math.pi / 2, 0, 0)).to_quaternion(),
    Vector((1, 1, 1)),
)


# Retarget the authenticated Mixamo performances to the Inspector armature.
# Each rigid clockwork piece is bone-parented, so no soft-body deformation can
# blur a machined edge: the skeleton moves the same discrete parts the concept
# was built from.
MIXAMO_TARGETS = {
    "Hips": ("Hips",),
    "Spine": ("Spine",),
    "Spine1": ("Spine1", "Spine2"),
    "Neck": ("Neck",),
    "Head": ("Head",),
    "LeftShoulder": ("LeftShoulder",),
    "LeftArm": ("LeftArm",),
    "LeftForeArm": ("LeftForeArm",),
    "LeftHand": ("LeftHand",),
    "RightShoulder": ("RightShoulder",),
    "RightArm": ("RightArm",),
    "RightForeArm": ("RightForeArm",),
    "RightHand": ("RightHand",),
    "LeftUpLeg": ("LeftUpLeg",),
    "LeftLeg": ("LeftLeg",),
    "LeftFoot": ("LeftFoot",),
    "RightUpLeg": ("RightUpLeg",),
    "RightLeg": ("RightLeg",),
    "RightFoot": ("RightFoot",),
}


def source_delta(source_armature: bpy.types.Object, short_name: str) -> Quaternion:
    name = f"mixamorig:{short_name}"
    rest = source_armature.data.bones[name].matrix_local.to_quaternion()
    basis = source_armature.pose.bones[name].matrix_basis.to_quaternion()
    return rest @ basis @ rest.inverted()


def retarget_clip(source_path: Path) -> bpy.types.Action:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=str(source_path), use_anim=True)
    imported = [obj for obj in bpy.data.objects if obj not in before]
    source_armatures = [obj for obj in imported if obj.type == "ARMATURE"]
    if len(source_armatures) != 1:
        raise RuntimeError(f"{source_path.name}: expected one Mixamo armature")
    source_armature = source_armatures[0]
    source_action = source_armature.animation_data.action if source_armature.animation_data else None
    if source_action is None:
        raise RuntimeError(f"{source_path.name}: no Mixamo action")

    start, end = (int(round(value)) for value in source_action.frame_range)
    target_action = bpy.data.actions.new(source_path.stem)
    target_action.use_fake_user = True
    armature.animation_data_create()
    armature.animation_data.action = target_action

    for target_name in MIXAMO_TARGETS:
        pose_bone = armature.pose.bones[target_name]
        pose_bone.rotation_mode = "QUATERNION"

    for source_frame in range(start, end + 1):
        scene.frame_set(source_frame)
        target_frame = source_frame - start + 1
        for target_name, source_names in MIXAMO_TARGETS.items():
            if source_path.stem in {"run", "jump", "climb"} and target_name in GUN_READY_ROTATIONS:
                # Locomotion owns the body and legs, but never throws the gun
                # arm overhead or across the torso. That chain begins in the
                # same restrained ready pose before the runtime IK follows aim.
                target_basis = GUN_READY_ROTATIONS[target_name].copy()
            else:
                combined = Quaternion()
                for source_name in source_names:
                    combined = combined @ source_delta(source_armature, source_name)
                target_rest = arm_data.bones[target_name].matrix_local.to_quaternion()
                target_basis = target_rest.inverted() @ combined @ target_rest
            target_basis.normalize()
            pose_bone = armature.pose.bones[target_name]
            pose_bone.rotation_quaternion = target_basis
            pose_bone.keyframe_insert(
                data_path="rotation_quaternion",
                frame=target_frame,
                group=target_name,
            )

    armature.animation_data.action = None
    for obj in imported:
        bpy.data.objects.remove(obj, do_unlink=True)
    # The glTF exporter scans every action in the file when ACTIONS mode is
    # selected. Remove the imported Mixamo source unconditionally after its
    # armature is gone, otherwise eight dead mixamorig tracks are exported
    # beside the eight retargeted Inspector actions.
    bpy.data.actions.remove(source_action)
    print(f"RETARGETED={source_path.name}:{end - start + 1} frames")
    return target_action


def build_gun_ready_action() -> bpy.types.Action:
    """Bake a restrained two-hand firing stance authored for this body.

    The Mixamo clips labelled rifle-idle and rifle-fire are a stylized lateral
    stretch with one arm overhead and crossed legs. They are valid animations,
    but completely wrong for this character and were the source of the broken
    silhouette seen in game. A tiny IK bake gives the Inspector a stable,
    readable gun stance while the first-person weapon supplies recoil.
    """
    armature.animation_data_create()
    armature.animation_data.action = None
    for pose_bone in armature.pose.bones:
        pose_bone.matrix_basis.identity()

    def target(name: str, location: tuple[float, float, float]) -> bpy.types.Object:
        value = bpy.data.objects.new(name, None)
        value.location = Vector(location)
        RIG.objects.link(value)
        return value

    targets = [
        target("GunReady_RightHand", (-0.10, -0.48, 1.31)),
        target("GunReady_LeftHand", (0.10, -0.58, 1.28)),
        target("GunReady_RightElbow", (-0.56, -0.20, 1.23)),
        target("GunReady_LeftElbow", (0.56, -0.26, 1.18)),
    ]
    for bone_name, hand_target, elbow_target in (
        ("RightHand", targets[0], targets[2]),
        ("LeftHand", targets[1], targets[3]),
    ):
        constraint = armature.pose.bones[bone_name].constraints.new("IK")
        constraint.target = hand_target
        constraint.pole_target = elbow_target
        constraint.chain_count = 3

    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.nla.bake(
        frame_start=1,
        frame_end=2,
        step=1,
        only_selected=True,
        visual_keying=True,
        clear_constraints=True,
        use_current_action=False,
        clean_curves=True,
        bake_types={"POSE"},
        channel_types={"LOCATION", "ROTATION", "SCALE"},
    )
    bpy.ops.object.mode_set(mode="OBJECT")
    action = armature.animation_data.action
    action.name = "rifle-idle"
    action.use_fake_user = True
    armature.animation_data.action = None
    for value in targets:
        bpy.data.objects.remove(value, do_unlink=True)
    return action


gun_ready = build_gun_ready_action()
gun_fire = gun_ready.copy()
gun_fire.name = "rifle-fire"
gun_fire.use_fake_user = True

# Sample the clean authored chain once and use it as the upper-body layer for
# locomotion. This removes the source clip's raised-arm/crossed-body silhouette
# while retaining every lower-body Mixamo key.
armature.animation_data.action = gun_ready
scene.frame_set(1)
bpy.context.view_layer.update()
GUN_READY_ROTATIONS = {
    name: armature.pose.bones[name].matrix_basis.to_quaternion().copy()
    for name in ("RightShoulder", "RightArm", "RightForeArm", "RightHand")
}
armature.animation_data.action = None

ANIMATION_ACTIONS = [gun_ready, gun_fire]
for clip_name in ("idle", "run", "jump", "climb", "hit", "death"):
    source_path = MIXAMO_DIR / f"{clip_name}.fbx"
    if not source_path.exists():
        raise FileNotFoundError(source_path)
    ANIMATION_ACTIONS.append(retarget_clip(source_path))

scene.frame_start = 1
scene.frame_end = max(int(action.frame_range[1]) for action in ANIMATION_ACTIONS)
scene.render.fps = 30
scene.frame_set(1)

# Presentation stage and camera for a concrete visual QA artifact.
bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, -0.005))
floor = bpy.context.object
floor.name = "PreviewFloor"
floor.data.materials.append(material("Preview Floor", (0.018,0.021,0.027,1), roughness=0.55))
move_to_collection(floor, PRESENTATION)

world = bpy.data.worlds.new("Inspector Preview World") if bpy.data.worlds.get("Inspector Preview World") is None else bpy.data.worlds["Inspector Preview World"]
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.012,0.016,0.024,1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.28

def area(name, location, energy, color, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.color, data.shape, data.size = energy, color, "DISK", size
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    direction = Vector((0,0,1.05)) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    PRESENTATION.objects.link(obj)

area("Warm Key", (-3,-4,4), 900, (1.0,0.58,0.32), 3.0)
area("Cool Fill", (3,-2,2.4), 700, (0.25,0.65,1.0), 2.5)
area("Brass Rim", (0,2.5,3.2), 850, (1.0,0.35,0.10), 2.0)

camera_data = bpy.data.cameras.new("InspectorPreviewCamera")
camera = bpy.data.objects.new("InspectorPreviewCamera", camera_data)
PRESENTATION.objects.link(camera)
camera.location = (2.75, -5.2, 2.15)
camera.rotation_euler = (Vector((0,0,1.0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.lens = 68
scene.camera = camera

# Save the editable master before selective exports.
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE_DIR / "inspector-curator.blend"))

# Unrigged authored FBX for Mixamo. All rigid mesh pieces are accepted as one character file.
bpy.ops.object.select_all(action="DESELECT")
for obj in MODEL.objects:
    if obj.type in {"MESH", "CURVE"}:
        obj.select_set(True)
bpy.ops.export_scene.fbx(filepath=str(SOURCE_DIR / "inspector-mixamo-source.fbx"),
                         use_selection=True, object_types={"MESH"},
                         apply_unit_scale=True, bake_anim=False, add_leaf_bones=False,
                         path_mode="COPY", embed_textures=True)

# Game GLB includes the authored armature and material-rich model, not preview objects.
bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
weapon_socket.select_set(True)
for obj in MODEL.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.export_scene.gltf(filepath=str(GAME_DIR / "inspector-curator.glb"),
                          export_format="GLB", use_selection=True,
                          export_yup=True, export_apply=False,
                          export_animations=True, export_animation_mode="ACTIONS",
                          export_anim_single_armature=True, export_force_sampling=True,
                          export_materials="EXPORT")

scene.render.filepath = str(PREVIEW_DIR / "inspector-curator-preview.png")
scene.render.film_transparent = False
bpy.ops.render.render(write_still=True)

print(f"BLEND={SOURCE_DIR / 'inspector-curator.blend'}")
print(f"FBX={SOURCE_DIR / 'inspector-mixamo-source.fbx'}")
print(f"GLB={GAME_DIR / 'inspector-curator.glb'}")
print(f"PREVIEW={PREVIEW_DIR / 'inspector-curator-preview.png'}")
