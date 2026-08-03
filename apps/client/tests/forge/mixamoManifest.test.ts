import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface InputRecord {
  file: string;
  bytes: number;
  sha256: string;
}

interface MixamoManifest {
  version: number;
  license: { status: string };
  visualIdentity: { id: string; runtime: string; editableMasterSha256: string };
  inputs: InputRecord[];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MANIFEST_PATH = resolve(REPO_ROOT, "assets-source/mixamo/manifest.json");
const RAW_ROOT = resolve(REPO_ROOT, "assets-source/mixamo/raw");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as MixamoManifest;

describe("Mixamo bake provenance", () => {
  it("pins every expected input and the reshapeable Hider visual identity", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.license.status).toBe("requires_verification");
    expect(manifest.visualIdentity).toMatchObject({
      id: "mimic-hider-forge-v2",
      runtime: "MimicVisual",
    });
    expect(manifest.visualIdentity.editableMasterSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.inputs.map((entry) => entry.file)).toEqual([
      "climb.fbx",
      "death.fbx",
      "hit.fbx",
      "idle.fbx",
      "jump.fbx",
      "rifle-fire.fbx",
      "rifle-idle.fbx",
      "run.fbx",
      "taunt.fbx",
    ]);
    expect(new Set(manifest.inputs.map((entry) => entry.sha256)).size).toBe(manifest.inputs.length);
  });

  it("matches any quarantined local inputs byte-for-byte without requiring them in CI", () => {
    for (const entry of manifest.inputs) {
      const path = resolve(RAW_ROOT, entry.file);
      if (!existsSync(path)) continue;
      expect(statSync(path).size, entry.file).toBe(entry.bytes);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex"), entry.file).toBe(
        entry.sha256,
      );
    }
  });
});
