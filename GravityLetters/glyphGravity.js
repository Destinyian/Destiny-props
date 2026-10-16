/**
 * glyphGravity — engine for "gravity letters": text rasterised into a grid of
 * character particles that can be peeled away by the pointer, collapsed into a
 * sand-pile, and restored.
 *
 * SSR-safe by construction: this module touches no DOM at import time. Everything
 * happens inside createGlyphGravity(), which you call from an effect.
 *
 * Particle modes
 *   attached : glued to its target (the sampled text), with a subtle jitter
 *   falling  : gravity + drag; lands on a column of the pile
 *   resting  : part of the pile, seated by its column
 *   returning: spring back to the target
 *
 * Pile model (v2 — particle-level sand pile, not a per-column height field)
 *   Every resting particle belongs to a column stack. A falling particle rolls to
 *   the lowest of its neighbouring columns, and every frame the stacks are relaxed:
 *   whenever one column stands more than `repose` px above a neighbour, its top
 *   particle is handed over to that neighbour. Mass therefore flows sideways,
 *   gaps between letters fill in by themselves, and the result is the continuous
 *   steep mountain range the reference look needs — instead of per-letter spikes.
 */

const MODE = { ATTACHED: 0, FALLING: 1, RESTING: 2, RETURNING: 3 };

export const GLYPH_GRAVITY_DEFAULTS = {
  text: 'GRAVITY\nLETTERS',
  /** glyph pool: plain English letters by default — symbols (#, %, @ …) make the
   *  text read as noise rather than as lettering */
  characters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  /** sampling step in CSS px: smaller = denser = more characters */
  density: 7,
  /** glyph draw size in px; 0 = derived from density */
  glyphSize: 0,
  maxParticles: 14000,
  color: '#ece9ff',
  /** colour for glyphs that have been knocked out of the text (peeled or collapsed);
   *  set it equal to color to disable the tint */
  fallColor: '#a9c8ff',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontWeight: '600',
  lineHeight: 1.06,
  /** text block padding inside the canvas, CSS px */
  padding: 24,
  gravity: 2000,
  eraseRadius: 48,
  /** how the pointer peels glyphs: 'hover' = move over them (no button needed),
   *  'drag' = only while pressed, 'both' = either */
  eraseMode: 'hover',
  /** px of movement above which a press is a drag, not a click */
  dragThreshold: 6,
  /** a press shorter than this toggles collapse (600ms fits real humans: press,
   *  brief pause, release). In hover mode movement while pressed does not matter. */
  clickMaxMs: 600,
  /** pile slope: max height difference between neighbouring columns, px.
   *  bigger = steeper, taller, more separated peaks */
  repose: 9,
  /** idle glyph shuffling, per particle per second. 0 (default) = each glyph is
   *  randomised once while the text forms and then stays put. */
  shuffle: 0,
  /** random rotation for released glyphs — this is what gives the pile its
   *  granular sand look. false keeps a crisp, strictly upright grid. */
  glyphRotation: true,
  /** how many distinct rotation angles are used (quantised: keeps glyph rasterisation cheap) */
  rotationAngles: 8,
  /** diagnostic only: restore with an underdamped spring (overshoots, for A/B comparison) */
  restoreSpring: false,
  /** true: on collapse, compute the settled pile up-front and let every glyph slide
   *  to its final slot while falling, so the pile is static the moment it lands.
   *  false: let the sand flow settle it frame by frame (visibly shuffles). */
  staticSettle: true,
  /** auto-restore after this many ms without any pointer/keyboard interaction.
   *  0 disables it. The timer restarts on every interaction. */
  autoRestoreMs: 10000,
  /** 'auto' | 'instant' | 'full' */
  reducedMotion: 'auto',
  /** called with 'formed' | 'collapsing' | 'piled' | 'restoring' */
  onStateChange: null,
};

/** vertical distance between two stacked glyphs, as a fraction of glyph size.
 *  < 1 makes the pile read as a solid mass instead of a dotted grid. */
const PACKING = 0.44;
/** glyph size as a fraction of the sampling step */
const GLYPH_RATIO = 1.75;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);

