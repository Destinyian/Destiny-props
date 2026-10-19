/**
 * inkField — the whole simulation of the Ink Halo, as pure functions over a
 * Float32 grid. No DOM, no globals, no allocation inside the hot passes.
 *
 * The model is the one described in the clean-room spec:
 *
 *   velocity + dye  ->  semi-Lagrangian advection  ->  Jacobi pressure projection
 *                   ->  two independent exponential decays
 *
 * Everything lives in UV space (0..1 across the container). Velocities are UV
 * per second, so the same constants behave the same at every container size.
 * The splat itself is measured in CSS pixels: a brush of `size` px has exactly
 * half strength at `size` px in every direction, including non-square hosts.
 *
 * The grid is deliberately small (<= 320 x 200 = 64,000 cells): the visible
 * canvas is CSS resolution, the simulation is 0.25 of it, and CSS `blur` hides
 * the grid. That trade is the reason this runs without WebGL.
 */

/** simulation side / CSS side, per quality tier */
export const QUALITY_SCALE = Object.freeze({ low: 0.15, medium: 0.25, high: 0.4 });

/** hard ceiling on the grid: 64k cells is the performance budget */
export const GRID_MAX = Object.freeze({ width: 320, height: 200 });

const MIN_SIDE = 4;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Grid size for a host. Matches the spec table:
 *   1440 x 900 @ medium -> 320 x 200 (the cap wins)
 *   1045 x  600 @ medium -> 261 x 150
 */
export function gridFor(cssWidth, cssHeight, quality = 'medium') {
  const scale = typeof quality === 'number'
    ? quality
    : (QUALITY_SCALE[quality] ?? QUALITY_SCALE.medium);
  const width = Math.max(
    MIN_SIDE,
    Math.min(GRID_MAX.width, Math.floor(Math.max(1, cssWidth) * scale)),
  );
  const height = Math.max(
    MIN_SIDE,
    Math.min(GRID_MAX.height, Math.floor(Math.max(1, cssHeight) * scale)),
  );
  return { width, height, scale };
}

/** Allocate one field. `vx0/vy0/d0` are the previous-frame buffers, `p/p0` the
 *  Jacobi ping-pong pair, `div` the divergence scratch. */
export function createField(width, height) {
  const cells = Math.max(1, (width | 0) * (height | 0));
  return {
    width: width | 0,
    height: height | 0,
    cells,
    vx: new Float32Array(cells),
    vy: new Float32Array(cells),
    d: new Float32Array(cells),
    vx0: new Float32Array(cells),
    vy0: new Float32Array(cells),
    d0: new Float32Array(cells),
    p: new Float32Array(cells),
    p0: new Float32Array(cells),
    div: new Float32Array(cells),
  };
}

export function clearField(field) {
  field.vx.fill(0);
  field.vy.fill(0);
  field.d.fill(0);
  field.vx0.fill(0);
  field.vy0.fill(0);
  field.d0.fill(0);
  field.p.fill(0);
  field.p0.fill(0);
  field.div.fill(0);
}

/**
 * Bilinear lookup in grid coordinates. Out-of-range points clamp to the edge
 * (Neumann), which is what keeps the field from leaking at the container rim.
 */
export function sampleGrid(arr, width, height, gx, gy) {
  const x = clamp(gx, 0, width - 1);
  const y = clamp(gy, 0, height - 1);
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 < width - 1 ? x0 + 1 : x0;
  const y1 = y0 < height - 1 ? y0 + 1 : y0;
  const tx = x - x0;
  const ty = y - y0;
  const i00 = y0 * width + x0;
  const i10 = y0 * width + x1;
  const i01 = y1 * width + x0;
  const i11 = y1 * width + x1;
  const a = arr[i00] + (arr[i10] - arr[i00]) * tx;
  const b = arr[i01] + (arr[i11] - arr[i01]) * tx;
  return a + (b - a) * ty;
}

/** UV-space lookup, for tests and diagnostic reads. */
export function sampleField(field, arr, u, v) {
  return sampleGrid(
    arr,
    field.width,
    field.height,
    u * field.width - 0.5,
    v * field.height - 0.5,
  );
}

/**
 * Add one pointer impulse to the field.
 *
 *   du, dv        pointer displacement in UV (already summed over the frame)
 *   dye           dye amount for this frame (2 * dt * intensity * strength)
 *   sizePx        brush radius at half strength, CSS px
 *   cssWidth/H    host size, so the brush stays round in screen space
 *   quality       current tier coefficient (the spec couples impulse to it, so
 *                 a low grid does not fling the ink across the container)
 *
 * Returns the number of cells touched (diagnostic; no other side effects).
 */
