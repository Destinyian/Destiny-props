#!/usr/bin/env node
/**
 * verify_behavior.js — drive the demo with real DevTools input, capture frames,
 * decode the PNGs and print the numbers behind the six acceptance goals.
 *
 * Zero dependencies: Node 22+ (global WebSocket, zlib) and a locally installed
 * Chrome/Edge. The demo server must already be running:
 *
 *   node serve.mjs        # terminal 1, http://127.0.0.1:4181
 *   node tools/verify_behavior.js   # terminal 2
 *
 * Everything it measures is exported as JSON at the end, and the frames land in
 * `review/` for a human to look at. `review/` is deliberately not committed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';

const BASE = process.argv[2] || 'http://127.0.0.1:4181';
// The demo now starts on the dark page with white smoke. The ink half of the
// verification must ask for the light page (which also swaps the hue to ink).
const QUERY = process.env.HALO_QUERY || 'hud=0&autoplay=0&degrade=0&quality=medium&theme=light';
const SWIPE_STEPS = Number(process.env.HALO_STEPS || 40);
const SWIPE_GAP = Number(process.env.HALO_GAP || 6);
const OUT = path.resolve('review');
const VIEW = { width: 1440, height: 900 };
const PORT = 9355;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- PNG decode
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG ${depth}/${interlace}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dst = out.subarray(y * stride, y * stride + stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? dst[x - channels] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= channels ? up[x - channels] : 0;
      const v = src[x];
      dst[x] = filter === 0 ? v
        : filter === 1 ? (v + a) & 255
          : filter === 2 ? (v + b) & 255
            : filter === 3 ? (v + ((a + b) >> 1)) & 255
              : filter === 4 ? (v + paeth(a, b, c)) & 255
                : (() => { throw new Error(`bad filter ${filter}`); })();
    }
  }
  return { width, height, channels, data: out };
}

const rgbAt = (img, x, y) => {
  const i = (y * img.width + x) * img.channels;
  if (img.channels === 1) return [img.data[i], img.data[i], img.data[i]];
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** average luminance of a small patch: the demo has a faint 48px grid, so a
 *  single pixel can sit on a line and read 2 levels too dark */
function patchLum(img, fx, fy, radius = 4) {
  const cx = Math.round(fx * img.width);
  const cy = Math.round(fy * img.height);
  let sum = 0;
  let n = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      sum += luminance(rgbAt(img, x, y));
      n++;
    }
  }
  return sum / Math.max(1, n);
}

// ---------------------------------------------------------------- browser
function findBrowser() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('no Chrome/Edge found');
  return found;
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else child.kill('SIGKILL');
  } catch { /* gone */ }
}

