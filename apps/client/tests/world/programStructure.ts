import * as THREE from "three/webgpu";

/**
 * What makes two drawables need two different shader programs.
 *
 * A program in three r185's node system is keyed on the generated shader
 * SOURCE, not on the material object: `Pipelines.getForRender` looks a stage up
 * by `nodeBuilderState.vertexShader` / `.fragmentShader` as strings, and the
 * WebGL fallback's `getRenderCacheKey` returns the empty string, so the pipeline
 * cache key is nothing but the pair of stage ids. Two materials whose node
 * graphs generate the same text therefore cost ONE link between them, however
 * many material objects and however many meshes there are.
 *
 * This key is the list of properties that reach code generation, read out of
 * three r185's own sources; the line references are the audit. A value that
 * feeds a uniform is deliberately absent, because a uniform is the same text at
 * every value: `metalness: 0` and `metalness: 0.92` are one program, which is
 * why counting materials, or counting three's own material cache key, both
 * overstate the link count badly. (Three's `RenderObject.getMaterialCacheKey`
 * additionally folds in every InstancedMesh's own uuid and the presence of an
 * index buffer, neither of which changes a character of the shader.)
 *
 * It is an estimate in one direction only: an axis omitted here merges two
 * structures that really are distinct, so the census can UNDER-count. It cannot
 * over-count, because every axis listed is a branch in the generator.
 */

/** Texture slots whose mere presence adds a fetch to the generated shader. */
const MAP_SLOTS = [
  // MaterialNode.js:126,140,152,194,208,223,235,246 — colour, alpha, specular,
  // roughness, metalness, emissive, normal and bump all branch on the slot.
  "map",
  "alphaMap",
  "specularMap",
  "roughnessMap",
  "metalnessMap",
  "emissiveMap",
  "normalMap",
  "bumpMap",
  // MaterialNode.js:260,274,286,300,314,328,345,361,375,391,403
  "clearcoatMap",
  "clearcoatRoughnessMap",
  "clearcoatNormalMap",
  "sheenColorMap",
  "sheenRoughnessMap",
  "anisotropyMap",
  "iridescenceMap",
  "iridescenceThicknessMap",
  "transmissionMap",
  "thicknessMap",
  "lightMap",
  "aoMap",
  // NodeMaterial.js:780 — displacement is read in the vertex stage.
  "displacementMap",
  // NodeMaterial.js:951/955 — an env map replaces the scene's environment node.
  "envMap",
] as const;

/**
 * `MeshPhysicalNodeMaterial` gates each lobe on a `use*` getter, and every one
 * of them is `this.<name> > 0` (lines 279-341). The classic material the map
 * builds carries the value but not the getter, because the node material is
 * created from it at build time, so the threshold is applied here instead.
 * Reading the getter off a `MeshPhysicalMaterial` silently returns undefined,
 * which is how an earlier draft of this census merged the glazes with the
 * fabrics.
 */
const PHYSICAL_FEATURES = [
  "clearcoat",
  "iridescence",
  "sheen",
  "anisotropy",
  "transmission",
  "dispersion",
] as const;

type Slot = (typeof MAP_SLOTS)[number];

function flag(condition: boolean): string {
  return condition ? "1" : "0";
}

/**
 * The generated-source identity of one drawable.
 *
 * Returned as a readable string rather than a hash so a census can say what
 * separates two structures, which is the only way to act on the count.
 */
export function programStructureKey(object: THREE.Object3D, scene: THREE.Scene): string {
  const mesh = object as THREE.Mesh;
  const material = mesh.material as THREE.Material & Record<string, unknown>;
  const geometry = mesh.geometry;
  const parts: string[] = [];

  // The material class decides the lighting model outright.
  parts.push(material.type);

  // NodeBuilder.js:510 — flat shading, or a geometry with no normals at all.
  parts.push(`flat:${flag(material.flatShading === true || geometry.hasAttribute("normal") === false)}`);
  // FrontFacingNode.js:46,93 — BackSide folds the branch away, DoubleSide keeps it.
  parts.push(`side:${String(material.side)}`);
  // NodeBuilder.js:519 — an opaque material has its alpha assigned a constant.
  parts.push(
    `opaque:${flag(material.transparent === false && material.blending === THREE.NormalBlending && material.alphaToCoverage === false)}`,
  );
  // NodeMaterial.js:871,890,1196 — alpha test, alpha hash and premultiplied alpha.
  parts.push(`alphaTest:${flag(material.alphaTest > 0)}`);
  parts.push(`alphaHash:${flag(material.alphaHash === true)}`);
  parts.push(`premul:${flag(material.premultipliedAlpha === true)}`);
  // NodeMaterial.js:1188 — fog is only generated when the scene actually has one.
  parts.push(`fog:${flag(material.fog === true && scene.fog !== null)}`);
  parts.push(`wireframe:${flag(material.wireframe === true)}`);
  // NodeMaterial.js:507 — the depth branch.
  parts.push(`depth:${flag(material.depthWrite === true || material.depthTest === true)}`);

  // NodeMaterial.js:838 — vertex colours need BOTH the flag and the attribute.
  parts.push(`vcol:${flag(material.vertexColors === true && geometry.hasAttribute("color"))}`);

  for (const slot of MAP_SLOTS) {
    const texture = material[slot as Slot] as THREE.Texture | null | undefined;
    if (texture !== null && texture !== undefined) {
      parts.push(`+${slot}`);
      // MaterialNode.js:240 — a two-channel normal map is reconstructed rather
      // than read, which is a different expression.
      if (slot === "normalMap") {
        parts.push(`normalFormat:${String(texture.format)}`);
      }
    }
  }

  for (const feature of PHYSICAL_FEATURES) {
    const value = material[feature];
    if (typeof value === "number" && value > 0) {
      parts.push(`+use${feature}`);
    }
  }

  // Per-object vertex stage branches. NodeMaterial.js:774,796 and
  // setupDiffuseColor's instance/batch colour branches at 846,852.
  const instanced = mesh as THREE.Object3D & {
    isInstancedMesh?: boolean;
    isSkinnedMesh?: boolean;
    isBatchedMesh?: boolean;
    instanceColor?: unknown;
  };
  parts.push(`skinned:${flag(instanced.isSkinnedMesh === true)}`);
  parts.push(`instanced:${flag(instanced.isInstancedMesh === true)}`);
  parts.push(`instanceColor:${flag(instanced.instanceColor !== null && instanced.instanceColor !== undefined)}`);
  parts.push(`batched:${flag(instanced.isBatchedMesh === true)}`);
  parts.push(`morph:${Object.keys(geometry.morphAttributes).sort().join("/")}`);
  // Shadow sampling is generated per object, and it is in three's own cache key
  // twice over (RenderObject.js:842 and the dynamic key at 935).
  parts.push(`recvShadow:${flag(mesh.receiveShadow === true)}`);

  // Vertex inputs are declared from the attributes the geometry actually has.
  parts.push(`attrs:${Object.keys(geometry.attributes).sort().join("/")}`);

  return parts.join(" ");
}

/** One-line human summary of a drawable, for reading a census table. */
export function describeStructure(object: THREE.Object3D): string {
  const mesh = object as THREE.Mesh;
  const material = mesh.material as THREE.Material;
  const kind = (mesh as THREE.Object3D & { isInstancedMesh?: boolean }).isInstancedMesh === true ? "instanced" : "mesh";
  return `${kind} ${material.type} "${material.name}"`;
}
