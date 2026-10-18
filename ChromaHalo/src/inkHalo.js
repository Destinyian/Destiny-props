/**
 * inkHalo — lifecycle for the Ink Halo: pointer input, idle wanderer, resize,
 * theme observation, the rAF budget, and the low-end / no-canvas fallbacks.
 *
 * The framework-agnostic part is the contract: hand it a <canvas>, call
 * `destroy()` when done. No React, no globals at import time (SSR safe).
 *
 * The host is `canvas.parentElement`: the canvas itself is `pointer-events:
 * none` (it must never block the page), so the parent is the element that sees
 * the pointer. The parent has to be positioned, because the canvas is
 * absolutely inset into it.
 */

import {
  QUALITY_SCALE,
  createField,
  gridFor,
  maxDye,
  sampleField,
  splat,
  step,
} from './inkField.js';
import { createRenderer, luminance, parseColor } from './inkRender.js';
import { createWanderer, stepFade } from './inkAutoplay.js';

export const INK_HALO_DEFAULTS = Object.freeze({
  /** hue of the ink / smoke, any hex or rgb() colour */
  color: '#362E82',
  /** 'auto' follows the first opaque ancestor background, or force 'ink' / 'smoke' */
  mode: 'auto',
  /** brush radius at half strength, CSS px */
  size: 56,
  /** velocity impulse multiplier */
  force: 1,
  /** dye injection multiplier */
  intensity: 1,
  /** dye lifetime, seconds (the visible film is gone in about this long) */
  trail: 0.6,
  /** velocity lifetime, seconds (this is the drift after the pointer stops) */
  drift: 0.6,
  /** CSS blur applied to the upscaled simulation, px */
  blur: 8,
  /** overall strength; fades the dye, not the canvas layer */
  opacity: 1,
  /** low 0.15 / medium 0.25 / high 0.4 of CSS size */
  quality: 'medium',
  /** paint by itself while the pointer is away */
  autoplay: true,
  autoplaySpeed: 1,
  /** seconds of pointer silence before the wanderer starts */
  idleDelay: 1.5,
  /** follow the pointer at all */
  interactive: true,
  /** freeze the simulation */
  paused: false,
  /** 'auto' follows prefers-reduced-motion, 'instant' always reduces, 'full' never */
  reducedMotion: 'auto',
  /** Jacobi pressure iterations (4 is the reference; 3..6 is the usable band) */
  iterations: 4,
  /** drop to low quality + blur 0 when the device or the frame time demands it */
  autoDegrade: true,
  /** called when auto mode resolves to a different mode */
  onModeChange: null,
});

const QUALITY = new Set(['low', 'medium', 'high']);
const STOP_PAD = 0.5;
const MAX_STEP_UV = 0.25;
const FRAME_SAMPLES = 120;
const MAX_SPLAT_DYE = 8;
/**
 * The measured formula deposits `2 * dt` per frame (~0.033 at 60 fps), which is
 * the equilibrium density of a *stationary* brush. A fast swipe crosses a cell
 * in two or three frames, so the raw value never leaves the 0.02 range and the
 * path is invisible. The reference's visible path sits at d ~= 0.5..3, so the
 * engine scales the continuous injection by this gain. It is a calibration of
 * the CPU field's units, not a new parameter: `intensity` still multiplies it.
 */
const DYE_GAIN = 24;
/**
 * The wanderer moves at a tenth of a fast swipe, so the same per-frame gain
 * would park a saturated black disc on the page instead of a drifting plume.
 * A smaller gain keeps the idle ink at a readable density (~0.5–1) while the
 * pointer path still saturates at the head, where thickness is the point.
 */
