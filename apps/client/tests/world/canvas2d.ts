/**
 * The smallest 2D canvas context the shop's procedural surfaces need.
 *
 * jsdom ships no canvas, and every map in the room is drawn into one at build
 * time. The generator only ever creates an ImageData, writes into it, and hands
 * it back, plus one linear gradient for the lampshade, so a stub with those
 * four calls runs the real material library rather than a stand-in for it.
 */

export interface CanvasStub {
  /** Canvases handed out since installation, so a test can count them. */
  readonly canvases: HTMLCanvasElement[];
  restore(): void;
}

export function installCanvas2DStub(): CanvasStub {
  const canvases: HTMLCanvasElement[] = [];
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalCreateElement = document.createElement.bind(document);

  HTMLCanvasElement.prototype.getContext = function stubGetContext(this: HTMLCanvasElement, kind: string) {
    if (kind !== "2d") {
      return null;
    }
    return {
      createImageData: (width: number, height: number) =>
        ({ data: new Uint8ClampedArray(width * height * 4), width, height, colorSpace: "srgb" }) as ImageData,
      putImageData: () => undefined,
      createLinearGradient: () => ({ addColorStop: () => undefined }),
      createRadialGradient: () => ({ addColorStop: () => undefined }),
      fillRect: () => undefined,
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;

  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = originalCreateElement(tag, options);
    if (tag === "canvas") {
      canvases.push(element as HTMLCanvasElement);
    }
    return element;
  }) as typeof document.createElement;

  return {
    canvases,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      document.createElement = originalCreateElement;
    },
  };
}
