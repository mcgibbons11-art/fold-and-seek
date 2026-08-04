import { useCallback, useEffect, useRef, type CSSProperties, type ReactElement } from "react";

import { tryReleasePointerCapture, trySetPointerCapture } from "../../engine/pointerCapture";
import { hsvToRgb, type Hsv } from "../../paint/color";

/**
 * The paint panel's colour wheel: hue around the disc, saturation out from the
 * centre, value on the strip beside it, exactly the control the MECCHA panel
 * offers. It is drawn pixel by pixel into a canvas rather than assembled from
 * gradients so the whole wheel dims with the value slider instead of only its
 * rim, and it brings no dependency with it.
 */

export const WHEEL_SIZE = 152;

interface ColorWheelProps {
  readonly hsv: Hsv;
  readonly onChange: (hsv: Hsv) => void;
}

const wheelStyle: CSSProperties = {
  display: "block",
  width: WHEEL_SIZE,
  height: WHEEL_SIZE,
  borderRadius: "50%",
  cursor: "crosshair",
  touchAction: "none",
};

const markerStyle: CSSProperties = {
  position: "absolute",
  width: 11,
  height: 11,
  marginLeft: -6,
  marginTop: -6,
  borderRadius: "50%",
  border: "2px solid #fff6e6",
  boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.6)",
  pointerEvents: "none",
};

function drawWheel(canvas: HTMLCanvasElement, value: number): void {
  const context = canvas.getContext("2d");
  if (context === null) return;
  const size = canvas.width;
  const radius = size / 2;
  const image = context.createImageData(size, size);
  const pixels = image.data;

  for (let y = 0; y < size; y++) {
    const dy = (y + 0.5 - radius) / radius;
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - radius) / radius;
      const distance = Math.hypot(dx, dy);
      const index = (y * size + x) * 4;
      if (distance > 1) {
        pixels[index + 3] = 0;
        continue;
      }
      const hue = (Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1;
      const [r, g, b] = hsvToRgb({ h: hue, s: distance, v: value });
      pixels[index] = Math.round(r * 255);
      pixels[index + 1] = Math.round(g * 255);
      pixels[index + 2] = Math.round(b * 255);
      // One pixel of feathering at the rim, so the disc has no staircase edge.
      pixels[index + 3] = Math.round(Math.min(1, (1 - distance) * radius) * 255);
    }
  }
  context.putImageData(image, 0, 0);
}

export function ColorWheel(props: ColorWheelProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  const { hsv, onChange } = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas !== null) drawWheel(canvas, hsv.v);
  }, [hsv.v]);

  const pick = useCallback(
    (clientX: number, clientY: number): void => {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const rect = canvas.getBoundingClientRect();
      const radius = rect.width / 2;
      const dx = (clientX - rect.left - radius) / radius;
      const dy = (clientY - rect.top - radius) / radius;
      onChange({
        h: (Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1,
        s: Math.min(1, Math.hypot(dx, dy)),
        v: hsv.v,
      });
    },
    [hsv.v, onChange],
  );

  const markerAngle = hsv.h * Math.PI * 2;
  const markerRadius = (hsv.s * WHEEL_SIZE) / 2;

  return (
    <div style={{ position: "relative", width: WHEEL_SIZE, height: WHEEL_SIZE }}>
      <canvas
        ref={canvasRef}
        width={WHEEL_SIZE}
        height={WHEEL_SIZE}
        style={wheelStyle}
        onPointerDown={(event) => {
          draggingRef.current = true;
          trySetPointerCapture(event.currentTarget, event.pointerId);
          pick(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) pick(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          draggingRef.current = false;
          tryReleasePointerCapture(event.currentTarget, event.pointerId);
        }}
      />
      <span
        style={{
          ...markerStyle,
          left: WHEEL_SIZE / 2 + Math.cos(markerAngle) * markerRadius,
          top: WHEEL_SIZE / 2 + Math.sin(markerAngle) * markerRadius,
        }}
      />
    </div>
  );
}