export function splat(field, {
  x,
  y,
  dx = 0,
  dy = 0,
  sizePx = 56,
  cssWidth = field.width * 4,
  cssHeight = field.height * 4,
  force = 1,
  dye = 0,
  quality = QUALITY_SCALE.medium,
}) {
  const { width, height } = field;
  const radiusX = Math.max(0.5, (Math.max(1, sizePx) / Math.max(1, cssWidth)) * width);
  const radiusY = Math.max(0.5, (Math.max(1, sizePx) / Math.max(1, cssHeight)) * height);
  const cx = x * width - 0.5;
  const cy = y * height - 0.5;
  // `size` is the half-strength radius, not the edge. The Gaussian has to be
  // sampled out to 2.5x that radius: truncating at 1x cut it exactly at weight
  // 0.5 and left a hard, square brush edge (a 176px box on 1440x900). At 2.5x
  // the weight is 2^-6.25 = 0.013; the CSS blur finishes the edge. (3x was
  // cleaner but paid 9x the cells for a skirt nobody can see.)
  const supportX = radiusX * 2.5;
  const supportY = radiusY * 2.5;
  const x0 = Math.max(0, Math.floor(cx - supportX));
  const x1 = Math.min(width - 1, Math.ceil(cx + supportX));
  const y0 = Math.max(0, Math.floor(cy - supportY));
  const y1 = Math.min(height - 1, Math.ceil(cy + supportY));
  const impulse = 40 * quality * force;
  let touched = 0;

  for (let gy = y0; gy <= y1; gy++) {
    const dv = (gy - cy) / radiusY;
    const dv2 = dv * dv;
    for (let gx = x0; gx <= x1; gx++) {
      const du = (gx - cx) / radiusX;
      const d2 = du * du + dv2;
      if (d2 > 6.25) continue;
      // Feather the last half of the support so the finite sampling box has no
      // edge at all: weight is untouched out to 2x size, then ramps to zero at
      // 2.5x. Without this a 2.5x box still reads as a faint square.
      const edge = d2 <= 4 ? 1 : 1 - (d2 - 4) / 2.25;
      if (edge <= 0) continue;
      const w = Math.pow(2, -d2) * edge;
      const i = gy * width + gx;
      field.vx[i] += dx * impulse * w;
      field.vy[i] += dy * impulse * w;
      field.d[i] += dye * w;
      touched++;
    }
  }
  return touched;
}

/**
 * Semi-Lagrangian advection, velocity first and dye second.
 *
 * Velocity is sampled from the *previous* velocity (self-advection); dye is
 * then carried by the *new* velocity. Doing both in one pass would drag the
 * dye along last frame's direction — the classic "torn film" look.
 */
export function advect(field, dt) {
  const {
    width, height, vx, vy, d, vx0, vy0, d0,
  } = field;
  vx0.set(vx);
  vy0.set(vy);
  d0.set(d);
  const invW = 1 / width;
  const invH = 1 / height;
  const maxX = width - 1;
  const maxY = height - 1;

  // One bilinear footprint serves both velocity components, and the dye pass
  // reuses the same shape. This is the hot loop: keep it allocation-free and
  // avoid a function call per cell.
  for (let gy = 0; gy < height; gy++) {
    const v = (gy + 0.5) * invH;
    for (let gx = 0; gx < width; gx++) {
      const i = gy * width + gx;
      const u = (gx + 0.5) * invW;
      let px = (u - dt * vx0[i]) * width - 0.5;
      let py = (v - dt * vy0[i]) * height - 0.5;
      if (px < 0) px = 0; else if (px > maxX) px = maxX;
      if (py < 0) py = 0; else if (py > maxY) py = maxY;
      const x0 = px | 0;
      const y0 = py | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const tx = px - x0;
      const ty = py - y0;
      const i00 = y0 * width + x0;
      const i10 = y0 * width + x1;
      const i01 = y1 * width + x0;
      const i11 = y1 * width + x1;
      const ax = vx0[i00] + (vx0[i10] - vx0[i00]) * tx;
      const bx = vx0[i01] + (vx0[i11] - vx0[i01]) * tx;
      vx[i] = ax + (bx - ax) * ty;
      const ay = vy0[i00] + (vy0[i10] - vy0[i00]) * tx;
      const by = vy0[i01] + (vy0[i11] - vy0[i01]) * tx;
      vy[i] = ay + (by - ay) * ty;
    }
  }

  for (let gy = 0; gy < height; gy++) {
    const v = (gy + 0.5) * invH;
    for (let gx = 0; gx < width; gx++) {
      const i = gy * width + gx;
      const u = (gx + 0.5) * invW;
      let px = (u - dt * vx[i]) * width - 0.5;
      let py = (v - dt * vy[i]) * height - 0.5;
      if (px < 0) px = 0; else if (px > maxX) px = maxX;
      if (py < 0) py = 0; else if (py > maxY) py = maxY;
      const x0 = px | 0;
      const y0 = py | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const tx = px - x0;
      const ty = py - y0;
      const i00 = y0 * width + x0;
      const i10 = y0 * width + x1;
      const i01 = y1 * width + x0;
      const i11 = y1 * width + x1;
      const a = d0[i00] + (d0[i10] - d0[i00]) * tx;
      const b = d0[i01] + (d0[i11] - d0[i01]) * tx;
      d[i] = a + (b - a) * ty;
    }
  }
}