export function createGlyphGravity(canvas, options = {}) {
  // undefined values must not clobber a default: { color: undefined } would otherwise
  // leave fillStyle unset and the text invisible.
  const opts = { ...GLYPH_GRAVITY_DEFAULTS };
  for (const k in options) if (options[k] !== undefined) opts[k] = options[k];
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('glyphGravity: 2d context unavailable');

  // ---------------------------------------------------------------- state
  let particles = [];
  let colPiles = [];            // colPiles[c] = array of particles, bottom-first
  let colJitter = new Float32Array(1);   // per-column repose variation
  let cellW = 8;
  let cols = 1;
  let packing = 5;
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;
  let glyphSize = 10;
  let state = 'formed';
  let raf = null;
  let last = 0;
  let destroyed = false;
  let frameMs = 16;
  let stepMs = 0;
  let drawMs = 0;
  let reduceMotion = false;
  let pileActive = false;       // true while the pile is still flowing sideways
  let settleMoves = 0;          // particle transfers since the last collapse (diagnostic)
  let pendingLanding = 0;       // glyphs still flying to a precomputed slot (suppresses flow)
  let lastMoves = 0;            // transfers performed in the last frame (diagnostic)
  let idleTimer = null;         // auto-restore countdown
  let returnOvershoots = 0;     // times a returning glyph crossed its target (must stay 0)
  let riseCount = 0;            // times a falling glyph ever moved upward (must stay 0)
  const pointer = { x: -1e5, y: -1e5, active: false, down: false, moved: 0, downAt: 0, id: -1 };
  let suppressClickUntil = 0;
  let glyphPool = opts.characters.length ? opts.characters : 'X';
  const ROT_N = Math.max(2, Math.min(64, (opts.rotationAngles | 0) || 8));
  const ROT_COS = new Float32Array(ROT_N);
  const ROT_SIN = new Float32Array(ROT_N);
  for (let i = 0; i < ROT_N; i++) {
    const a = (i * 2 * Math.PI) / ROT_N;
    ROT_COS[i] = Math.cos(a);
    ROT_SIN[i] = Math.sin(a);
  }
  const angleOf = (p) => (p.rotTarget = opts.glyphRotation ? (p.ai * 2 * Math.PI) / ROT_N : 0);

  const emit = () => { if (typeof opts.onStateChange === 'function') opts.onStateChange(state); };
  const needsRestore = () => particles.some((p) => p.m !== MODE.ATTACHED);
  /** (re)start the idle countdown: after autoRestoreMs with no interaction the text
   *  reassembles by itself, so a visitor who walks away does not leave it destroyed */
  function armAutoRestore() {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    const ms = opts.autoRestoreMs | 0;
    if (ms <= 0 || destroyed) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!destroyed && state !== 'restoring' && needsRestore()) restore();
    }, ms);
  }
  const setState = (s) => { if (state !== s) { state = s; emit(); } };
  const groundY = () => cssH - 2;

  // ---------------------------------------------------------------- pile primitives
  const columnOf = (x) => clamp(Math.floor(x / cellW), 0, cols - 1);

  /** re-seat a whole column. Only for the reduced-motion path and after removals —
   *  never in the hot loop, where single-particle seating is enough. */
  function settleCol(c) {
    const stack = colPiles[c];
    const base = groundY();
    for (let i = 0; i < stack.length; i++) {
      const p = stack[i];
      p.x = (c + 0.5) * cellW + (p.jx || 0);
      p.y = base - (i + 0.5) * packing + (p.jy || 0) * packing;
      p.vx = 0;
      p.vy = 0;
      p.m = MODE.RESTING;
      p.col = c;
    }
  }

  /** O(1) seating for the particle that just became the top of a column */
  function seatTop(c) {
    const stack = colPiles[c];
    const p = stack[stack.length - 1];
    if (!p) return;
    p.x = (c + 0.5) * cellW + (p.jx || 0);
    p.y = groundY() - (stack.length - 0.5) * packing + (p.jy || 0) * packing;
    p.vx = 0;
    p.vy = 0;
    p.m = MODE.RESTING;
    p.col = c;
  }

  function detachFromPile(p) {
    if (p.col < 0 || p.col >= cols) return;
    const stack = colPiles[p.col];
    const i = stack.indexOf(p);
    if (i >= 0) {
      stack.splice(i, 1);
      settleCol(p.col);
      pileActive = true;
    }
    p.col = -1;
  }

  /** Work out the settled pile *before* anything moves: relax the mass histogram by the
   *  same angle-of-repose rule, then give every glyph the column it will end up in.
   *  Because the result is already a fixed point of relaxPile(), the pile is static as
   *  soon as the last glyph lands — no post-landing shuffling. */
  function presettleColumns() {
    const counts = new Int32Array(cols);
    for (const p of particles) counts[columnOf(p.x)]++;
    const need = Math.max(2, Math.round(opts.repose / packing));
    for (let pass = 0; pass < 600; pass++) {
      let moved = 0;
      for (let c = 0; c < cols - 1; c++) {
        if (counts[c] - counts[c + 1] >= need) { counts[c]--; counts[c + 1]++; moved++; }
        else if (counts[c + 1] - counts[c] >= need) { counts[c + 1]--; counts[c]++; moved++; }
      }
      if (moved === 0) break;
    }
    // keep left-to-right coherence: glyphs are handed out in their own x order
    const order = particles.map((p, i) => i).sort((a, b) => particles[a].x - particles[b].x);
    let k = 0;
    for (let c = 0; c < cols; c++) {
      for (let i = 0; i < counts[c] && k < order.length; i++) {
        const p = particles[order[k++]];
        p.landCol = c;
        p.landX = (c + 0.5) * cellW;
      }
    }
  }

  /** seat a falling particle: at its precomputed slot when there is one, otherwise by
   *  rolling to the lowest column in a small window (the dynamic / peel case) */
  function land(p) {
    let best;
    if (p.landCol >= 0) {
      best = p.landCol;
      p.landCol = -1;
      pendingLanding = Math.max(0, pendingLanding - 1);
    } else {
      const c0 = columnOf(p.x);
      best = c0;
      let bestLen = colPiles[c0].length;
      for (let d = -1; d <= 1; d += 2) {
        const c = c0 + d;
        if (c < 0 || c >= cols) continue;
        const len = colPiles[c].length;
        if (len < bestLen) { bestLen = len; best = c; }
      }
    }
    colPiles[best].push(p);
    seatTop(best);
  }

  /** Angle-of-repose relaxation: hand the top glyph of a too-tall column to a lower
   *  neighbour. A transfer requires a **two-glyph** difference — with a one-glyph
   *  threshold two neighbours trade the same particle back and forth forever and the
   *  pile never settles. */
  function relaxPile(passes) {
    const needBase = opts.repose / packing;
    let moved = 0;
    for (let pass = 0; pass < passes; pass++) {
      for (let c = 0; c < cols; c++) {
        const stack = colPiles[c];
        const len = stack.length;
        if (!len) continue;
        for (let d = -1; d <= 1; d += 2) {
          const n = c + d;
          if (n < 0 || n >= cols) continue;
          const need = Math.max(2, Math.round(needBase * (colJitter[c] || 1)));
          if (len - colPiles[n].length >= need) {
            colPiles[n].push(stack.pop());
            seatTop(n);
            moved++;
            settleMoves++;
            break;
          }
        }
      }
    }
    return moved;
  }

  // ---------------------------------------------------------------- sampling
  function syncSize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || canvas.clientWidth || 0));
    const h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 0));
    dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    cssW = w; cssH = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Sample the text into particle targets. Coarsens density until it fits maxParticles. */
  function build() {
    syncSize();
    glyphPool = opts.characters.length ? opts.characters : 'X';   // props can change it
    const lines = String(opts.text).split('\n');
    const pad = opts.padding;
    const availW = Math.max(32, cssW - pad * 2);
    const availH = Math.max(32, cssH - pad * 2);

    const measure = (size) => {
      ctx.font = `${opts.fontWeight} ${size}px ${opts.fontFamily}`;
      let w = 0;
      for (const l of lines) w = Math.max(w, ctx.measureText(l || ' ').width);
      return { w, h: size * opts.lineHeight * lines.length };
    };
    let size = 24;
    let box = measure(size);
    size = clamp(size * Math.min(availW / box.w, availH / box.h), 8, 4000);
    box = measure(size);
    if (box.w > availW || box.h > availH) size *= Math.min(availW / box.w, availH / box.h);
    const lineH = size * opts.lineHeight;

    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.round(cssW));
    off.height = Math.max(1, Math.round(cssH));
    const octx = off.getContext('2d');
    octx.clearRect(0, 0, off.width, off.height);
    octx.font = `${opts.fontWeight} ${size}px ${opts.fontFamily}`;
    octx.fillStyle = '#fff';
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    const blockTop = (cssH - lineH * lines.length) / 2 + lineH / 2;
    lines.forEach((line, i) => octx.fillText(line, cssW / 2, blockTop + i * lineH));

    let mask = null;
    try { mask = octx.getImageData(0, 0, off.width, off.height).data; } catch (e) { mask = null; }
    const alphaAt = (x, y) => {
      if (!mask) return 255;
      return mask[(y * off.width + x) * 4 + 3];
    };

    let step = clamp(opts.density, 3, 40);
    glyphSize = opts.glyphSize > 0 ? opts.glyphSize : Math.max(6, step * GLYPH_RATIO);
    let list = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      list = [];
      const half = step / 2;
      for (let y = Math.round(half); y < cssH; y += step) {
        for (let x = Math.round(half); x < cssW; x += step) {
          if (alphaAt(x, y) > 128) {
            list.push({ x, y, tx: x, ty: y, vx: 0, vy: 0, m: MODE.ATTACHED, col: -1,
                        jx: rand(-0.04, 0.04) * step,   // sub-pixel only: keeps the lattice crisp
                        jy: rand(-0.04, 0.04),
                        rot: 0, rotTarget: 0, ai: (Math.random() * ROT_N) | 0,
                        landCol: -1, landX: 0,
                        ch: glyphPool[(Math.random() * glyphPool.length) | 0] });
          }
        }
      }
      if (list.length <= opts.maxParticles) break;
      step += 2;
      glyphSize = opts.glyphSize > 0 ? opts.glyphSize : Math.max(6, step * GLYPH_RATIO);
    }
    particles = list;

    cellW = Math.max(4, step);
    cols = Math.max(1, Math.ceil(cssW / cellW));
    packing = Math.max(2.5, glyphSize * PACKING);
    colPiles = Array.from({ length: cols }, () => []);
    // per-column repose jitter: a perfectly uniform repose produces a mechanical
    // sawtooth; varying it gives the organic, uneven peaks the reference has.
    colJitter = new Float32Array(cols);
    for (let i = 0; i < cols; i++) colJitter[i] = 0.55 + Math.random() * 0.9;
    pileActive = false;
    setState('formed');
  }

  // ---------------------------------------------------------------- interaction
  function eraseAt(x, y) {
    const r2 = opts.eraseRadius * opts.eraseRadius;
    let hits = 0;
    for (const p of particles) {
      if (p.m === MODE.FALLING || p.m === MODE.RETURNING) continue;
      const dx = p.x - x, dy = p.y - y;
      if (dx * dx + dy * dy > r2) continue;
      if (p.m === MODE.RESTING) detachFromPile(p);
      p.m = MODE.FALLING;
      angleOf(p);
      p.vx = dx * 1.6 + rand(-12, 12);
      p.vy = rand(10, 80);
      hits++;
    }
    return hits;
  }

  // ---------------------------------------------------------------- simulation
  function step(dt) {
    const g = opts.gravity;
    for (const p of particles) {
      if (p.rot !== p.rotTarget) {                 // released glyphs spin out, restored ones spin back
        const kr = 1 - Math.exp(-8 * dt);
        p.rot += (p.rotTarget - p.rot) * kr;
        if (Math.abs(p.rot - p.rotTarget) < 0.01) p.rot = p.rotTarget;
      }
      switch (p.m) {
        case MODE.ATTACHED: {
          const k = 1 - Math.exp(-12 * dt);
          p.x += (p.tx - p.x) * k;
          p.y += (p.ty - p.y) * k;
          if (opts.shuffle > 0 && !reduceMotion && Math.random() < opts.shuffle * dt) {
            p.ch = glyphPool[(Math.random() * glyphPool.length) | 0];
          }
          break;
        }
        case MODE.FALLING: {
          p.vy += g * dt;
          if (p.vy < 0) riseCount++;
          p.vx *= 0.99;
          p.y += p.vy * dt;
          let c;
          if (p.landCol >= 0) {
            // slide toward the settled column instead of shuffling there after landing
            p.x += (p.landX - p.x) * (1 - Math.exp(-6 * dt));
            c = p.landCol;
          } else {
            p.x += p.vx * dt;
            if (p.x < 0) { p.x = 0; p.vx = Math.abs(p.vx) * 0.3; }
            else if (p.x > cssW) { p.x = cssW; p.vx = -Math.abs(p.vx) * 0.3; }
            c = columnOf(p.x);
          }
          if (p.y >= groundY() - colPiles[c].length * packing - packing * 0.5) land(p);
          break;
        }
        case MODE.RESTING:
          break;
        case MODE.RETURNING: {
          if (opts.restoreSpring) {          // diagnostic path only: underdamped, overshoots
            const stiff = 120;
            const damp = Math.exp(-9 * dt);
            p.vx = (p.vx + (p.tx - p.x) * stiff * dt) * damp;
            p.vy = (p.vy + (p.ty - p.y) * stiff * dt) * damp;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
          } else {
            // monotone exponential approach: maximum speed on release, then a smooth
            // settle. Never crosses the target, so the text cannot bounce or shake.
            const k = 1 - Math.exp(-12 * dt);
            p.x += (p.tx - p.x) * k;
            p.y += (p.ty - p.y) * k;
            p.vx = 0;
            p.vy = 0;
          }
          const sx = Math.sign(p.tx - p.x);
          if (p.sgn !== 0 && sx !== 0 && sx !== p.sgn) returnOvershoots++;
          p.sgn = sx;
          if (Math.abs(p.tx - p.x) < 0.4 && Math.abs(p.ty - p.y) < 0.4) {
            p.x = p.tx; p.y = p.ty; p.vx = 0; p.vy = 0; p.m = MODE.ATTACHED;
          }
          break;
        }
      }
    }
    // let the pile flow sideways. Driven by *actual* movement (not a counter that
    // only drains), so it always terminates and 'piled' is reached.
    const falling = anyFalling();
    if (pendingLanding > 0) {
      // the settled pile was computed up-front, so the columns are already balanced in
      // the end state: flowing now would only make the pile visibly shuffle
      lastMoves = 0;
      pileActive = false;
    } else {
      lastMoves = (falling || pileActive) ? relaxPile(2) : 0;
      pileActive = lastMoves > 0;
    }
    return falling;
  }

  function anyFalling() {
    for (const p of particles) if (p.m === MODE.FALLING) return true;
    return false;
  }
  /** falling OR flying home — the render loop must keep running for both */
  function anyMoving() {
    for (const p of particles) if (p.m === MODE.FALLING || p.m === MODE.RETURNING) return true;
    return false;
  }
  const allResting = () => particles.length > 0 && particles.every((p) => p.m === MODE.RESTING);
  const allAttached = () => particles.length > 0 && particles.every((p) => p.m === MODE.ATTACHED);

  // ---------------------------------------------------------------- render
  /** draw one colour group; batching by colour means two fillStyle switches per
   *  frame instead of one per glyph */
  function drawGroup(color, include, useRotation) {
    ctx.fillStyle = color;
    let rotated = false;
    for (const p of particles) {
      if (!include(p)) continue;
      if (useRotation && p.rot !== 0) {
        if (!rotated) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); rotated = true; }
        const i = p.ai % ROT_N;
        const c = ROT_COS[i], s = ROT_SIN[i];
        ctx.setTransform(dpr * c, dpr * s, -dpr * s, dpr * c, dpr * p.x, dpr * p.y);
        ctx.fillText(p.ch, 0, 0);
      } else {
        // reset first: otherwise this glyph is drawn through the previous particle's
        // rotation matrix and lands somewhere else entirely
        if (rotated) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); rotated = false; }
        ctx.fillText(p.ch, Math.round(p.x), Math.round(p.y));
      }
    }
    if (rotated) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.font = `${opts.fontWeight} ${glyphSize}px ${opts.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 1) glyphs sitting in the text: no transform, and they own the base colour
    // integer positions: sub-pixel placement blurs small glyphs and makes the grid
    // look ragged, which is exactly what "tidy" is asking us to avoid
    ctx.fillStyle = opts.color;
    for (const p of particles) {
      if (p.m === MODE.ATTACHED && p.rot === 0) {
        ctx.fillText(p.ch, Math.round(p.x), Math.round(p.y));
      }
    }
    // 2) glyphs flying home keep the base colour
    drawGroup(opts.color,
      (p) => (p.m === MODE.ATTACHED || p.m === MODE.RETURNING) && p.rot !== 0,
      true);
    // 3) knocked-out glyphs (peeled or collapsed) take the accent colour
    const accent = !!opts.fallColor && opts.fallColor !== opts.color;
    drawGroup(accent ? opts.fallColor : opts.color,
      (p) => p.m === MODE.FALLING || p.m === MODE.RESTING,
      opts.glyphRotation);
  }
  function frame(now) {
    if (destroyed) return;
    const dt = clamp((now - last) / 1000, 0.001, 0.05);   // clamp: a resumed tab must not teleport everything
    last = now;
    const t0 = performance.now();
    const falling = step(dt);
    const t1 = performance.now();
    draw();
    const t2 = performance.now();
    stepMs = stepMs * 0.9 + (t1 - t0) * 0.1;
    drawMs = drawMs * 0.9 + (t2 - t1) * 0.1;
    frameMs = stepMs + drawMs;

    if (state === 'collapsing' && !falling && !pileActive && allResting()) setState('piled');
    if (state === 'restoring' && allAttached()) setState('formed');

    // Nothing left to animate (settled, no shimmer, no rotation still lerping):
    // stop the loop completely — any interaction calls ensureRunning() again.
    const busy = anyMoving() || pileActive || opts.shuffle > 0
      || particles.some((p) => p.rot !== p.rotTarget);
    if (!busy || destroyed) { raf = null; return; }
    raf = requestAnimationFrame(frame);
  }

  function ensureRunning() {
    if (destroyed || raf !== null) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- public
  function collapse() {
    colPiles = Array.from({ length: cols }, () => []);
    settleMoves = 0;
    for (const p of particles) { p.col = -1; p.landCol = -1; }
    for (const p of particles) {
      p.m = MODE.FALLING;
      angleOf(p);
      p.vx = 0;                      // the whole sheet drops as one: no scatter, no
      p.vy = 0;                      // spin-up — every glyph starts falling together
    }
    if (opts.staticSettle) {
      presettleColumns();
      pendingLanding = particles.length;   // while these are in the air, no flow needed:
    }                                      // every column will receive exactly its quota
    pileActive = true;
    setState('collapsing');
    if (reduceMotion) { runToRest(); return; }   // …and reduced motion skips the animation
    ensureRunning();
  }

  /** synchronous settle, used for reduced-motion */
  function runToRest(maxSteps = 900) {
    for (let i = 0; i < maxSteps; i++) {
      if (!step(1 / 60) && !pileActive) break;
    }
    for (let c = 0; c < cols; c++) if (colPiles[c].length) settleCol(c);
    setState(allResting() ? 'piled' : state);
    ensureRunning();
  }

  function restore() {
    colPiles = Array.from({ length: cols }, () => []);
    pileActive = false;
    returnOvershoots = 0;
    pendingLanding = 0;
    for (const p of particles) {
      p.col = -1; p.landCol = -1; p.m = MODE.RETURNING; p.rotTarget = 0; p.sgn = 0;
    }
    setState('restoring');
    ensureRunning();
  }

  function toggle() {
    if (state === 'piled' || state === 'collapsing') restore();
    else collapse();
  }

  function reset() {
    colPiles = Array.from({ length: cols }, () => []);
    pileActive = false;
    pendingLanding = 0;
    for (const p of particles) {
      p.x = p.tx; p.y = p.ty; p.vx = 0; p.vy = 0; p.m = MODE.ATTACHED; p.col = -1; p.landCol = -1;
      p.rot = 0; p.rotTarget = 0;
    }
    setState('formed');
    ensureRunning();
  }

  // ---------------------------------------------------------------- input
  function localPoint(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function onPointerDown(ev) {
    if (!ev.isPrimary || (ev.button !== undefined && ev.button !== 0)) return;
    const { x, y } = localPoint(ev);
    pointer.x = x; pointer.y = y; pointer.active = true; pointer.down = true;
    pointer.moved = 0; pointer.downAt = performance.now(); pointer.id = ev.pointerId;
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic events */ } }
    ensureRunning();
    armAutoRestore();
    if (opts.eraseMode === 'both') eraseAt(x, y);
  }

  function onPointerMove(ev) {
    const { x, y } = localPoint(ev);
    if (pointer.down) pointer.moved += Math.abs(x - pointer.x) + Math.abs(y - pointer.y);
    pointer.x = x; pointer.y = y; pointer.active = true;
    const erasing = opts.eraseMode === 'hover' || opts.eraseMode === 'both'
      || (opts.eraseMode === 'drag' && pointer.down);
    if (erasing) { eraseAt(x, y); ensureRunning(); armAutoRestore(); }
  }

  function onPointerUp(ev) {
    if (pointer.id !== -1 && ev && ev.pointerId !== undefined && ev.pointerId !== pointer.id) return;
    // In hover mode peeling is driven by pointer movement alone, so press/release is
    // unambiguous: it is a click. With a real mouse an intended click routinely
    // travels more than dragThreshold, which used to swallow the collapse gesture.
    const dragGesture = opts.eraseMode !== 'hover';
    const wasDrag = dragGesture && pointer.moved > opts.dragThreshold;
    const dur = performance.now() - pointer.downAt;
    pointer.down = false; pointer.id = -1;
    if (canvas.releasePointerCapture && ev && ev.pointerId !== undefined) {
      try { if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    }
    armAutoRestore();
    if (wasDrag) { suppressClickUntil = performance.now() + 300; return; }
    if (dur <= opts.clickMaxMs && performance.now() >= suppressClickUntil) toggle();
  }

  function onPointerLeave() {
    pointer.active = false; pointer.x = -1e5; pointer.y = -1e5;
    if (pointer.down) { pointer.down = false; pointer.id = -1; }
  }

  function onKeyDown(ev) {
    if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); toggle(); }
    else if (ev.key === 'r' || ev.key === 'R') { ev.preventDefault(); reset(); }
  }

  function onVisibility() {
    if (document.hidden) { if (raf !== null) { cancelAnimationFrame(raf); raf = null; } }
    else ensureRunning();
  }

  // ---------------------------------------------------------------- lifecycle
  const mq = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const applyMotionPref = () => {
    const pref = opts.reducedMotion;
    reduceMotion = pref === 'instant' ? true : pref === 'full' ? false : !!(mq && mq.matches);
  };
  applyMotionPref();

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      const wasCollapsed = state === 'piled' || state === 'collapsing';
      const wasDamaged = needsRestore();
      build();
      if (wasCollapsed || wasDamaged) collapse();
      ensureRunning();
    });
    ro.observe(canvas);
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('lostpointercapture', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', onVisibility);
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', applyMotionPref);
    else if (mq.addListener) mq.addListener(applyMotionPref);
  }

  build();
  ensureRunning();

  // re-sample once the webfont has loaded (metrics change after it does)
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
    document.fonts.ready.then(() => {
      // only re-sample while the user has not touched anything: a late font load
      // must never silently undo peeling or a collapse
      if (!destroyed && state === 'formed' && !needsRestore()) { build(); ensureRunning(); }
    }).catch(() => {});
  }

  return {
    collapse, restore, toggle, reset,
    rebuild: () => { build(); ensureRunning(); },
    getState: () => state,
    getParticleCount: () => particles.length,
    getStats: () => ({
      particleCount: particles.length,
      frameMs,
      stepMs,
      drawMs,
      state,
      dpr,
      reduceMotion,
      glyphSize,
      lastMoves,
      pileActive,
      settleMoves,
      running: raf !== null,
      returnOvershoots,
      riseCount,
      // cheap rolling checksum of the glyphs: if it stops changing, the letters
      // have settled (used by the demo to prove shuffling is off)
      glyphHash: particles.reduce((h, p, i) => (h + p.ch.charCodeAt(0) * (i + 1)) % 2147483647, 0),
      released: particles.reduce((n, p) => n + (p.m === MODE.ATTACHED ? 0 : 1), 0),
      pileTop: Math.max(0, Math.round(Math.max(...colPiles.map((c) => c.length), 0) * packing)),
    }),
    setOptions(next) {
      const STRUCTURAL = ['text', 'density', 'characters', 'fontFamily', 'fontWeight',
        'glyphSize', 'padding', 'lineHeight'];
      const needsRebuild = STRUCTURAL.some((k) => next[k] !== undefined && next[k] !== opts[k]);
      for (const k in next) if (next[k] !== undefined) opts[k] = next[k];
      applyMotionPref();
      if (needsRebuild) build();
      else if (next.repose !== undefined) pileActive = true;
      armAutoRestore();
      ensureRunning();
    },
    destroy() {
      destroyed = true;
      if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      if (ro) ro.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('lostpointercapture', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibility);
      if (mq) {
        if (mq.removeEventListener) mq.removeEventListener('change', applyMotionPref);
        else if (mq.removeListener) mq.removeListener(applyMotionPref);
      }
      particles = [];
      colPiles = [];
      ctx.clearRect(0, 0, cssW, cssH);
    },
  };
}
