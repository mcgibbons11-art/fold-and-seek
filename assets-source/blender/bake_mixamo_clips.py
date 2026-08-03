"""Bake Mixamo FBXs into compact, runtime-native quaternion clips."""

from __future__ import annotations

import json
import argparse
import hashlib
import math
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion


ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "assets-source" / "mixamo" / "raw"
OUTPUT = ROOT / "apps" / "client" / "src" / "forge" / "mixamoClips.generated.ts"
MANIFEST = ROOT / "assets-source" / "mixamo" / "manifest.json"

TARGETS: list[tuple[str, tuple[str, ...]]] = [
    ("pelvis", ("Hips",)),
    ("torso_lower", ("Spine",)),
    ("torso_upper", ("Spine1", "Spine2")),
    ("neck", ("Neck",)),
    ("head", ("Head",)),
    ("shoulder_L", ("LeftShoulder",)),
    ("upperarm_L", ("LeftArm",)),
    ("forearm_L", ("LeftForeArm",)),
    ("hand_L", ("LeftHand",)),
    ("shoulder_R", ("RightShoulder",)),
    ("upperarm_R", ("RightArm",)),
    ("forearm_R", ("RightForeArm",)),
    ("hand_R", ("RightHand",)),
    ("thigh_L", ("LeftUpLeg",)),
    ("shin_L", ("LeftLeg",)),
    ("foot_L", ("LeftFoot",)),
    ("thigh_R", ("RightUpLeg",)),
    ("shin_R", ("RightLeg",)),
    ("foot_R", ("RightFoot",)),
]

LOOPS = {"idle", "run", "climb", "rifle-idle"}
BLENDER_TO_GAME = Quaternion((1.0, 0.0, 0.0), math.pi / 2)


def rounded(q: Quaternion) -> list[float]:
    q.normalize()
    if q.w < 0:
        q = Quaternion((-q.w, -q.x, -q.y, -q.z))
    values = (q.x, q.y, q.z, q.w)
    return [0.0 if abs(value) < 0.000005 else round(value, 5) for value in values]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_inputs(allow_unverified: bool) -> dict:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    expected = {entry["file"]: entry for entry in manifest["inputs"]}
    actual = {path.name for path in RAW.glob("*.fbx")}
    if actual != set(expected):
        raise RuntimeError(f"Mixamo inputs differ from manifest: expected={sorted(expected)}, actual={sorted(actual)}")
    for name, entry in expected.items():
        path = RAW / name
        if path.stat().st_size != entry["bytes"] or sha256(path) != entry["sha256"]:
            raise RuntimeError(f"{name}: content does not match the verified manifest hash")
    if manifest["license"]["status"] != "verified" and not allow_unverified:
        raise RuntimeError(
            "Mixamo source license/provenance is not verified for redistribution; "
            "verification succeeded, but baking requires --allow-unverified-local-inputs"
        )
    return manifest


def bone_delta(armature: bpy.types.Object, short_name: str) -> Quaternion:
    name = f"mixamorig:{short_name}"
    pose_bone = armature.pose.bones[name]
    rest = armature.data.bones[name].matrix_local.to_quaternion()
    basis = pose_bone.matrix_basis.to_quaternion()
    # Express Mixamo's bone-local basis rotation in Blender armature axes,
    # then rotate those axes into the game's +Y-up, +Z-forward convention.
    delta = rest @ basis @ rest.inverted()
    return BLENDER_TO_GAME @ delta @ BLENDER_TO_GAME.inverted()


parser = argparse.ArgumentParser()
parser.add_argument("--verify-only", action="store_true")
parser.add_argument("--allow-unverified-local-inputs", action="store_true")
script_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
args = parser.parse_args(script_args)
verify_inputs(args.allow_unverified_local_inputs or args.verify_only)
if args.verify_only:
    print(f"VERIFIED {MANIFEST}")
    raise SystemExit(0)


clips: dict[str, dict] = {}
for source in sorted(RAW.glob("*.fbx")):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(source), use_anim=True)
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"{source.name}: expected one armature, got {len(armatures)}")
    armature = armatures[0]
    action = armature.animation_data.action if armature.animation_data else None
    if action is None:
        raise RuntimeError(f"{source.name}: no active action")
    start, end = (int(round(value)) for value in action.frame_range)
    frames: list[list[float]] = []
    references: list[Quaternion] = []
    for frame in range(start, end + 1):
        bpy.context.scene.frame_set(frame)
        values: list[float] = []
        for slot, (_target, sources) in enumerate(TARGETS):
            combined = Quaternion()
            for short_name in sources:
                combined = combined @ bone_delta(armature, short_name)
            if frame == start:
                references.append(combined.copy())
            # The Mimic's authored pose is the rest basis. A Mixamo action's
            # first frame is therefore a reference, not an absolute pose to
            # stack on top of it. Rebasing here makes every frame-0 delta the
            # identity and preserves only the action's motion.
            rebased = combined @ references[slot].inverted()
            values.extend(rounded(rebased))
        frames.append(values)
    clips[source.stem] = {
        "fps": 30,
        "loop": source.stem in LOOPS,
        "frames": frames,
    }

header = """/**
 * Generated from the authenticated Mixamo FBXs in assets-source/mixamo/raw.
 * Regenerate with assets-source/blender/bake_mixamo_clips.py; do not hand-edit.
 */
export interface MixamoClipData {
  readonly fps: number;
  readonly loop: boolean;
  /** Frames are packed x/y/z/w quaternions in MIXAMO_BONE_NAMES order. */
  readonly frames: readonly (readonly number[])[];
}

"""
bone_names = "export const MIXAMO_BONE_NAMES = " + json.dumps([name for name, _ in TARGETS]) + " as const;\n\n"
clip_type = "export type MixamoClipName = " + " | ".join(json.dumps(name) for name in clips) + ";\n\n"
payload = "export const MIXAMO_CLIPS: Readonly<Record<MixamoClipName, MixamoClipData>> = " + json.dumps(clips, separators=(",", ":")) + ";\n"
OUTPUT.write_text(header + bone_names + clip_type + payload, encoding="utf-8")
print(f"WROTE {OUTPUT} ({OUTPUT.stat().st_size} bytes, {sum(len(clip['frames']) for clip in clips.values())} frames)")
