// Pure-field tests. No canvas, no DOM: the whole simulation is typed arrays and
// arithmetic, which is exactly why it can be tested in a headless CI.
//
//   node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRID_MAX,
  QUALITY_SCALE,
  advect,
  clearField,
  createField,
  dissipate,
  divergence,
  gridFor,
  maxSpeed,
  project,
  sampleField,
  splat,
  step,
} from '../src/inkField.js';

const near = (a, b, eps, label) => {
  assert.ok(Math.abs(a - b) <= eps, `${label}: ${a} != ${b} (eps ${eps})`);
};

test('grid follows the spec table and the 320x200 ceiling', () => {
  assert.deepEqual(gridFor(1045, 600, 'medium'), { width: 261, height: 150, scale: 0.25 });
  // 1440 * .25 = 360 and 900 * .25 = 225: both capped
  assert.deepEqual(gridFor(1440, 900, 'medium'), { width: 320, height: 200, scale: 0.25 });
  assert.deepEqual(gridFor(1440, 900, 'low'), { width: 216, height: 135, scale: 0.15 });
  assert.deepEqual(gridFor(1440, 900, 'high'), { width: 320, height: 200, scale: 0.4 });
  assert.equal(QUALITY_SCALE.medium, 0.25);
  assert.equal(GRID_MAX.width * GRID_MAX.height, 64000);
  // never below the minimum side, even in a 1px container
  assert.ok(gridFor(1, 1, 'low').width >= 4);
});

test('splat: exactly half strength at size px, round in screen space', () => {
  const field = createField(200, 200);
  // 800 CSS px across a 200-cell grid: 1 cell = 4 px
  splat(field, {
    x: 0.5, y: 0.5, sizePx: 80, dye: 1, cssWidth: 800, cssHeight: 800,
  });
  // sample the continuous field: u=0.6 is exactly 80 px right of the centre
  const centre = sampleField(field, field.d, 0.5, 0.5);
  const right = sampleField(field, field.d, 0.6, 0.5);
  const down = sampleField(field, field.d, 0.5, 0.6);
  near(centre, 1, 0.002, 'centre weight');
  near(right, 0.5, 0.002, 'half strength to the right');
  near(down, 0.5, 0.002, 'half strength downward (brush stays round)');
  near(right, down, 1e-6, 'x and y falloff are identical');
  // the Gaussian continues past `size` — that skirt is why the edge is soft.
  // Truncating at 1x (the old bug) cut it at weight 0.5 and made a square brush.
  const twoX = sampleField(field, field.d, 0.7, 0.5);
  assert.ok(twoX > 0.02 && twoX < 0.15, `2x size should be a soft skirt, got ${twoX}`);
  assert.ok(sampleField(field, field.d, 0.8, 0.5) < 0.002, '2.5x size is negligible');
});

test('splat: impulse scales with 40 * quality * force and with the pointer delta', () => {
  const a = createField(64, 64);
  splat(a, { x: 0.5, y: 0.5, dx: 0.1, sizePx: 64, force: 1, quality: 0.25, cssWidth: 256, cssHeight: 256 });
  const b = createField(64, 64);
  splat(b, { x: 0.5, y: 0.5, dx: 0.1, sizePx: 64, force: 2, quality: 0.25, cssWidth: 256, cssHeight: 256 });
  const c = createField(64, 64);
  splat(c, { x: 0.5, y: 0.5, dx: 0.1, sizePx: 64, force: 1, quality: 0.5, cssWidth: 256, cssHeight: 256 });
  const centre = (f) => sampleField(f, f.vx, 0.5, 0.5);
  near(centre(b) / centre(a), 2, 1e-5, 'force doubles the impulse');
  near(centre(c) / centre(a), 2, 1e-5, 'quality doubles the impulse');
  near(centre(a), 0.1 * 40 * 0.25, 0.002, '40 * quality * force * delta');
  assert.ok(Math.abs(sampleField(a, a.vy, 0.5, 0.5)) < 1e-6);
});

