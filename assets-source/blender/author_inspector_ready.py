"""Prototype and render a restrained Inspector gun-ready pose."""

from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
bpy.ops.wm.open_mainfile(
    filepath=str(ROOT / "assets-source" / "blender" / "inspector-curator.blend")
)
scene = bpy.context.scene
rig = bpy.data.objects["Inspector_Rig"]
rig.animation_data_create()
rig.animation_data.action = None

for pose_bone in rig.pose.bones:
    pose_bone.matrix_basis.identity()


def target(name: str, location: tuple[float, float, float]):
    value = bpy.data.objects.new(name, None)
    value.location = Vector(location)
    scene.collection.objects.link(value)
    return value


# Character faces -Y. The firing hand sits at the stock and the support hand
# reaches a little farther down the barrel; elbows stay wide enough to keep the
# colorful shoulder shells out of the torso.
right_hand = target("RightHandTarget", (-0.10, -0.48, 1.31))
left_hand = target("LeftHandTarget", (0.10, -0.58, 1.28))
right_elbow = target("RightElbowPole", (-0.56, -0.20, 1.23))
left_elbow = target("LeftElbowPole", (0.56, -0.26, 1.18))

for bone_name, hand_target, elbow_target in (
    ("RightHand", right_hand, right_elbow),
    ("LeftHand", left_hand, left_elbow),
):
    constraint = rig.pose.bones[bone_name].constraints.new("IK")
    constraint.name = "GunReadyIK"
    constraint.target = hand_target
    constraint.pole_target = elbow_target
    constraint.chain_count = 3

bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.select_all(action="SELECT")
scene.frame_start = 1
scene.frame_end = 60
bpy.ops.nla.bake(
    frame_start=1,
    frame_end=60,
    step=60,
    only_selected=True,
    visual_keying=True,
    clear_constraints=True,
    use_current_action=False,
    clean_curves=True,
    bake_types={"POSE"},
    channel_types={"LOCATION", "ROTATION", "SCALE"},
)
bpy.ops.object.mode_set(mode="OBJECT")
action = rig.animation_data.action
action.name = "gun-ready"
scene.frame_set(30)
scene.render.filepath = str(
    ROOT / "assets-source" / "previews" / "inspector-gun-ready-audit.png"
)
bpy.ops.render.render(write_still=True)
print(f"ACTION={action.name}:{tuple(action.frame_range)}")

