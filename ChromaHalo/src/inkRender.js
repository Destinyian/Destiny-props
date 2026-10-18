/**
 * inkRender — turn the scalar dye field into pixels, plus the two colour maps
 * the spec defines for light and dark pages.
 *
 *   ink   (light page): multiply blend, out = 1 - d * (1 - hue)
 *   smoke (dark page):  screen blend, thin tone -> dense tone in OKLCH,
 *                       alpha = 1 - exp(-1.5 d)
 *
 * The smoke map is precomputed into a 256-entry table per colour, because the
 * OKLCH conversion involves a cube root and two trig calls — per pixel, per
 * frame, that would cost more than the simulation.
 *
 * No DOM at import time. `createRenderer` is the only function that touches a
 * canvas; everything else is pure and testable in Node.
 */

const STEPS = 256;
const MAX_DENSITY = 4;

// ImageData is RGBA bytes. Writing one Uint32 per pixel is roughly twice as
// fast as four byte stores, but the packed value depends on endianness; the
// byte path stays as the portable fallback.
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB (0..1) -> OKLCH. `h` in degrees, `c` chroma. */
export function rgbToOklch(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l3 = Math.cbrt(l);
  const m3 = Math.cbrt(m);
  const s3 = Math.cbrt(s);

  const L = 0.2104542553 * l3 + 0.7936177850 * m3 - 0.0040720468 * s3;
  const a = 1.9779984951 * l3 - 2.4285922050 * m3 + 0.4505937099 * s3;
  const bb = 0.0259040371 * l3 + 0.7827717662 * m3 - 0.8086757660 * s3;

  return { l: L, c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

/** OKLCH -> sRGB (0..1, gamut-clipped). */
export function oklchToRgb(l, c, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const bb = c * Math.sin(h);

  const l3 = l + 0.3963377774 * a + 0.2158037573 * bb;
  const m3 = l - 0.1055613458 * a - 0.0638541728 * bb;
  const s3 = l - 0.0894841775 * a - 1.2914855480 * bb;

  const lv = l3 ** 3;
  const mv = m3 ** 3;
  const sv = s3 ** 3;

  return {
    r: clamp01(linearToSrgb(4.0767416621 * lv - 3.3077115913 * mv + 0.2309699292 * sv)),
    g: clamp01(linearToSrgb(-1.2684380046 * lv + 2.6097574011 * mv - 0.3413193965 * sv)),
    b: clamp01(linearToSrgb(-0.0041960863 * lv - 0.7034186147 * mv + 1.7076147010 * sv)),
  };
}

/** Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`. Null on garbage. */
export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim().toLowerCase();
  if (!input) return null;

  let r;
  let g;
  let b;
  let a = 1;

  if (input[0] === '#') {
    const hex = input.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      if (hex.length === 4) a = parseInt(hex[3] + hex[3], 16) / 255;
    } else if (hex.length === 6 || hex.length === 8) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16) / 255;
    } else return null;
  } else {
    const match = /^rgba?\(([^)]+)\)$/.exec(input);
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (text) => {
      const n = text.endsWith('%') ? (parseFloat(text) / 100) * 255 : parseFloat(text);
      return Number.isFinite(n) ? clamp01(n / 255) : NaN;
    };
    r = channel(parts[0]) * 255;
    g = channel(parts[1]) * 255;
    b = channel(parts[2]) * 255;
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    if (parts[3] !== undefined) {
      const n = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      if (!Number.isFinite(n)) return null;
      a = clamp01(n);
    }
    r = Math.round(r);
    g = Math.round(g);
    b = Math.round(b);
  }

  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  return {
    r: rr,
    g: gg,
    b: bb,
    a,
    css: `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`,
    oklch: rgbToOklch(rr, gg, bb),
  };
}

/** WCAG-ish relative luminance used for the auto mode. Inputs are sRGB 0..1. */
export function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * One ink pixel. `d` is dye density; `opacity` scales the whole layer without
 * making the untouched (white) part of the canvas translucent — which would
 * lighten a multiply layer instead of fading the ink.
 */
export function inkPixel(d, color, opacity = 1) {
  const dd = Math.max(0, d * opacity);
  return [
    clamp01(1 - dd * (1 - color.r)),
    clamp01(1 - dd * (1 - color.g)),
    clamp01(1 - dd * (1 - color.b)),
  ];
}

/**
 * Build the smoke tone/alpha tables. Index 0 is density 0, index 255 is
 * MAX_DENSITY. Thin smoke keeps the hue; dense smoke turns into a bright core,
 * which is why the alpha and the tone both rise with density.
 */
export function buildSmokeTable(color, opacity = 1) {
  const rgb = new Float32Array(STEPS * 3);
  const alpha = new Float32Array(STEPS);
  const baseC = color.oklch.c;
  const thinC = Math.min(1.3 * baseC, 0.2);
  const denseC = Math.min(0.45 * baseC, 0.07);
  const hue = color.oklch.h;

  for (let i = 0; i < STEPS; i++) {
    const d = (i / (STEPS - 1)) * MAX_DENSITY;
    const t = 1 - Math.exp(-0.35 * d);
    const tone = oklchToRgb(0.6 + 0.26 * t, thinC + (denseC - thinC) * t, hue);
    rgb[i * 3] = tone.r;
    rgb[i * 3 + 1] = tone.g;
    rgb[i * 3 + 2] = tone.b;
    alpha[i] = 1 - Math.exp(-1.5 * d);
  }
  return { rgb, alpha, opacity, maxDensity: MAX_DENSITY };
}

