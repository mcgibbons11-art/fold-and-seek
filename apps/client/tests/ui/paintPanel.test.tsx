// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as THREE from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPaintTool, type PaintTool } from "../../src/paint/createPaintTool";
import { PaintPanel } from "../../src/ui/paint/PaintPanel";

/**
 * The paint panel is the promise MECCHA's own panel makes (CLAUDE.md override
 * 3): a colour, a brush, and the three material channels. Metallic and
 * smoothness were there; emissive was the one the panel never offered, so these
 * check the slider exists, that it reaches the brush, and that the other two
 * still do.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let tool: PaintTool;

function sliderLabelled(label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(found).not.toBeNull();
  return found as HTMLInputElement;
}

/** The label line above a slider, which carries the channel's current reading. */
function readingFor(name: string): string {
  const lines = [...container.querySelectorAll("div")].map((node) => node.textContent ?? "");
  return lines.find((text) => text.startsWith(name)) ?? "";
}

function setSlider(input: HTMLInputElement, value: number): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function openAdvancedPaint(): void {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Advanced paint",
  );
  expect(button).not.toBeUndefined();
  act(() => button?.click());
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshPhysicalMaterial({ color: 0x336699 }),
  );
  mesh.userData["segmentSlot"] = 2;
  tool = createPaintTool({
    canvas: document.createElement("canvas"),
    camera: new THREE.PerspectiveCamera(),
    raycaster: new THREE.Raycaster(),
    getMimicMeshes: () => [mesh],
    atlasSize: 128,
  });
  // The panel renders nothing until the tool has the pointer, which is what the
  // Forge does when it switches to paint mode.
  tool.activate();

  root = createRoot(container);
  act(() => {
    root.render(<PaintPanel tool={tool} />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  tool.dispose();
});

describe("paint panel material channels", () => {
  it("exposes live stroke state to the Portals interaction gate", () => {
    const panel = container.querySelector<HTMLElement>("[data-paint-stroke-count]");
    expect(panel?.dataset.paintActive).toBe("true");
    expect(panel?.dataset.paintStrokeCount).toBe("0");
  });

  it("offers all three of the original's channels", () => {
    openAdvancedPaint();
    expect(readingFor("Metallic")).toBe("Metallic 0");
    expect(readingFor("Smoothness")).toBe("Smoothness 35");
    expect(readingFor("Emissive")).toBe("Emissive 0");
  });

  it("carries the emissive slider through to the brush and back to the readout", () => {
    openAdvancedPaint();
    setSlider(sliderLabelled("Emissive"), 0.75);
    expect(tool.getState().emissive).toBeCloseTo(0.75, 5);
    expect(readingFor("Emissive")).toBe("Emissive 75");
  });

  it("starts unlit, so nothing glows unless the player asks for it", () => {
    expect(tool.getState().emissive).toBe(0);
    expect(tool.layer.hasEmissive).toBe(false);
  });

  it("leaves the emissive slider alone when another channel moves", () => {
    openAdvancedPaint();
    setSlider(sliderLabelled("Emissive"), 0.5);
    act(() => {
      tool.setMetallic(1);
      tool.setSmoothness(0.9);
    });
    expect(tool.getState().emissive).toBeCloseTo(0.5, 5);
    expect(readingFor("Emissive")).toBe("Emissive 50");
  });
});
