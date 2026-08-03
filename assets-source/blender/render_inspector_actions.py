"""Render selected Inspector action frames for retarget QA."""

from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "assets-source" / "blender" / "inspector-curator.blend"
OUTPUT = ROOT / "assets-source" / "previews"

bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
rig = bpy.data.objects["Inspector_Rig"]
rig.animation_data_create()

for action_name, fraction, tag in (
    ("rifle-idle", 0.35, "rifle-idle"),
    ("rifle-fire", 0.0, "rifle-fire-start"),
    ("rifle-fire", 0.5, "rifle-fire-mid"),
    ("run", 0.35, "run"),
    ("death", 0.7, "death"),
):
    action = bpy.data.actions[action_name]
    rig.animation_data.action = action
    start, end = action.frame_range
    bpy.context.scene.frame_set(round(start + (end - start) * fraction))
    bpy.context.scene.render.filepath = str(OUTPUT / f"inspector-{tag}-audit.png")
    bpy.ops.render.render(write_still=True)
    print(f"RENDERED={action_name}:{bpy.context.scene.frame_current}")
