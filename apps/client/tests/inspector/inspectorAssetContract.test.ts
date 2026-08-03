import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INSPECTOR_ASSET_SHA256 } from "../../src/inspector/InspectorAvatar";

interface GltfAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: "SCALAR" | "VEC3" | "VEC4";
}

interface GltfJson {
  scene?: number;
  scenes: Array<{ nodes?: number[] }>;
  nodes: Array<{ name?: string }>;
  skins?: unknown[];
  meshes?: unknown[];
  bufferViews: Array<{ byteOffset?: number; byteStride?: number }>;
  accessors: GltfAccessor[];
  animations: Array<{
    name?: string;
    channels: Array<{ sampler: number; target: { path: string } }>;
    samplers: Array<{ output: number }>;
  }>;
}

const assetPath = fileURLToPath(
  new URL("../../public/assets/characters/inspector-curator.glb", import.meta.url),
);
const portalsAssetPath = fileURLToPath(
  new URL("../../../../portals/assets/characters/inspector-curator.glb", import.meta.url),
);

function parseGlb(): { bytes: Buffer; json: GltfJson; binary: Buffer } {
  const bytes = readFileSync(assetPath);
  expect(bytes.toString("ascii", 0, 4)).toBe("glTF");
  expect(bytes.readUInt32LE(4)).toBe(2);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).replace(/\0+$/u, "")) as GltfJson;
  const binaryHeader = 20 + jsonLength;
  const binaryLength = bytes.readUInt32LE(binaryHeader);
  return {
    bytes,
    json,
    binary: bytes.subarray(binaryHeader + 8, binaryHeader + 8 + binaryLength),
  };
}

function accessorValues(json: GltfJson, binary: Buffer, index: number): number[][] {
  const accessor = json.accessors[index]!;
  expect(accessor.componentType).toBe(5126);
  const view = json.bufferViews[accessor.bufferView]!;
  const components = accessor.type === "SCALAR" ? 1 : accessor.type === "VEC3" ? 3 : 4;
  const stride = view.byteStride ?? components * 4;
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, row) =>
    Array.from({ length: components }, (_, component) =>
      binary.readFloatLE(offset + row * stride + component * 4),
    ),
  );
}

describe("authored Inspector GLB contract", () => {
  it("matches the runtime cache identity and required rig surface", () => {
    const { bytes, json } = parseGlb();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(INSPECTOR_ASSET_SHA256);
    expect(createHash("sha256").update(readFileSync(portalsAssetPath)).digest("hex")).toBe(
      INSPECTOR_ASSET_SHA256,
    );
    expect(json.skins).toHaveLength(1);
    expect(json.meshes?.length).toBeGreaterThan(0);

    const names = new Set(json.nodes.map((node) => node.name));
    for (const bone of ["RightArm", "RightForeArm", "RightHand"]) expect(names.has(bone), bone).toBe(true);
    const clips = new Set(json.animations.map((animation) => animation.name));
    for (const clip of ["rifle-idle", "run", "jump", "climb", "rifle-fire", "hit", "death"]) {
      expect(clips.has(clip), clip).toBe(true);
    }
  });

  it("contains only finite animation output and closes every runtime loop within two degrees", () => {
    const { json, binary } = parseGlb();
    for (const animation of json.animations) {
      for (const sampler of animation.samplers) {
        for (const row of accessorValues(json, binary, sampler.output)) {
          expect(row.every(Number.isFinite), `${animation.name} contains a non-finite key`).toBe(true);
        }
      }
    }

    for (const name of ["run", "climb", "rifle-idle"]) {
      const animation = json.animations.find((candidate) => candidate.name === name)!;
      let worstDegrees = 0;
      for (const channel of animation.channels) {
        if (channel.target.path !== "rotation") continue;
        const values = accessorValues(json, binary, animation.samplers[channel.sampler]!.output);
        const first = values[0]!;
        const last = values.at(-1)!;
        const dot = Math.min(1, Math.abs(first.reduce((sum, value, i) => sum + value * last[i]!, 0)));
        worstDegrees = Math.max(worstDegrees, (2 * Math.acos(dot) * 180) / Math.PI);
      }
      expect(worstDegrees, `${name} loop seam`).toBeLessThan(2);
    }
  });
});
