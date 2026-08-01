/**
 * Colour conversion for the paint UI. The wheel is authored in hue, saturation
 * and value because that is the control the MECCHA panel offers and because a
 * wheel that stored only RGB would forget its hue every time the value slider
 * reached black. Everything leaving here is sRGB in 0..1, which is the space the
 * atlas and the wire both use.
 */

export type Rgb = readonly [number, number, number];
export type Hsv = { readonly h: number; readonly s: number; readonly v: number };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Hue is turns in 0..1, saturation and value 0..1. */
export function hsvToRgb(hsv: Hsv): [number, number, number] {
  const h = (hsv.h - Math.floor(hsv.h)) * 6;
  const s = clamp01(hsv.s);
  const v = clamp01(hsv.v);
  const sector = Math.floor(h);
  const fraction = h - sector;
  const p = v * (1 - s);
  const q = v * (1 - s * fraction);
  const t = v * (1 - s * (1 - fraction));

  switch (sector % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

export function rgbToHsv(rgb: Rgb): Hsv {
  const r = clamp01(rgb[0]);
  const g = clamp01(rgb[1]);
  const b = clamp01(rgb[2]);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;

  let h = 0;
  if (span > 0) {
    if (max === r) h = ((g - b) / span + 6) % 6;
    else if (max === g) h = (b - r) / span + 2;
    else h = (r - g) / span + 4;
    h /= 6;
  }
  return { h, s: max === 0 ? 0 : span / max, v: max };
}

export function rgbToCss(rgb: Rgb): string {
  const r = Math.round(clamp01(rgb[0]) * 255);
  const g = Math.round(clamp01(rgb[1]) * 255);
  const b = Math.round(clamp01(rgb[2]) * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

export function rgbToHex(rgb: Rgb): string {
  const value =
    (Math.round(clamp01(rgb[0]) * 255) << 16) |
    (Math.round(clamp01(rgb[1]) * 255) << 8) |
    Math.round(clamp01(rgb[2]) * 255);
  return `#${value.toString(16).padStart(6, "0").toUpperCase()}`;
}

/**
 * Reads a hex colour the way a person types one: with or without the hash, in
 * three or six digits, in either case. Returns null on anything else, so the
 * field can keep what the player is still typing instead of snapping to black.
 */
export function hexToRgb(text: string): [number, number, number] | null {
  const digits = text.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  if (digits.length === 3) {
    const r = Number.parseInt(digits[0] ?? "", 16);
    const g = Number.parseInt(digits[1] ?? "", 16);
    const b = Number.parseInt(digits[2] ?? "", 16);
    return [(r * 17) / 255, (g * 17) / 255, (b * 17) / 255];
  }
  if (digits.length === 6) {
    const value = Number.parseInt(digits, 16);
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
  }
  return null;
}

/** True when two colours are the same to the byte the wire would carry. */
export function sameColorByte(a: Rgb, b: Rgb): boolean {
  return (
    Math.round(clamp01(a[0]) * 255) === Math.round(clamp01(b[0]) * 255) &&
    Math.round(clamp01(a[1]) * 255) === Math.round(clamp01(b[1]) * 255) &&
    Math.round(clamp01(a[2]) * 255) === Math.round(clamp01(b[2]) * 255)
  );
}
