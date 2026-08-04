import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  GRAPPLE_CLAW_ASSET_SHA256,
  GRAPPLE_DEPLOY_SECONDS,
  GRAPPLE_LAUNCHER_ASSET_SHA256,
  GrappleVisual,
} from "../../src/inspector/GrappleVisual";

interface GltfJson {
  readonly nodes: ReadonlyArray<{ readonly name?: string }>;
  readonly animations?: ReadonlyArray<{ readonly name?: string }>;
}

function parseGlb(relativePath: string): { readonly bytes: Buffer; readonly json: GltfJson } {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  const bytes = readFileSync(path);
  expect(bytes.toString("ascii", 0, 4)).toBe("glTF");
  expect(bytes.readUInt32LE(4)).toBe(2);
  const jsonLength = bytes.readUInt32LE(12);
  return {
    bytes,
    json: JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).replace(/\0+$/u, "")) as GltfJson,
  };
}

describe("authored claw-machine grapple", () => {
  it("ships hash-addressed Blender launcher and claw assets with their actions", () => {
    const launcher = parseGlb("../../public/assets/models/gameplay/grapple-launcher.glb");
    const claw = parseGlb("../../public/assets/models/gameplay/grapple-claw.glb");
    expect(createHash("sha256").update(launcher.bytes).digest("hex")).toBe(GRAPPLE_LAUNCHER_ASSET_SHA256);
    expect(createHash("sha256").update(claw.bytes).digest("hex")).toBe(GRAPPLE_CLAW_ASSET_SHA256);
    expect(launcher.json.nodes.some((node) => node.name?.includes("Launcher_Drum"))).toBe(true);
    expect(claw.json.nodes.filter((node) => node.name?.includes("Claw_JawPivot_"))).toHaveLength(3);
    expect(launcher.json.animations?.some((clip) => clip.name?.startsWith("Fire"))).toBe(true);
    expect(claw.json.animations?.some((clip) => clip.name?.startsWith("Latch"))).toBe(true);
  });

  it("grows the cable and moves its claw to the latch instead of teleporting it", async () => {
    const parent = new THREE.Group();
    const visual = new GrappleVisual(parent);
    expect(await visual.authoredReady).toBe(false);
    visual.update({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, GRAPPLE_DEPLOY_SECONDS / 2);

    const root = parent.getObjectByName("mechanical-claw-grapple");
    const claw = parent.getObjectByName("grapple-three-jaw-claw");
    expect(root?.visible).toBe(true);
    expect(claw?.position.x).toBeGreaterThan(1);
    expect(claw?.position.x).toBeLessThan(2);

    visual.update({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, GRAPPLE_DEPLOY_SECONDS);
    expect(claw?.position.x).toBeCloseTo(2, 6);
    visual.update({ x: 0, y: 0, z: 0 }, null);
    expect(root?.visible).toBe(false);
    visual.dispose();
    expect(parent.getObjectByName("mechanical-claw-grapple")).toBeUndefined();
  });
});
