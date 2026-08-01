import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { Eyedropper } from "../../src/paint/Eyedropper";
import { PaintLayer } from "../../src/paint/PaintLayer";
import { paintTileTransform } from "../../src/paint/paintTargets";

/**
 * The eyedropper has to answer with the colour the player saw, so these check
 * the two paths that produce it: a plain material, and a material whose map
 * covers it. The tinted case is the one worth pinning down, because multiplying
 * texel by colour anywhere other than in linear light gives a colour that is
 * close enough to look right and wrong enough to miss a match.
 */

function makeEyedropper(
  getPixelSource?: (texture: THREE.Texture) => { width: number; height: number; data: Uint8ClampedArray } | null,
): Eyedropper {
  return new Eyedropper({
    raycaster: new THREE.Raycaster(),
    camera: new THREE.PerspectiveCamera(),
    ...(getPixelSource === undefined ? {} : { getPixelSource }),
  });
}

function intersectionOn(mesh: THREE.Mesh, u: number, v: number): THREE.Intersection {
  return {
    distance: 1,
    point: new THREE.Vector3(),
    object: mesh,
    uv: new THREE.Vector2(u, v),
  } as THREE.Intersection;
}

/** A two-by-two texture: red, green on the first row, blue, grey on the second. */
function checkerTexture(): THREE.DataTexture {
  const data = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 128, 128, 128, 255,
  ]);
  const texture = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

describe("eyedropper on a solid material", () => {
  it("returns the material's own colour in sRGB", () => {
    const material = new THREE.MeshStandardMaterial();
    material.color.setRGB(0.2, 0.4, 0.6, THREE.SRGBColorSpace);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);

    const sample = makeEyedropper().sampleIntersection(intersectionOn(mesh, 0.5, 0.5));
    expect(sample).not.toBeNull();
    expect(sample?.color[0]).toBeCloseTo(0.2, 4);
    expect(sample?.color[1]).toBeCloseTo(0.4, 4);
    expect(sample?.color[2]).toBeCloseTo(0.6, 4);
  });

  it("reads the material a face names on a multi-material mesh", () => {
    const first = new THREE.MeshStandardMaterial();
    first.color.setRGB(1, 0, 0, THREE.SRGBColorSpace);
    const second = new THREE.MeshStandardMaterial();
    second.color.setRGB(0, 0, 1, THREE.SRGBColorSpace);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), [first, second]);

    const hit = intersectionOn(mesh, 0.5, 0.5);
    const sample = makeEyedropper().sampleIntersection({
      ...hit,
      face: { a: 0, b: 1, c: 2, normal: new THREE.Vector3(), materialIndex: 1 },
    } as THREE.Intersection);
    expect(sample?.color[2]).toBeCloseTo(1, 4);
    expect(sample?.color[0]).toBeCloseTo(0, 4);
  });

  it("returns nothing for an object with no colour to give", () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.Material());
    const bare = new THREE.Object3D();
    expect(makeEyedropper().sampleIntersection(intersectionOn(mesh, 0.5, 0.5))).toBeNull();
    expect(
      makeEyedropper().sampleIntersection({
        distance: 1,
        point: new THREE.Vector3(),
        object: bare,
      } as THREE.Intersection),
    ).toBeNull();
  });
});

