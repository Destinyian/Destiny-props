#!/usr/bin/env node
/**
 * cdp_realclick.js — drive a page with REAL input events and report the engine state.
 *
 * Why: dispatching `new PointerEvent(...)` from JS tests your listeners, but not the
 * gesture as the browser delivers it (trusted events, coalesced moves, real timing).
 * This goes through the DevTools input pipeline instead.
 *
 * Usage:
 *   node cdp_realclick.js <url> [clicks] [driftPx] [fx] [fy] [settleMs]
 *     clicks   how many clicks to issue (default 2)
 *     driftPx  how far the pointer drifts *while the button is down* (default 0,
 *              e.g. 20 emulates a human "click while moving")
 *     fx, fy   click position as viewport fractions (default 0.5 0.5)
 *     settleMs wait after each click before reading state (default 2500)
 *
 * Prints, per click: engine stats (state / released / settleMoves / …) and the state
 * history recorded by the demo page (window.__states).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [url, clicksArg, driftArg, fxArg, fyArg, settleArg] = process.argv.slice(2);
const CLICKS = Number(clicksArg || 2);
const DRIFT = Number(driftArg || 0);
const FX = Number(fxArg || 0.5);
const FY = Number(fyArg || 0.5);
const SETTLE = Number(settleArg || 2500);
const PORT = 9344;

function findBrowser() {
  const cands = [
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
    path.join(process.env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
    path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
    "/usr/bin/google-chrome", "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return "msedge";
}

function killTree(child) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch (e) { /* gone */ }
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "realclick-"));
  const child = spawn(findBrowser(), [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--mute-audio", "--disable-extensions",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      } catch (e) { /* not up */ }
      if (!target) await sleep(400);
    }
    if (!target) throw new Error("devtools never came up");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch (e) { /* ignore */ }
    });
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("ws failed")), { once: true });
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url });
    for (let i = 0; i < 40; i++) {
      const r = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (r.result?.result?.value === "complete") break;
      await sleep(300);
    }
    await sleep(2500);

    const view = await send("Runtime.evaluate", {
      expression: "JSON.stringify({w: innerWidth, h: innerHeight})", returnByValue: true,
    });
    const { w, h } = JSON.parse(view.result.result.value);
    const x = Math.round(w * FX);
    const y = Math.round(h * FY);
    console.log(`viewport ${w}x${h}  clicking at (${x},${y})  drift=${DRIFT}px  clicks=${CLICKS}`);

    const stats = async (label) => {
      const r = await send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => { const s = window.__gg?.getStats?.() || {}; return JSON.stringify({
          state: s.state, released: s.released, settleMoves: s.settleMoves,
          running: s.running, states: window.__states || [] }); })()`,
      });
      console.log(`  ${label}: ${r.result?.result?.value}`);
    };

    await stats("before");

    for (let c = 1; c <= CLICKS; c++) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
      await sleep(60);
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
      });
      if (DRIFT) {                       // human clicks drift while the button is down
        for (let d = 1; d <= 3; d++) {
          await sleep(35);
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved", x: x + Math.round((DRIFT / 3) * d), y: y + Math.round((DRIFT / 6) * d),
            button: "left", buttons: 1,
          });
        }
      }
      await sleep(40);
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: x + DRIFT, y: y + Math.round(DRIFT / 2),
        button: "left", buttons: 0, clickCount: 1,
      });
      await sleep(SETTLE);
      await stats(`after click ${c}`);
    }
    ws.close();
  } finally {
    killTree(child);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* locked */ }
  }
}

main().catch((e) => { console.error("ERROR " + e.message); process.exit(1); });
