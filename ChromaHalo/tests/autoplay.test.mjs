// The wanderer must stay inside the container, never repeat mechanically, and
// fade with the two constants the card promises.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOPLAY_FADE,
  createWanderer,
  stepFade,
  wandererAt,
} from '../src/inkAutoplay.js';

const PHASES = [0.3, 1.7, 4.2, 5.5];

test('wanderer stays inside the safe area for a long run', () => {
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (let t = 0; t < 600; t += 0.013) {
    const { x, y } = wandererAt(t, PHASES);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  assert.ok(minX > 0.08 && maxX < 0.92, `x range ${minX}..${maxX}`);
  assert.ok(minY > 0.11 && maxY < 0.89, `y range ${minY}..${maxY}`);
});

test('the phase drift makes a later pass differ from the first', () => {
  // the two component frequencies are far from commensurate, but the phase
  // rotation is what guarantees the path is not a fixed loop
  const a = wandererAt(0, PHASES);
  const b = wandererAt(60, PHASES);
  const c = wandererAt(120, PHASES);
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(b, c);
  // and two nearby samples move smoothly rather than jumping
  const d = wandererAt(10, PHASES);
  const e = wandererAt(10.01, PHASES);
  assert.ok(Math.hypot(d.x - e.x, d.y - e.y) < 0.005, 'no teleport between frames');
});

test('createWanderer reports the per-frame displacement, not an absolute point', () => {
  const w = createWanderer({ speed: 1, phases: PHASES });
  let last = w.step(1 / 60);
  assert.ok(last.dx !== 0 || last.dy !== 0);
  let total = 0;
  for (let i = 0; i < 120; i++) {
    const next = w.step(1 / 60);
    assert.ok(Math.hypot(next.dx, next.dy) < 0.01, 'one frame is a small step');
    total += Math.hypot(next.dx, next.dy);
  }
  assert.ok(total > 0.05, 'it actually travels');
  w.reset();
  assert.equal(w.time, 0);
});

test('fade: 600 ms in, 200 ms out, and it lands exactly on the target', () => {
  assert.equal(AUTOPLAY_FADE.in, 0.6);
  assert.equal(AUTOPLAY_FADE.out, 0.2);

  let s = 0;
  for (let i = 0; i < 6; i++) s = stepFade(s, 1, 0.1);
  assert.equal(s, 1);

  s = 1;
  for (let i = 0; i < 2; i++) s = stepFade(s, 0, 0.1);
  assert.equal(s, 0);

  const quarter = stepFade(0, 1, 0.15);
  assert.ok(Math.abs(quarter - 0.25) < 1e-9, 'a quarter of the fade-in time is a quarter of the way');
  const leaving = stepFade(1, 0, 0.05);
  assert.ok(Math.abs(leaving - 0.75) < 1e-9, 'the exit is three times faster');
});