describe("eyedropper on a textured material", () => {
  it("samples the texel under the hit", () => {
    const material = new THREE.MeshStandardMaterial({ map: checkerTexture() });
    material.color.setRGB(1, 1, 1, THREE.SRGBColorSpace);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    const eyedropper = makeEyedropper();

    // A data texture is not flipped, so v = 0.25 is the first row.
    const red = eyedropper.sampleIntersection(intersectionOn(mesh, 0.25, 0.25));
    expect(red?.color[0]).toBeCloseTo(1, 3);
    expect(red?.color[1]).toBeCloseTo(0, 3);

    const green = eyedropper.sampleIntersection(intersectionOn(mesh, 0.75, 0.25));
    expect(green?.color[1]).toBeCloseTo(1, 3);
    expect(green?.color[0]).toBeCloseTo(0, 3);

    const blue = eyedropper.sampleIntersection(intersectionOn(mesh, 0.25, 0.75));
    expect(blue?.color[2]).toBeCloseTo(1, 3);
  });

  it("multiplies texel by material colour in linear light", () => {
    const texture = checkerTexture();
    const material = new THREE.MeshStandardMaterial({ map: texture });
    material.color.setRGB(0.5, 0.5, 0.5, THREE.SRGBColorSpace);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);

    const sample = makeEyedropper().sampleIntersection(intersectionOn(mesh, 0.25, 0.25));
    // Half-grey times full red: 0.5 sRGB is 0.2140 linear, and squaring that
    // and coming back gives 0.2368, not the 0.25 a naive sRGB multiply gives.
    expect(sample?.color[0]).toBeCloseTo(0.5, 2);
    const bothHalf = makeEyedropper().sampleIntersection(intersectionOn(mesh, 0.75, 0.75));
    expect(bothHalf?.color[0]).toBeCloseTo(0.2368, 2);
  });

  it("honours the texture's own offset, repeat and flip", () => {
    const texture = checkerTexture();
    texture.offset.set(0.5, 0);
    texture.repeat.set(0.5, 0.5);
    const material = new THREE.MeshStandardMaterial({ map: texture });
    material.color.setRGB(1, 1, 1, THREE.SRGBColorSpace);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);

    // uv (0.5, 0.5) transforms to (0.75, 0.25): the green texel.
    const sample = makeEyedropper().sampleIntersection(intersectionOn(mesh, 0.5, 0.5));
    expect(sample?.color[1]).toBeCloseTo(1, 3);
    expect(sample?.color[0]).toBeCloseTo(0, 3);
  });

  it("falls back to the material colour when the map cannot be read", () => {
    const texture = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ map: texture });
    material.color.setRGB(0.3, 0.6, 0.9, THREE.SRGBColorSpace);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);

    const sample = makeEyedropper().sampleIntersection(intersectionOn(mesh, 0.5, 0.5));
    expect(sample?.color[0]).toBeCloseTo(0.3, 4);
    expect(sample?.color[2]).toBeCloseTo(0.9, 4);
  });
});

describe("eyedropper on the painter's own body", () => {
  it("reads back paint that was just applied", () => {
    const atlas = 256;
    const target = 5;
    const layer = new PaintLayer({ atlasSize: atlas, canvas: null });
    layer.applyStroke({
      segmentId: target,
      uv: [0.5, 0.5],
      radius: 0.3,
      color: [0.9, 0.1, 0.1],
      opacity: 1,
      kind: "brush",
    });

    // Stands in for the tile view the material binder hangs on the body: same
    // transform, same flip, and the live pixel buffer behind it.
    const transform = paintTileTransform(target);
    const view = new THREE.Texture();
    view.image = layer.pixelSource();
    view.colorSpace = THREE.SRGBColorSpace;
    view.flipY = true;
    view.offset.set(transform.offsetU, transform.offsetV);
    view.repeat.set(transform.repeatU, transform.repeatV);

    const material = new THREE.MeshStandardMaterial({ map: view });
    material.color.setRGB(1, 1, 1, THREE.SRGBColorSpace);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    const eyedropper = makeEyedropper((texture) =>
      texture === view ? layer.pixelSource() : null,
    );

    // The brush is soft, so the centre is within a few units of the stroke
    // colour rather than exactly it.
    const painted = eyedropper.sampleIntersection(intersectionOn(mesh, 0.5, 0.5));
    expect(painted?.color[0]).toBeCloseTo(0.9, 1);
    expect(painted?.color[1]).toBeLessThan(0.2);
    expect(painted?.color[2]).toBeLessThan(0.2);

    // A cached read-back would still be showing the old colour here.
    layer.applyStroke({
      segmentId: target,
      uv: [0.5, 0.5],
      radius: 0.3,
      color: [0.1, 0.1, 0.9],
      opacity: 1,
      kind: "brush",
    });
    const repainted = eyedropper.sampleIntersection(intersectionOn(mesh, 0.5, 0.5));
    expect(repainted?.color[2]).toBeCloseTo(0.9, 1);
    expect(repainted?.color[0]).toBeLessThan(0.2);
  });
});

describe("eyedropper picking", () => {
  it("samples what the pointer is over", () => {
    const material = new THREE.MeshStandardMaterial();
    material.color.setRGB(0.8, 0.2, 0.1, THREE.SRGBColorSpace);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), material);
    mesh.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    const eyedropper = new Eyedropper({ raycaster: new THREE.Raycaster(), camera });
    const hit = eyedropper.sample(new THREE.Vector2(0, 0), [mesh]);
    expect(hit?.object).toBe(mesh);
    expect(hit?.color[0]).toBeCloseTo(0.8, 4);

    expect(eyedropper.sample(new THREE.Vector2(0.99, 0.99), [mesh])).toBeNull();
  });
});