/**
 * Divergence of the velocity field, written to `field.div`. The 0.6 is the
 * spec's normalisation for this grid; it only scales the pressure solve.
 * Returns the largest absolute divergence (diagnostic / tests).
 */
export function divergence(field) {
  const {
    width, height, vx, vy, div,
  } = field;
  let max = 0;
  for (let gy = 0; gy < height; gy++) {
    const row = gy * width;
    const up = gy > 0 ? row - width : row;
    const down = gy < height - 1 ? row + width : row;
    for (let gx = 0; gx < width; gx++) {
      const i = row + gx;
      const left = gx > 0 ? i - 1 : i;
      const right = gx < width - 1 ? i + 1 : i;
      const value = 0.6 * ((vx[right] - vx[left]) + (vy[down] - vy[up]));
      div[i] = value;
      const abs = value < 0 ? -value : value;
      if (abs > max) max = abs;
    }
  }
  return max;
}

/**
 * Pressure projection: solve a Poisson equation with `iterations` Jacobi
 * sweeps (4 by default; below 3 the ink degrades into a blurred worm), then
 * subtract the pressure gradient. This is the pass that makes the shape curl
 * instead of smearing.
 *
 * Returns the largest divergence measured before the solve.
 */
export function project(field, iterations = 4) {
  const { width, height, vx, vy, div } = field;
  const before = divergence(field);
  const passes = Math.max(1, iterations | 0);

  field.p.fill(0);
  field.p0.fill(0);
  let src = field.p;
  let dst = field.p0;

  for (let pass = 0; pass < passes; pass++) {
    for (let gy = 0; gy < height; gy++) {
      const row = gy * width;
      const up = gy > 0 ? row - width : row;
      const down = gy < height - 1 ? row + width : row;
      for (let gx = 0; gx < width; gx++) {
        const i = row + gx;
        const left = gx > 0 ? i - 1 : i;
        const right = gx < width - 1 ? i + 1 : i;
        dst[i] = ((src[left] + src[right] + src[up + gx] + src[down + gx]) - div[i]) * 0.25;
      }
    }
    const swap = src; src = dst; dst = swap;
  }

  field.p = src;
  field.p0 = dst;

  for (let gy = 0; gy < height; gy++) {
    const row = gy * width;
    const up = gy > 0 ? row - width : row;
    const down = gy < height - 1 ? row + width : row;
    for (let gx = 0; gx < width; gx++) {
      const i = row + gx;
      const left = gx > 0 ? i - 1 : i;
      const right = gx < width - 1 ? i + 1 : i;
      vx[i] -= src[right] - src[left];
      vy[i] -= src[down + gx] - src[up + gx];
    }
  }

  return before;
}

/**
 * Two independent exponential decays. `trail` is the dye's visible lifetime,
 * `drift` the velocity's; both are divided by 3 so the constants mean "gone in
 * about this many seconds", which is how the reference labels them. Merging
 * them into one number kills either the trail or the drift.
 */
export function dissipate(field, dt, trail = 0.6, drift = 0.6) {
  const dyeK = Math.exp(-dt / (Math.max(1e-4, trail) / 3));
  const velK = Math.exp(-dt / (Math.max(1e-4, drift) / 3));
  const { vx, vy, d, cells } = field;
  for (let i = 0; i < cells; i++) {
    vx[i] *= velK;
    vy[i] *= velK;
    d[i] *= dyeK;
  }
}

/** One simulation step, in the order the spec fixes (splat happens before). */
export function step(field, dt, {
  trail = 0.6, drift = 0.6, iterations = 4,
} = {}) {
  advect(field, dt);
  project(field, iterations);
  dissipate(field, dt, trail, drift);
}

/** Largest dye density (diagnostic: has the field finished dying?). */
export function maxDye(field) {
  const { d, cells } = field;
  let max = 0;
  for (let i = 0; i < cells; i++) {
    const v = d[i];
    if (v > max) max = v;
  }
  return max;
}

/** Total dye (tests: advection must not create mass). */
export function totalDye(field) {
  const { d, cells } = field;
  let sum = 0;
  for (let i = 0; i < cells; i++) sum += d[i];
  return sum;
}

/** Largest speed (diagnostic). */
export function maxSpeed(field) {
  const { vx, vy, cells } = field;
  let max = 0;
  for (let i = 0; i < cells; i++) {
    const v = Math.hypot(vx[i], vy[i]);
    if (v > max) max = v;
  }
  return max;
}
