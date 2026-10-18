/**
 * inkAutoplay — the invisible wanderer that keeps a quiet page alive after
 * `idleDelay`. The path is three different frequencies per axis plus a slowly
 * rotating phase, which is deliberately not the reference implementation's
 * path: it never closes a loop the eye can learn.
 *
 *   x = .5 + .26 sin(.21 t + p0) + .13 sin(.53 t + p1)
 *   y = .5 + .22 sin(.17 t + p2) + .11 sin(.47 t + p3)
 *   every phase drifts by .03 t
 *
 * Pure math; the engine owns the timers and the fade state.
 */

export const AUTOPLAY_FADE = Object.freeze({ in: 0.6, out: 0.2 });
export const AUTOPLAY_DRIFT = 0.03;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Position at time `t` (seconds) for four phases (radians). */
export function wandererAt(t, phases = [0, 0, 0, 0], drift = AUTOPLAY_DRIFT) {
  const p = phases;
  const d = drift * t;
  return {
    x: 0.5 + 0.26 * Math.sin(0.21 * t + (p[0] || 0) + d)
      + 0.13 * Math.sin(0.53 * t + (p[1] || 0) + d),
    y: 0.5 + 0.22 * Math.sin(0.17 * t + (p[2] || 0) + d)
      + 0.11 * Math.sin(0.47 * t + (p[3] || 0) + d),
  };
}

/**
 * Stateful wanderer: advances its own clock and remembers the previous point,
 * so the engine can splat with the per-frame displacement instead of a teleport.
 */
export function createWanderer({ speed = 1, phases, rng = Math.random } = {}) {
  const p = phases
    ? [phases[0] || 0, phases[1] || 0, phases[2] || 0, phases[3] || 0]
    : [rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2];
  let t = 0;
  let speedScale = speed;
  let prev = wandererAt(0, p);

  return {
    /** advance by dt seconds, return the new point and the displacement */
    step(dt) {
      t += Math.max(0, dt) * speedScale;
      const at = wandererAt(t, p);
      const dx = at.x - prev.x;
      const dy = at.y - prev.y;
      prev = at;
      return { x: at.x, y: at.y, dx, dy, t };
    },
    reset() {
      t = 0;
      prev = wandererAt(0, p);
    },
    setSpeed(next) {
      speedScale = Number.isFinite(next) ? next : 1;
    },
    get speed() { return speedScale; },
    get time() { return t; },
    get phases() { return p.slice(); },
  };
}

/**
 * Linear fade toward 0 or 1. Entering takes 600 ms, leaving 200 ms: the
 * wanderer has to appear gently and get out of the way immediately when the
 * pointer arrives.
 */
export function stepFade(current, target, dt, fadeIn = AUTOPLAY_FADE.in, fadeOut = AUTOPLAY_FADE.out) {
  const c = clamp01(current);
  const goal = clamp01(target);
  if (c === goal) return goal;
  const rate = goal > c
    ? 1 / Math.max(1e-4, fadeIn)
    : 1 / Math.max(1e-4, fadeOut);
  const next = c + Math.sign(goal - c) * rate * Math.max(0, dt);
  return goal > c ? Math.min(goal, next) : Math.max(goal, next);
}
