// Colour-map tests: the two visible modes must be distinguishable by numbers,
// not by taste. Ink must thin to the hue and thicken to black; smoke must thin
// to a coloured veil and thicken to a bright, low-chroma core.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSmokeTable,
  inkPixel,
  luminance,
  parseColor,
  rgbToOklch,
  smokePixel,
} from '../src/inkRender.js';

const HUE = parseColor('#362E82');

test('parseColor reads hex, short hex and rgb()/rgba()', () => {
  const c = parseColor('#362E82');
  assert.ok(c);
  assert.equal(Math.round(c.r * 255), 54);
  assert.equal(Math.round(c.g * 255), 46);
  assert.equal(Math.round(c.b * 255), 130);
  assert.equal(c.a, 1);
  assert.ok(c.oklch.c > 0.05 && c.oklch.c < 0.3, 'default hue is chromatic');
  assert.equal(parseColor('#fff').r, 1);
  assert.equal(parseColor('#ffffff80').a, 0x80 / 255);
  const rgb = parseColor('rgb(54 46 130 / 50%)');
  assert.equal(Math.round(rgb.b * 255), 130);
  assert.equal(rgb.a, 0.5);
  assert.equal(parseColor('not-a-colour'), null);
  assert.equal(parseColor(null), null);

  // getComputedStyle() emits this comma form; it is what auto-mode walks
  const computedDark = parseColor('rgb(8, 7, 15)');
  assert.ok(computedDark);
  assert.ok(luminance(computedDark.r, computedDark.g, computedDark.b) < 0.5);
  const transparent = parseColor('rgba(0, 0, 0, 0)');
  assert.equal(transparent.a, 0);
});

test('ink: zero density is white, density 1 is the hue, density 4+ is black', () => {
  const [r0, g0, b0] = inkPixel(0, HUE);
  assert.deepEqual([r0, g0, b0], [1, 1, 1]);
  const one = inkPixel(1, HUE);
  assert.ok(Math.abs(one[0] - HUE.r) < 1e-9);
  assert.ok(Math.abs(one[2] - HUE.b) < 1e-9);
  const dense = inkPixel(10, HUE);
  assert.ok(luminance(...dense) < 0.02, 'dense ink tends to black');
  const half = inkPixel(0.5, HUE);
  assert.ok(half[0] > HUE.r && half[2] > HUE.b, 'thin ink stays between the hue and white');
});

test('ink: opacity fades density, it does not make the white layer translucent', () => {
  const full = inkPixel(1, HUE, 1);
  const faded = inkPixel(1, HUE, 0.5);
  assert.ok(faded[0] > full[0]);
  assert.ok(faded[0] < 1);
  const empty = inkPixel(0, HUE, 0.3);
  assert.deepEqual(empty, [1, 1, 1], 'untouched pixels stay white at any opacity');
});

test('smoke: denser means brighter, more opaque and less chromatic', () => {
  const thin = smokePixel(0.15, HUE);
  const mid = smokePixel(0.8, HUE);
  const dense = smokePixel(2.5, HUE);

  assert.ok(thin.a < mid.a && mid.a < dense.a, 'alpha rises with density');
  assert.ok(luminance(thin.r, thin.g, thin.b) < luminance(mid.r, mid.g, mid.b));
  assert.ok(luminance(mid.r, mid.g, mid.b) < luminance(dense.r, dense.g, dense.b));
  assert.ok(rgbToOklch(thin.r, thin.g, thin.b).c > rgbToOklch(dense.r, dense.g, dense.b).c,
    'the thin edge keeps more chroma than the bright core');
  assert.ok(rgbToOklch(thin.r, thin.g, thin.b).h > 0 || rgbToOklch(thin.r, thin.g, thin.b).h < 0,
    'hue survives the OKLCH round trip');
});

test('smoke table is monotonic and is what the renderer will sample', () => {
  const table = buildSmokeTable(HUE);
  assert.equal(table.rgb.length, 256 * 3);
  assert.equal(table.alpha.length, 256);
  assert.equal(table.alpha[0], 0, 'no dye means no smoke');
  assert.ok(table.alpha[255] > 0.99, 'dense smoke is nearly opaque');
  let lastLum = -1;
  for (let i = 0; i < 256; i++) {
    const r = table.rgb[i * 3];
    const g = table.rgb[i * 3 + 1];
    const b = table.rgb[i * 3 + 2];
    const lum = luminance(r, g, b);
    assert.ok(lum >= lastLum - 1e-6, `tone must get lighter, index ${i}`);
    lastLum = lum;
  }
});
