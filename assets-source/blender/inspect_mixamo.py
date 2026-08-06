"""Print structural validation for every downloaded Mixamo FBX."""

from pathlib import Path
import bpy

root = Path(__file__).resolve().parents[2]
for source in sorted((root / "assets-source" / "mixamo" / "raw").glob("*.fbx")):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(source), use_anim=True)
    arms = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    actions = list(bpy.data.actions)
    bones = list(arms[0].data.bones.keys()) if arms else []
    curves = 0
    slots = 0
    for action in actions:
        slots += len(action.slots)
        for layer in action.layers:
            for strip in layer.strips:
                if hasattr(strip, "channelbag"):
                    bag = strip.channelbag(action.slots[0]) if action.slots else None
                    curves += len(bag.fcurves) if bag else 0
    print(
        f"MIXAMO {source.stem}: armatures={len(arms)} bones={len(bones)} "
        f"actions={len(actions)} slots={slots} curves={curves} "
        f"frames={[tuple(round(v, 2) for v in action.frame_range) for action in actions]} "
        f"sample={bones[:8]}"
    )