const AUTOPLAY_DYE_GAIN = 1.5;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function normOptions(input) {
  const opts = { ...INK_HALO_DEFAULTS };
  if (input) {
    for (const key in input) {
      if (input[key] !== undefined) opts[key] = input[key];
    }
  }
  if (!QUALITY.has(opts.quality)) opts.quality = 'medium';
  opts.size = clamp(Number(opts.size) || 56, 2, 600);
  opts.force = clamp(Number(opts.force) || 0, 0, 10);
  opts.intensity = clamp(Number(opts.intensity) || 0, 0, 10);
  opts.trail = clamp(Number(opts.trail) || 0.6, 0.05, 30);
  opts.drift = clamp(Number(opts.drift) || 0.6, 0.05, 30);
  opts.blur = clamp(Number(opts.blur) || 0, 0, 64);
  opts.opacity = clamp(Number(opts.opacity), 0, 1);
  if (!Number.isFinite(opts.opacity)) opts.opacity = 1;
  opts.autoplaySpeed = clamp(Number(opts.autoplaySpeed) || 0, 0, 10);
  opts.idleDelay = Math.max(0, Number(opts.idleDelay) || 0);
  opts.iterations = clamp(Math.round(Number(opts.iterations) || 4), 3, 6);
  opts.autoplay = !!opts.autoplay;
  opts.interactive = !!opts.interactive;
  opts.paused = !!opts.paused;
  opts.autoDegrade = !!opts.autoDegrade;
  if (opts.reducedMotion !== 'instant' && opts.reducedMotion !== 'full') opts.reducedMotion = 'auto';
  if (opts.mode !== 'ink' && opts.mode !== 'smoke') opts.mode = 'auto';
  return opts;
}

/** First opaque background in the ancestor chain decides the mode. */
function detectMode(el) {
  let node = el;
  while (node) {
    const styles = getComputedStyle(node);
    const bg = parseColor(styles.backgroundColor);
    if (bg && bg.a >= 0.5) {
      return luminance(bg.r, bg.g, bg.b) < 0.5 ? 'smoke' : 'ink';
    }
    node = node.parentElement;
  }
  return 'ink';
}

/**
 * ---------- no-2D-context fallback ----------
 * A radial gradient that follows the pointer and deliberately has no memory:
 * the page still gets feedback, and the console says why the real field is
 * missing. It shares the options / mode / colour surface with the real engine.
 */
function createFallback(canvas, input) {
  const opts = normOptions(input);
  const host = canvas.parentElement || canvas;
  canvas.style.display = 'none';
  canvas.setAttribute('aria-hidden', 'true');

  const mode = opts.mode === 'auto' ? detectMode(host) : opts.mode;
  const dot = document.createElement('div');
  dot.setAttribute('aria-hidden', 'true');
  dot.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;will-change:transform;';
  host.appendChild(dot);

  let color = parseColor(opts.color) || parseColor(INK_HALO_DEFAULTS.color);
  let currentMode = mode;
  let size = opts.size;
  let destroyed = false;

  const paint = () => {
    const alpha = clamp(0.55 * opts.opacity, 0, 1);
    dot.style.width = `${size * 2}px`;
    dot.style.height = `${size * 2}px`;
    dot.style.borderRadius = '50%';
    dot.style.background = `radial-gradient(closest-side, rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${alpha}), transparent 70%)`;
    dot.style.filter = 'blur(24px)';
    dot.style.mixBlendMode = currentMode === 'ink' ? 'multiply' : 'screen';
    dot.style.transform = 'translate(-9999px, -9999px)';
  };

  const at = (ev) => {
    const rect = host.getBoundingClientRect();
    dot.style.transform = `translate(${ev.clientX - rect.left - size}px, ${ev.clientY - rect.top - size}px)`;
  };
  const onMove = (ev) => { if (!destroyed && opts.interactive && !opts.paused) at(ev); };
  const onDown = (ev) => { if (!destroyed && opts.interactive && !opts.paused) at(ev); };
  const onLeave = () => { dot.style.transform = 'translate(-9999px, -9999px)'; };
  const onVisibility = () => { if (document.hidden) onLeave(); };

  let fmo = null;
  if (typeof MutationObserver === 'function') {
    fmo = new MutationObserver(() => {
      if (opts.mode !== 'auto') return;
      const next = detectMode(host);
      if (next !== currentMode) {
        currentMode = next;
        paint();
      }
    });
    fmo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
      subtree: true,
    });
  }

  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointerleave', onLeave);
  document.addEventListener('visibilitychange', onVisibility);
  paint();
  console.warn('[inkHalo] 2d context unavailable — using the radial-gradient fallback (no trail).');

  return {
    getMode: () => currentMode,
    getOptions: () => ({ ...opts }),
    getStats: () => ({
      fallback: true,
      mode: currentMode,
      modeOption: opts.mode,
      quality: opts.quality,
      grid: null,
      scale: 0,
      frames: 0,
      lastFrameMs: 0,
      p95FrameMs: 0,
      running: false,
      autoplayActive: false,
      autoStrength: 0,
      idleMs: 0,
      splats: 0,
      passes: 0,
      dyeMax: 0,
      reduceMotion: false,
      degraded: 'no-2d-context',
      color: opts.color,
      paused: opts.paused,
      interactive: opts.interactive,
      stopped: 0,
    }),
    sampleDensity: () => 0,
    rebuild: () => {},
    setOptions(next) {
      for (const key in next) {
        if (next[key] !== undefined) opts[key] = next[key];
      }
      if (!QUALITY.has(opts.quality)) opts.quality = 'medium';
      size = clamp(Number(opts.size) || 56, 2, 600);
      color = parseColor(opts.color) || parseColor(INK_HALO_DEFAULTS.color);
      currentMode = opts.mode === 'auto' ? detectMode(host) : opts.mode;
      paint();
    },
    destroy() {
      destroyed = true;
      if (fmo) fmo.disconnect();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      dot.remove();
    },
  };
}