async function connect() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-verify-'));
  const child = spawn(findBrowser(), [
    '--headless=new',
    // default: let Chrome use the GPU (the target is a mid-range laptop).
    // HALO_SOFTWARE=1 forces software raster, the worst-case comparison.
    ...(process.env.HALO_SOFTWARE ? ['--disable-gpu'] : []),
    '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', '--disable-extensions',
    '--disable-crash-reporter', '--disable-breakpad',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    `--window-size=${VIEW.width},${VIEW.height}`, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* not up */ }
    if (!target) await sleep(250);
  }
  if (!target) {
    killTree(child);
    throw new Error('devtools never came up');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const logs = [];
  let seq = 0;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push(`EXCEPTION: ${d.exception?.description || d.text}`);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false,
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error(`evaluate failed: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    }
    return r.result?.result?.value;
  };
  const navigate = async (url) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 50; i++) {
      if (await evaluate('document.readyState') === 'complete') break;
      await sleep(100);
    }
    await sleep(1200);
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return decodePng(fs.readFileSync(file));
  };
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', {
    type, x, y, button: 'none', buttons: 0, clickCount: 0, ...extra,
  });
  const close = async () => {
    ws.close();
    killTree(child);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  };
  return { send, evaluate, navigate, shot, mouse, close, logs };
}

// ---------------------------------------------------------------- scenario
const START = { x: 0.16, y: 0.78 };
const END = { x: 0.84, y: 0.78 };
const MID = { x: 0.5, y: 0.78 };
const BG = { x: 0.94, y: 0.78 };

async function swipe(cdp, steps = SWIPE_STEPS, gap = SWIPE_GAP) {
  const x0 = VIEW.width * START.x;
  const y0 = VIEW.height * START.y;
  const x1 = VIEW.width * END.x;
  const y1 = VIEW.height * END.y;
  await cdp.mouse('mouseMoved', x0, y0);
  await sleep(30);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // one full S-wave inside the straight swipe: this is the input a person
    // makes when they "swipe across", and it is what makes curl visible
    const wave = VIEW.height * 0.09 * Math.sin(t * Math.PI * 2);
    await cdp.mouse('mouseMoved', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + wave);
    await sleep(gap);
  }
}

function shapeDiff(clean, after) {
  const w = after.width;
  const h = after.height;
  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;
  let count = 0;
  let samples = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      samples++;
      const d = Math.abs(luminance(rgbAt(clean, x, y)) - luminance(rgbAt(after, x, y)));
      if (d > 3) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    coverage: Number((count / samples).toFixed(3)),
    bboxWidth: Number(((maxX - minX) / w).toFixed(3)),
    bboxHeight: Number(((maxY - minY) / h).toFixed(3)),
    minX: Number((minX / w).toFixed(3)),
    maxX: Number((maxX / w).toFixed(3)),
    minY: Number((minY / h).toFixed(3)),
    maxY: Number((maxY / h).toFixed(3)),
  };
}

const statsOf = (cdp) => cdp.evaluate('window.__halo?.getStats?.() || null');

async function main() {
  const cdp = await connect();
  const report = {};
  try {
    // ------ G1/G2: light page, ink, trail after the pointer stops
    await cdp.navigate(`${BASE}/index.html?${QUERY}`);
    const before = await statsOf(cdp);
    const clean = await cdp.shot('ink-clean.png');
    const cleanMid = patchLum(clean, MID.x, MID.y);
    const cleanBg = patchLum(clean, BG.x, BG.y);
    const cleanEnd = patchLum(clean, END.x, END.y);
    await swipe(cdp);
    await sleep(25);
    const t0 = await cdp.shot('ink-swipe-t0.png');
    const s0 = await statsOf(cdp);
    await sleep(380);
    const t400 = await cdp.shot('ink-swipe-t400.png');
    const s400 = await statsOf(cdp);
    await sleep(820);
    const t1200 = await cdp.shot('ink-swipe-t1200.png');
    const s1200 = await statsOf(cdp);

    report.ink = {
      before,
      clean: { mid: cleanMid, background: cleanBg, end: cleanEnd },
      t0: {
        stats: s0,
        mid: patchLum(t0, MID.x, MID.y),
        background: patchLum(t0, BG.x, BG.y),
        head: patchLum(t0, END.x, END.y),
      },
      t400: { stats: s400, mid: patchLum(t400, MID.x, MID.y), head: patchLum(t400, END.x, END.y) },
      t1200: { stats: s1200, mid: patchLum(t1200, MID.x, MID.y), head: patchLum(t1200, END.x, END.y) },
      delta0: patchLum(t0, MID.x, MID.y) - cleanMid,
      delta400: patchLum(t400, MID.x, MID.y) - cleanMid,
      delta1200: patchLum(t1200, MID.x, MID.y) - cleanMid,
      headDelta400: patchLum(t400, END.x, END.y) - cleanEnd,
      shape: shapeDiff(clean, t0),
    };

    // ------ G4: dark page, same input, smoke must brighten instead of darken
    await cdp.evaluate('window.__demo.setTheme("dark")');
    const modeAfterTwoFrames = await cdp.evaluate(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.__halo.getMode())));
    })`);
    await sleep(200);
    const afterTheme = await statsOf(cdp);
    const darkClean = await cdp.shot('smoke-clean.png');
    const darkCleanMid = patchLum(darkClean, MID.x, MID.y);
    await swipe(cdp);
    await sleep(25);
    const dark0 = await cdp.shot('smoke-swipe-t0.png');
    const darkStats = await statsOf(cdp);
    await sleep(380);
    const dark400 = await cdp.shot('smoke-swipe-t400.png');
    report.smoke = {
      modeAfterThemeSwitch: afterTheme.mode,
      modeAfterTwoFrames,
      stats: darkStats,
      cleanMid: darkCleanMid,
      t0: {
        mid: patchLum(dark0, MID.x, MID.y),
        background: patchLum(dark0, BG.x, BG.y),
        head: patchLum(dark0, END.x, END.y),
      },
      t400: { mid: patchLum(dark400, MID.x, MID.y), head: patchLum(dark400, END.x, END.y) },
      delta0: patchLum(dark0, MID.x, MID.y) - darkCleanMid,
      delta400: patchLum(dark400, MID.x, MID.y) - darkCleanMid,
      shape: shapeDiff(darkClean, dark0),
    };

    // ------ G6: idle must stop the loop (autoplay off)
    await cdp.evaluate('window.__demo.setTheme("light")');
    await sleep(3200);
    const idle1 = await statsOf(cdp);
    await sleep(1100);
    const idle2 = await statsOf(cdp);
    report.idle = {
      running: idle2.running,
      frameDelta: idle2.frames - idle1.frames,
      dyeMax: idle2.dyeMax,
    };

    // ------ G5: autoplay wanderer, then reduced motion
    const autoQuery = `${QUERY.includes('autoplay=')
      ? QUERY.replace(/autoplay=[^&]+/g, 'autoplay=0')
      : `${QUERY}&autoplay=0`}&idle=0.2`;
    await cdp.navigate(`${BASE}/index.html?${autoQuery}`);
    await sleep(800);
    const autoClean = await cdp.shot('autoplay-clean.png');
    // the CDP mouse is still parked inside the stage; leave first, or the
    // engine will correctly treat the page as hovered and never start. A
    // synthetic enter from the renderer can race the first leave, so leave
    // once more after enabling, and use a zero idle delay for this check.
    await cdp.evaluate('window.__demo.leave()');
    await cdp.evaluate('window.__halo.setOptions({ autoplay: true, idleDelay: 0 })');
    await sleep(120);
    await cdp.evaluate('window.__demo.leave()');
    await sleep(2400);
    const auto = await statsOf(cdp);
    const autoShot = await cdp.shot('autoplay.png');
    report.autoplay = {
      running: auto.running,
      active: auto.autoplayActive,
      strength: auto.autoStrength,
      dyeMax: auto.dyeMax,
      shape: shapeDiff(autoClean, autoShot),
    };

    // G5, the actual gate: the wanderer must wait idleDelay after the pointer
    // leaves, not start the moment it is gone.
    await cdp.navigate(`${BASE}/index.html?hud=0&autoplay=1&degrade=0&quality=medium&idle=1.2`);
    await sleep(700);
    await cdp.evaluate('window.__demo.enter(0.5, 0.5)');
    await sleep(250);
    const beforeLeave = await statsOf(cdp);
    await cdp.evaluate('window.__demo.leave()');
    await sleep(600);
    const idleEarly = await statsOf(cdp);
    await sleep(900);
    const idleLate = await statsOf(cdp);
    report.idleWanderer = {
      activeWhilePointerInside: beforeLeave.autoplayActive,
      activeAt600ms: idleEarly.autoplayActive,
      activeAt1500ms: idleLate.autoplayActive,
      runningAt1500ms: idleLate.running,
      strengthAt1500ms: idleLate.autoStrength,
    };

    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await cdp.navigate(`${BASE}/index.html?hud=0&autoplay=1&degrade=0&quality=medium`);
    await sleep(5200);
    const reduced = await statsOf(cdp);
    await sleep(1000);
    const reduced2 = await statsOf(cdp);
    report.reduced = {
      reduceMotion: reduced2.reduceMotion,
      running: reduced2.running,
      active: reduced2.autoplayActive,
      frameDelta: reduced2.frames - reduced.frames,
    };
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    // ------ G1 control: the cheap version has already forgotten at 400 ms
    await cdp.navigate(`${BASE}/cheap.html?theme=light`);
    const cheapClean = await cdp.shot('cheap-clean.png');
    const cheapCleanMid = patchLum(cheapClean, MID.x, MID.y);
    await swipe(cdp);
    await sleep(25);
    const cheap0 = await cdp.shot('cheap-t0.png');
    await sleep(400);
    const cheap400 = await cdp.shot('cheap-t400.png');
    report.cheap = {
      midDelta0: patchLum(cheap0, MID.x, MID.y) - cheapCleanMid,
      midDelta400: patchLum(cheap400, MID.x, MID.y) - cheapCleanMid,
      endDelta0: patchLum(cheap0, END.x, END.y) - patchLum(cheapClean, END.x, END.y),
      endDelta400: patchLum(cheap400, END.x, END.y) - patchLum(cheapClean, END.x, END.y),
      stats: await cdp.evaluate('window.__cheap?.stats?.() || null'),
    };

    // ------ G6 budget: a continuous stroke for ~2.5 s
    await cdp.navigate(`${BASE}/index.html?${QUERY}`);
    const perfStart = Date.now();
    for (let i = 0; i < 160; i++) {
      const t = i / 160;
      const x = VIEW.width * (0.18 + 0.64 * (0.5 + 0.5 * Math.sin(t * Math.PI * 4)));
      const y = VIEW.height * (0.5 + 0.28 * Math.sin(t * Math.PI * 6));
      await cdp.mouse('mouseMoved', x, y);
      await sleep(8);
    }
    const perf = await statsOf(cdp);
    report.performance = {
      p95FrameMs: perf.p95FrameMs,
      lastFrameMs: perf.lastFrameMs,
      frames: perf.frames,
      grid: perf.grid,
      degraded: perf.degraded,
      wallMs: Date.now() - perfStart,
    };

    // ------ resize must rebuild the grid and drop the old film (no smearing)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(350);
    const resized = await statsOf(cdp);
    await cdp.shot('resize-1280x720.png');
    report.resize = {
      grid: resized.grid,
      dyeMax: resized.dyeMax,
      running: resized.running,
      expect: '320x180 and dyeMax 0 (the field is rebuilt, not stretched)',
    };
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(250);

    // ------ G6 low-end path: 4 cores must drop to low quality + no CSS blur
    await cdp.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 4 });
    await cdp.navigate(`${BASE}/index.html?hud=0&autoplay=0&degrade=1`);
    const lowEnd = await statsOf(cdp);
    report.lowEnd = {
      hardwareConcurrency: await cdp.evaluate('navigator.hardwareConcurrency'),
      quality: lowEnd.quality,
      degraded: lowEnd.degraded,
      grid: lowEnd.grid,
      blur: await cdp.evaluate('getComputedStyle(document.getElementById("halo")).filter'),
    };
    await cdp.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 8 });

    report.logs = cdp.logs;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await cdp.close();
  }
}

main().catch((error) => {
  console.error('ERROR', error.stack || error.message);
  process.exit(1);
});