test('dissipation: half-life follows trail / 3, and trail/drift stay independent', () => {
  const field = createField(4, 4);
  field.d.fill(1);
  field.vx.fill(1);
  // one 200 ms step at the defaults: dye e^-1, velocity e^-1 too
  dissipate(field, 0.2, 0.6, 0.6);
  near(field.d[0], Math.exp(-1), 1e-6, 'dye after 200ms');
  near(field.vx[0], Math.exp(-1), 1e-6, 'velocity after 200ms');

  // two different labels must produce two different decays
  const split = createField(2, 2);
  split.d.fill(1);
  split.vx.fill(1);
  dissipate(split, 0.2, 0.6, 1.2);
  near(split.d[0], Math.exp(-1), 1e-6, 'trail 0.6 -> tau 0.2');
  near(split.vx[0], Math.exp(-0.5), 1e-6, 'drift 1.2 -> tau 0.4');

  // half-life: t = tau * ln 2 = (trail/3) * ln2
  const half = createField(2, 2);
  half.d.fill(1);
  const dt = 0.001;
  const t = (0.6 / 3) * Math.LN2;
  for (let elapsed = 0; elapsed < t; elapsed += dt) dissipate(half, dt, 0.6, 0.6);
  near(half.d[0], 0.5, 0.002, 'half-life of the default trail');
});

test('pressure projection removes divergence and leaves a uniform flow alone', () => {
  const uniform = createField(32, 32);
  uniform.vx.fill(0.1);
  uniform.vy.fill(0.05);
  project(uniform, 4);
  near(uniform.vx[100], 0.1, 1e-7, 'uniform vx unchanged');
  near(uniform.vy[100], 0.05, 1e-7, 'uniform vy unchanged');

  const field = createField(48, 48);
  let seed = 123456789;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let i = 0; i < field.cells; i++) {
    field.vx[i] = rnd() * 0.2;
    field.vy[i] = rnd() * 0.2;
  }
  const before = divergence(field);
  assert.ok(before > 0, 'the synthetic field must have divergence to remove');
  project(field, 4);
  const after = divergence(field);
  assert.ok(after < before * 0.95, `divergence should drop: ${before} -> ${after}`);
  assert.ok(Number.isFinite(field.vx[0]) && Number.isFinite(field.vy[0]));
});

test('advection: dye is carried by the velocity, and a uniform flow survives itself', () => {
  const field = createField(64, 64);
  field.vx.fill(1);            // 1 UV/s
  field.vy.fill(0);
  field.d[32 * 64 + 32] = 1;   // centre blob
  advect(field, 0.1);          // 0.1 UV to the right
  near(field.vx[40 * 64 + 40], 1, 1e-5, 'uniform velocity survives self-advection');
  const atNew = sampleField(field, field.d, 0.6, 0.5);
  const atOld = sampleField(field, field.d, 0.5, 0.5);
  assert.ok(atNew > 0.2, `dye should arrive at u=0.6 (got ${atNew})`);
  assert.ok(atNew > atOld, `dye should have left u=0.5 (new ${atNew}, old ${atOld})`);
  near(field.d.reduce((x, y) => x + y, 0), 1, 1e-5, 'advection conserves dye in the interior');
});

test('a full step never produces NaN, even at the container rim', () => {
  const field = createField(24, 18);
  splat(field, {
    x: 0.02, y: 0.98, dx: 0.2, dy: -0.2, sizePx: 56, dye: 1, cssWidth: 96, cssHeight: 72,
  });
  for (let i = 0; i < 10; i++) step(field, 1 / 60, { trail: 0.6, drift: 0.6, iterations: 4 });
  for (let i = 0; i < field.cells; i++) {
    assert.ok(Number.isFinite(field.vx[i]) && Number.isFinite(field.vy[i]) && Number.isFinite(field.d[i]));
  }
  assert.ok(maxSpeed(field) < 10, 'rim clamping must not blow the field up');
});

test('clearField resets every buffer (resize must not keep the old film)', () => {
  const field = createField(8, 8);
  field.vx.fill(1); field.vy.fill(2); field.d.fill(3);
  field.p.fill(4); field.div.fill(5);
  clearField(field);
  assert.equal(field.vx.reduce((a, b) => a + Math.abs(b), 0), 0);
  assert.equal(field.d.reduce((a, b) => a + Math.abs(b), 0), 0);
  assert.equal(field.p.reduce((a, b) => a + Math.abs(b), 0), 0);
  assert.equal(field.div.reduce((a, b) => a + Math.abs(b), 0), 0);
});