/** Convenience for tests / previews: the smoke colour and alpha at one density. */
export function smokePixel(d, color, opacity = 1) {
  const dd = Math.max(0, Math.min(MAX_DENSITY, d * opacity));
  const t = 1 - Math.exp(-0.35 * dd);
  const baseC = color.oklch.c;
  const thinC = Math.min(1.3 * baseC, 0.2);
  const denseC = Math.min(0.45 * baseC, 0.07);
  const tone = oklchToRgb(0.6 + 0.26 * t, thinC + (denseC - thinC) * t, color.oklch.h);
  return { ...tone, a: 1 - Math.exp(-1.5 * dd) };
}

/**
 * Canvas compositor. The visible canvas's *backing store* is the simulation
 * grid (<= 320x200); CSS stretches the element to the host and the CSS blur
 * hides the interpolation. That is one `putImageData` per frame and no
 * full-resolution `drawImage` — the browser composites the upscale on the GPU.
 * (The spec describes an offscreen canvas plus drawImage; this is the same
 * low-res-then-upscale pipeline, with the upscale moved out of JS.)
 */
export function createRenderer(canvas, width, height) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('inkRender: 2d context unavailable');

  let image = ctx.createImageData(Math.max(1, width), Math.max(1, height));
  let pixels = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.byteLength >> 2);
  let color = parseColor('#362E82');
  let smoke = buildSmokeTable(color);
  let cachedMode = 'ink';

  function resize(w, h) {
    const cw = Math.max(1, w | 0);
    const ch = Math.max(1, h | 0);
    canvas.width = cw;
    canvas.height = ch;
    image = ctx.createImageData(cw, ch);
    pixels = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.byteLength >> 2);
  }

  function setColor(next) {
    if (next) {
      color = next;
      smoke = buildSmokeTable(color);
    }
  }

  function draw(field, options = {}) {
    const mode = options.mode || cachedMode;
    cachedMode = mode;
    const opacity = options.opacity === undefined ? 1 : options.opacity;
    if (options.color) setColor(options.color);

    const { d } = field;
    const data = image.data;
    const cells = field.cells;

    if (mode === 'smoke') {
      const table = smoke.rgb;
      const tableA = smoke.alpha;
      const scale = (STEPS - 1) / MAX_DENSITY;
      if (LITTLE_ENDIAN) {
        for (let i = 0; i < cells; i++) {
          const density = d[i] * opacity;
          let idx = (density * scale) | 0;
          if (idx < 0) idx = 0;
          else if (idx >= STEPS) idx = STEPS - 1;
          const t = idx * 3;
          const a = (tableA[idx] * 255) | 0;
          const r = (table[t] * 255) | 0;
          const g = (table[t + 1] * 255) | 0;
          const b = (table[t + 2] * 255) | 0;
          pixels[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
        }
      } else {
        for (let i = 0, p = 0; i < cells; i++, p += 4) {
          const density = d[i] * opacity;
          let idx = (density * scale) | 0;
          if (idx < 0) idx = 0;
          else if (idx >= STEPS) idx = STEPS - 1;
          const t = idx * 3;
          data[p] = table[t] * 255;
          data[p + 1] = table[t + 1] * 255;
          data[p + 2] = table[t + 2] * 255;
          data[p + 3] = tableA[idx] * 255;
        }
      }
    } else {
      // out = 1 - d*(1-hue), per channel. Untouched pixels stay white so the
      // multiply layer is invisible over any backdrop.
      const dr = (1 - color.r) * opacity;
      const dg = (1 - color.g) * opacity;
      const db = (1 - color.b) * opacity;
      if (LITTLE_ENDIAN) {
        for (let i = 0; i < cells; i++) {
          const density = d[i];
          const rf = 1 - density * dr;
          const gf = 1 - density * dg;
          const bf = 1 - density * db;
          const r = rf <= 0 ? 0 : rf >= 1 ? 255 : (rf * 255) | 0;
          const g = gf <= 0 ? 0 : gf >= 1 ? 255 : (gf * 255) | 0;
          const b = bf <= 0 ? 0 : bf >= 1 ? 255 : (bf * 255) | 0;
          pixels[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
        }
      } else {
        for (let i = 0, p = 0; i < cells; i++, p += 4) {
          const density = d[i];
          const r = 1 - density * dr;
          const g = 1 - density * dg;
          const b = 1 - density * db;
          data[p] = r <= 0 ? 0 : r >= 1 ? 255 : r * 255;
          data[p + 1] = g <= 0 ? 0 : g >= 1 ? 255 : g * 255;
          data[p + 2] = b <= 0 ? 0 : b >= 1 ? 255 : b * 255;
          data[p + 3] = 255;
        }
      }
    }

    // putImageData replaces every pixel (including alpha), so there is nothing
    // to clear and no previous frame can survive in transparent regions
    ctx.putImageData(image, 0, 0);
  }

  function clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function destroy() {
    image = null;
  }

  resize(width, height);
  return { resize, setColor, draw, clear, destroy, get color() { return color; } };
}