export function createInkHalo(canvas, options = {}) {
  let opts = normOptions(options);
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('inkHalo: a canvas element is required');
  }

  let ctx = null;
  try {
    ctx = canvas.getContext('2d', { alpha: true });
  } catch (error) {
    ctx = null;
  }
  if (!ctx) return createFallback(canvas, options);

  const host = canvas.parentElement || canvas;
  const core = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 8) : 8;

  // ---------------------------------------------------------------- options
  let color = parseColor(opts.color) || parseColor(INK_HALO_DEFAULTS.color);
  let quality = opts.quality;
  let degraded = null;
  if (opts.autoDegrade && core <= 4) {
    quality = 'low';
    opts.quality = 'low';
    opts.blur = 0;
    degraded = 'hardware';
  }

  // ---------------------------------------------------------------- state
  const renderer = createRenderer(canvas, 1, 1);
  let field = null;
  let grid = { width: 0, height: 0, scale: QUALITY_SCALE[quality] };
  let cssW = 0;
  let cssH = 0;
  let rect = { left: 0, top: 0, width: 1, height: 1 };
  let mode = opts.mode === 'auto' ? detectMode(host) : opts.mode;
  let raf = null;
  let last = nowMs();
  let lastSplat = last;
  let lastInput = last;
  let seen = false;
  let inside = false;
  let pointerValid = false;
  let pointer = { x: 0.5, y: 0.5 };
  let pendingDx = 0;
  let pendingDy = 0;
  let pendingSeed = 0;
  let pendingHas = false;
  let autoStrength = 0;
  let reduceMotion = false;
  let idleTimer = null;
  let destroyed = false;
  let modeQueued = false;
  let splatCount = 0;
  let stopCount = 0;
  let inFrame = false;
  let frames = 0;
  let lastFrameMs = 0;
  let frameCursor = 0;
  let frameCount = 0;
  let degradeChecks = 0;

  const frameTimes = new Float32Array(FRAME_SAMPLES);
  const wanderer = createWanderer({ speed: opts.autoplaySpeed });

  // ---------------------------------------------------------------- motion pref
  const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  function applyMotionPref() {
    if (opts.reducedMotion === 'instant') reduceMotion = true;
    else if (opts.reducedMotion === 'full') reduceMotion = false;
    else reduceMotion = !!(mq && mq.matches);
  }

  function onMotionChange() {
    applyMotionPref();
    if (opts.paused) return;
    if (shouldAutoplay(nowMs())) ensureRunning();
    armIdleTimer();
  }

  // ---------------------------------------------------------------- mode & style
  function applyCanvasStyles() {
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.pointerEvents = 'none';
    canvas.style.opacity = '1';
    canvas.style.mixBlendMode = mode === 'ink' ? 'multiply' : 'screen';
    canvas.style.filter = opts.blur > 0 ? `blur(${opts.blur}px)` : 'none';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.haloMode = mode;
  }

  function resolveMode(notify = true) {
    const next = opts.mode === 'auto' ? detectMode(host) : opts.mode;
    if (next === mode) return;
    mode = next;
    applyCanvasStyles();
    if (raf === null) renderCurrent();
    if (notify && typeof opts.onModeChange === 'function') opts.onModeChange(mode);
  }

  function queueModeCheck() {
    if (modeQueued || destroyed) return;
    modeQueued = true;
    queueMicrotask(() => {
      modeQueued = false;
      if (!destroyed) resolveMode();
    });
  }

  // ---------------------------------------------------------------- sizing
  /** Cache the host box: a getBoundingClientRect() per pointermove forces a
   *  layout flush at 120 Hz. Update it on enter/down/scroll/resize instead. */
  function refreshRect() {
    const r = host.getBoundingClientRect();
    rect = {
      left: r.left,
      top: r.top,
      width: Math.max(1, r.width),
      height: Math.max(1, r.height),
    };
    return rect;
  }

  function measure() {
    refreshRect();
    const w = Math.max(1, Math.round(rect.width || host.clientWidth || 0));
    const h = Math.max(1, Math.round(rect.height || host.clientHeight || 0));
    if (w === cssW && h === cssH && field) return false;
    cssW = w;
    cssH = h;
    return true;
  }

  function buildGrid() {
    grid = gridFor(cssW, cssH, quality);
    field = createField(grid.width, grid.height);
    renderer.resize(grid.width, grid.height);
    renderer.setColor(color);
    renderer.clear();
    canvas.dataset.haloGrid = `${grid.width}x${grid.height}`;
  }

  function rebuild() {
    if (destroyed) return;
    measure();
    buildGrid();
    const now = nowMs();
    last = now;
    lastSplat = now;
    // rebuild() can be called from inside a frame (runtime quality downgrade).
    // Starting a second rAF there would leave two loops running.
    if (!inFrame && raf === null && shouldAutoplay(now)) start();
  }

  // ---------------------------------------------------------------- stats
  function recordFrame(ms) {
    frames++;
    lastFrameMs = ms;
    frameTimes[frameCursor] = ms;
    frameCursor = (frameCursor + 1) % FRAME_SAMPLES;
    if (frameCount < FRAME_SAMPLES) frameCount++;
  }

  function percentile95() {
    if (!frameCount) return 0;
    const copy = Array.from(frameTimes.subarray(0, frameCount));
    copy.sort((a, b) => a - b);
    const index = Math.min(frameCount - 1, Math.ceil(frameCount * 0.95) - 1);
    return copy[index];
  }

  function maybeDegrade() {
    if (!opts.autoDegrade || degraded) return;
    degradeChecks++;
    if (frames < 90 || degradeChecks % 60 !== 0) return;
    if (percentile95() <= 20) return;
    quality = 'low';
    opts.quality = 'low';
    opts.blur = 0;
    degraded = 'runtime';
    applyCanvasStyles();
    rebuild();
  }

  // ---------------------------------------------------------------- loop
  function shouldAutoplay(now) {
    if (!opts.autoplay || opts.paused || reduceMotion) return false;
    if (opts.interactive && inside) return false;
    if (!seen) return true;
    return now - lastInput >= opts.idleDelay * 1000;
  }

  function renderCurrent() {
    if (!field) return;
    renderer.draw(field, { mode, opacity: opts.opacity });
  }

  function start() {
    if (destroyed || opts.paused || document.hidden || raf !== null) return;
    last = nowMs();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
      stopCount++;
    }
  }

  function ensureRunning() {
    if (raf === null) start();
  }

  function flushPointer(dt) {
    if (!pendingHas || !field) return;
    const dye = Math.min(MAX_SPLAT_DYE, pendingSeed + 2 * dt * opts.intensity * DYE_GAIN);
    const touched = splat(field, {
      x: pointer.x,
      y: pointer.y,
      dx: clamp(pendingDx, -MAX_STEP_UV, MAX_STEP_UV),
      dy: clamp(pendingDy, -MAX_STEP_UV, MAX_STEP_UV),
      sizePx: opts.size,
      force: opts.force,
      dye,
      quality: QUALITY_SCALE[quality] ?? grid.scale,
      cssWidth: cssW,
      cssHeight: cssH,
    });
    pendingDx = 0;
    pendingDy = 0;
    pendingSeed = 0;
    pendingHas = false;
    if (touched) {
      splatCount++;
      lastSplat = nowMs();
    }
  }

  function flushWanderer(dt) {
    if (!field || autoStrength <= 0) return;
    // Even at autoplaySpeed 0 the wanderer keeps laying dye where it stands:
    // the strength is what fades, not the brush.
    const at = wanderer.step(dt);
    splat(field, {
      x: at.x,
      y: at.y,
      dx: at.dx,
      dy: at.dy,
      sizePx: opts.size,
      force: opts.force,
      dye: Math.min(MAX_SPLAT_DYE, 2 * dt * opts.intensity * autoStrength * AUTOPLAY_DYE_GAIN),
      quality: QUALITY_SCALE[quality] ?? grid.scale,
      cssWidth: cssW,
      cssHeight: cssH,
    });
    splatCount++;
    lastSplat = nowMs();
  }

  function frame(now) {
    raf = null;
    if (destroyed || opts.paused || document.hidden) return;
    inFrame = true;

    const dt = clamp((now - last) / 1000, 0, 1 / 30);
    last = now;
    const t0 = nowMs();

    const target = shouldAutoplay(now) ? 1 : 0;
    autoStrength = stepFade(autoStrength, target, dt);

    flushPointer(dt);
    flushWanderer(dt);

    step(field, dt, {
      trail: opts.trail,
      drift: opts.drift,
      iterations: opts.iterations,
    });
    renderCurrent();

    const work = nowMs() - t0;
    recordFrame(work);
    maybeDegrade();

    const stopAfter = (Math.max(opts.trail, opts.drift) * 3 + STOP_PAD) * 1000;
    const keep = autoStrength > 0 || now - lastSplat < stopAfter;
    if (keep) raf = requestAnimationFrame(frame);
    else stopCount++;
    inFrame = false;
  }

  // ---------------------------------------------------------------- input
  function uvFromEvent(ev) {
    return {
      x: clamp((ev.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((ev.clientY - rect.top) / rect.height, 0, 1),
    };
  }

  function clearIdleTimer() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  /** If idleDelay is longer than the decay window, the loop will have stopped
   *  before the wanderer is allowed back. That is what this timer is for. */
  function armIdleTimer() {
    clearIdleTimer();
    if (!opts.autoplay || opts.paused || reduceMotion || destroyed) return;
    if (opts.interactive && inside) return;
    if (!seen && shouldAutoplay(nowMs())) return; // already allowed, loop started
    const wait = seen ? opts.idleDelay * 1000 : 0;
    if (wait <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!destroyed && shouldAutoplay(nowMs())) ensureRunning();
    }, wait + 32);
  }

  function onPointerEnter(ev) {
    if (!opts.interactive) return;
    refreshRect();
    clearIdleTimer();
    inside = true;
    seen = true;
    lastInput = nowMs();
    pointer = uvFromEvent(ev);
    pointerValid = true;
    pendingDx = 0;
    pendingDy = 0;
  }

  function onPointerMove(ev) {
    if (!opts.interactive) return;
    if (!inside) refreshRect();
    clearIdleTimer();
    const next = uvFromEvent(ev);
    if (!inside) {
      inside = true;
      seen = true;
      pointer = next;
      pointerValid = true;
      lastInput = nowMs();
      ensureRunning();
      return;
    }
    let dx = 0;
    let dy = 0;
    if (pointerValid) {
      dx = next.x - pointer.x;
      dy = next.y - pointer.y;
    }
    pointer = next;
    pointerValid = true;
    seen = true;
    lastInput = nowMs();
    if (dx || dy) {
      pendingDx += dx;
      pendingDy += dy;
      pendingHas = true;
    }
    ensureRunning();
  }

  function onPointerDown(ev) {
    if (!opts.interactive) return;
    refreshRect();
    clearIdleTimer();
    inside = true;
    seen = true;
    lastInput = nowMs();
    pointer = uvFromEvent(ev);
    pointerValid = true;
    // touchstart seed: a tap has no movement, so without this it would leave
    // nothing at all. One visible dot, then normal decay.
    pendingSeed = Math.min(MAX_SPLAT_DYE, pendingSeed + 1.5 * opts.intensity);
    pendingHas = true;
    ensureRunning();
  }

  function onPointerUp(ev) {
    if (ev && ev.pointerType && ev.pointerType !== 'mouse') {
      // touchend behaves like pointerleave: the finger is gone, and the idle
      // wanderer is allowed back after idleDelay
      inside = false;
      lastInput = nowMs();
      pointerValid = false;
      armIdleTimer();
    }
  }

  function onPointerLeave() {
    inside = false;
    lastInput = nowMs();
    pointerValid = false;
    if (raf === null && opts.autoplay && !reduceMotion) ensureRunning();
    armIdleTimer();
  }

  function onVisibility() {
    if (document.hidden) {
      stop();
      return;
    }
    last = nowMs();
    refreshRect();
    if (opts.paused) return;
    if (shouldAutoplay(nowMs()) || (field && maxDye(field) > 1e-3)) ensureRunning();
    armIdleTimer();
  }

  // ---------------------------------------------------------------- observers
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      if (destroyed) return;
      if (measure()) {
        buildGrid();
        const now = nowMs();
        last = now;
        lastSplat = now;
      }
    });
    ro.observe(host);
  }

  let mo = null;
  if (typeof MutationObserver === 'function') {
    mo = new MutationObserver(queueModeCheck);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
      subtree: true,
    });
  }

  // ---------------------------------------------------------------- lifecycle
  applyMotionPref();
  applyCanvasStyles();
  measure();
  buildGrid();
  last = nowMs();
  lastSplat = last;

  host.addEventListener('pointerenter', onPointerEnter);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  host.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('scroll', refreshRect, { passive: true, capture: true });
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', onMotionChange);
    else if (mq.addListener) mq.addListener(onMotionChange);
  }

  if (shouldAutoplay(nowMs())) start();
  else armIdleTimer();

  return {
    getMode: () => mode,
    getOptions: () => ({ ...opts }),
    getStats: () => ({
      fallback: false,
      mode,
      modeOption: opts.mode,
      quality,
      grid: { ...grid },
      scale: grid.scale,
      frames,
      lastFrameMs,
      p95FrameMs: percentile95(),
      running: raf !== null,
      autoplayActive: autoStrength > 0.001,
      autoStrength,
      idleMs: Math.max(0, nowMs() - lastInput),
      splats: splatCount,
      passes: opts.iterations + 4,
      dyeMax: field ? maxDye(field) : 0,
      reduceMotion,
      degraded,
      color: opts.color,
      paused: opts.paused,
      interactive: opts.interactive,
      stopped: stopCount,
      seen,
    }),
    sampleDensity: (x, y) => (field ? sampleField(field, field.d, x, y) : 0),
    rebuild,
    setOptions(next) {
      if (!next) return;
      const previous = { ...opts };
      for (const key in next) {
        if (next[key] === undefined) continue;
        opts[key] = next[key];
      }
      const degradedNow = degraded;
      opts = normOptions(opts);
      degraded = degradedNow;
      if (!QUALITY.has(opts.quality)) opts.quality = 'medium';
      if (degraded) {
        // once downgraded, stay at low until a new instance: this is the
        // device/frame-time decision, not a preference
        quality = 'low';
        opts.quality = 'low';
        opts.blur = 0;
      }

      if (opts.color !== previous.color) {
        color = parseColor(opts.color) || parseColor(INK_HALO_DEFAULTS.color);
        renderer.setColor(color);
      }
      wanderer.setSpeed(opts.autoplaySpeed);
      applyMotionPref();

      if (opts.quality !== previous.quality && !degraded) {
        quality = opts.quality;
        rebuild();
      }
      if (opts.blur !== previous.blur) applyCanvasStyles();
      if (opts.mode !== previous.mode) resolveMode();
      if (opts.paused) {
        stop();
        pendingDx = 0;
        pendingDy = 0;
        pendingSeed = 0;
        pendingHas = false;
        pointerValid = false;
        renderCurrent();
      } else if (previous.paused) {
        last = nowMs();
        pendingDx = 0;
        pendingDy = 0;
        pendingSeed = 0;
        pendingHas = false;
        pointerValid = false;
        ensureRunning();
      }
      if (!opts.interactive) {
        inside = false;
        pendingHas = false;
        pointerValid = false;
      }
      if (opts.paused) {
        clearIdleTimer();
      } else {
        if (shouldAutoplay(nowMs()) || (field && maxDye(field) > 1e-3)) ensureRunning();
        armIdleTimer();
      }
      if (raf === null) renderCurrent();
    },
    destroy() {
      destroyed = true;
      clearIdleTimer();
      stop();
      if (ro) ro.disconnect();
      if (mo) mo.disconnect();
      host.removeEventListener('pointerenter', onPointerEnter);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('scroll', refreshRect, { capture: true });
      if (mq) {
        if (mq.removeEventListener) mq.removeEventListener('change', onMotionChange);
        else if (mq.removeListener) mq.removeListener(onMotionChange);
      }
      renderer.clear();
      renderer.destroy();
      field = null;
    },
  };
}

export default createInkHalo;
