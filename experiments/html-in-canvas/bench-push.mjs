/**
 * Push the speedup ceiling further.
 *
 * Known wins:
 * - --disable-frame-rate-limit: cap min 5.1ms, p50 16.4ms
 * - Removing --run-all-compositor-stages-before-draw saves ~10ms/frame
 *
 * Now testing:
 * 1. Can we sustain the 5ms min or is p50 the true rate?
 * 2. Does step size interact with --disable-frame-rate-limit?
 * 3. Does CDP pipeline overlap save wall time?
 * 4. Can multiple tabs multiply throughput?
 */
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const CANARY = '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary';
const DIR = resolve(fileURLToPath(import.meta.url), '..');
const TEST_PAGE = join(DIR, 'test-animation.html');
const VCLOCK_PATH = resolve(DIR, '../../src/virtual-clock.iife.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const virtualClockSrc = readFileSync(VCLOCK_PATH, 'utf8');

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    min: s[0], max: s[s.length - 1],
  };
}
const fmt = (n) => n.toFixed(1).padStart(6);

// Optimal flag set discovered: minimal + disable-frame-rate-limit
const OPTIMAL_FLAGS = [
  '--headless=new',
  '--enable-features=CanvasDrawElement',
  '--disable-gpu',
  '--disable-frame-rate-limit',
  '--no-first-run', '--no-default-browser-check',
];

async function launch(port, userDataDir) {
  const proc = Bun.spawn([
    CANARY, ...OPTIMAL_FLAGS,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdout: 'pipe', stderr: 'pipe' });

  for (let i = 0; i < 30; i++) {
    await sleep(200);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) break;
    } catch {}
  }
  return proc;
}

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 1;
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++;
    const handler = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === id) {
        ws.removeEventListener('message', handler);
        if (data.error) reject(new Error(`${method}: ${JSON.stringify(data.error)}`));
        else resolve(data.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, cdp };
}

async function primePage({ cdp }) {
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 800, height: 600, deviceScaleFactor: 1, mobile: false,
  });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: virtualClockSrc });
  await cdp('Page.navigate', { url: `file://${TEST_PAGE}` });
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const r = await cdp('Runtime.evaluate', { expression: 'window.__HTML_IN_CANVAS_READY === true' });
    if (r.result.value === true) break;
  }
  await sleep(200);
  await cdp('Runtime.evaluate', {
    expression: '(() => { let r = 16; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()',
  });
  await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true });
}

// Test 1: does step size interact with disable-frame-rate-limit?
async function stepSweep() {
  console.log('\n[1] Step size × disable-frame-rate-limit');
  const userDataDir = mkdtempSync(join(tmpdir(), 'canary-push-'));
  const port = 9500 + Math.floor(Math.random() * 100);
  const proc = await launch(port, userDataDir);
  try {
    const { ws, cdp } = await connect(port);
    await primePage({ cdp });

    const captureParams = { format: 'jpeg', quality: 80, optimizeForSpeed: true };
    const steps = [16, 33, 50, 100, 200, 500, 1000, 2000];

    for (const step of steps) {
      // Warmup
      for (let i = 0; i < 10; i++) {
        await cdp('Runtime.evaluate', { expression: `(() => { let r = ${step}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()` });
        await cdp('Page.captureScreenshot', captureParams);
      }
      const caps = [];
      const tots = [];
      const wallStart = performance.now();
      const FRAMES = 80;
      for (let i = 0; i < FRAMES; i++) {
        const t0 = performance.now();
        await cdp('Runtime.evaluate', { expression: `(() => { let r = ${step}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()` });
        const t1 = performance.now();
        await cdp('Page.captureScreenshot', captureParams);
        const t2 = performance.now();
        caps.push(t2 - t1);
        tots.push(t2 - t0);
      }
      const wallTotal = performance.now() - wallStart;
      const speedup = (FRAMES * step) / wallTotal;
      const c = stats(caps);
      const t = stats(tots);
      console.log(
        `  step=${String(step).padStart(4)}ms  cap p50 ${fmt(c.p50)} p95 ${fmt(c.p95)} min ${fmt(c.min)} | tot ${fmt(t.mean)}ms | ${speedup.toFixed(2).padStart(6)}×`
      );
    }
    ws.close();
  } finally {
    proc.kill();
    await sleep(200);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

// Test 2: CDP pipeline overlap — send next advance while capture is in flight
async function pipelineOverlap() {
  console.log('\n[2] Pipeline overlap (advance(N+1) while capture(N) in flight)');
  const userDataDir = mkdtempSync(join(tmpdir(), 'canary-push-'));
  const port = 9500 + Math.floor(Math.random() * 100);
  const proc = await launch(port, userDataDir);
  try {
    const { ws, cdp } = await connect(port);
    await primePage({ cdp });

    const captureParams = { format: 'jpeg', quality: 80, optimizeForSpeed: true };
    const STEP = 500;
    const FRAMES = 80;

    // Baseline: serial
    for (let i = 0; i < 10; i++) {
      await cdp('Runtime.evaluate', { expression: `(() => { let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()` });
      await cdp('Page.captureScreenshot', captureParams);
    }
    let wallStart = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      await cdp('Runtime.evaluate', { expression: `(() => { let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()` });
      await cdp('Page.captureScreenshot', captureParams);
    }
    const serialTotal = performance.now() - wallStart;
    console.log(`  SERIAL:   ${FRAMES} frames in ${serialTotal.toFixed(0)}ms (${((FRAMES*STEP)/serialTotal).toFixed(2)}×)`);

    // Overlapped: start advance(N+1) immediately after sending capture(N), not awaiting
    wallStart = performance.now();
    // Pre-advance for first frame
    await cdp('Runtime.evaluate', { expression: `(() => { let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()` });

    let pendingCapture = cdp('Page.captureScreenshot', captureParams);
    for (let i = 1; i < FRAMES; i++) {
      // Fire advance while previous capture is in flight
      const advancePromise = cdp('Runtime.evaluate', { expression: `(() => { let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()` });
      await pendingCapture;
      await advancePromise;
      pendingCapture = cdp('Page.captureScreenshot', captureParams);
    }
    await pendingCapture;
    const overlapTotal = performance.now() - wallStart;
    console.log(`  OVERLAP:  ${FRAMES} frames in ${overlapTotal.toFixed(0)}ms (${((FRAMES*STEP)/overlapTotal).toFixed(2)}×)`);
    console.log(`  delta:    ${((serialTotal - overlapTotal) / serialTotal * 100).toFixed(1)}% faster`);

    ws.close();
  } finally {
    proc.kill();
    await sleep(200);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

// Test 3: multi-page parallel workers
async function parallelWorkers() {
  console.log('\n[3] Multiple pages in parallel (shared browser)');
  const userDataDir = mkdtempSync(join(tmpdir(), 'canary-push-'));
  const port = 9500 + Math.floor(Math.random() * 100);
  const proc = await launch(port, userDataDir);
  try {
    const STEP = 500;
    const FRAMES_PER_WORKER = 40;

    const browserCDP = async () => {
      const verRes = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const bws = new WebSocket(verRes.webSocketDebuggerUrl);
      await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
      let bid = 1;
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = bid++;
        const h = (e) => {
          const d = JSON.parse(e.data);
          if (d.id === id) {
            bws.removeEventListener('message', h);
            if (d.error) reject(new Error(`${method}: ${JSON.stringify(d.error)}`));
            else resolve(d.result);
          }
        };
        bws.addEventListener('message', h);
        bws.send(JSON.stringify({ id, method, params }));
      });
      return { bws, send };
    };

    const createTab = async (targetId) => {
      // Each tab gets its own ws
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const tab = list.find(t => t.id === targetId);
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      let id = 1;
      const cdp = (method, params = {}) => new Promise((resolve, reject) => {
        const mid = id++;
        const h = (e) => {
          const d = JSON.parse(e.data);
          if (d.id === mid) {
            ws.removeEventListener('message', h);
            if (d.error) reject(new Error(`${method}: ${JSON.stringify(d.error)}`));
            else resolve(d.result);
          }
        };
        ws.addEventListener('message', h);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
      await primePage({ cdp });
      return { ws, cdp };
    };

    const browser = await browserCDP();

    // Open N tabs
    for (const N of [1, 2, 4]) {
      const tabs = [];
      // Tab 1 is the default one
      const initialList = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      tabs.push(await createTab(initialList[0].id));
      for (let i = 1; i < N; i++) {
        const r = await browser.send('Target.createTarget', { url: 'about:blank' });
        tabs.push(await createTab(r.targetId));
      }

      const captureParams = { format: 'jpeg', quality: 80, optimizeForSpeed: true };
      // Warmup
      await Promise.all(tabs.map(async t => {
        for (let i = 0; i < 5; i++) {
          await t.cdp('Runtime.evaluate', { expression: `(() => { let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()` });
          await t.cdp('Page.captureScreenshot', captureParams);
        }
      }));

      const wallStart = performance.now();
      await Promise.all(tabs.map(async t => {
        for (let i = 0; i < FRAMES_PER_WORKER; i++) {
          await t.cdp('Runtime.evaluate', { expression: `(() => { let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()` });
          await t.cdp('Page.captureScreenshot', captureParams);
        }
      }));
      const wall = performance.now() - wallStart;
      const total = tabs.length * FRAMES_PER_WORKER * STEP;
      console.log(`  ${N} tabs: ${tabs.length * FRAMES_PER_WORKER} frames in ${wall.toFixed(0)}ms → ${(total/wall).toFixed(2)}× (${((total/wall)/N).toFixed(2)}× per tab)`);

      // Cleanup extra tabs
      for (let i = 1; i < tabs.length; i++) {
        tabs[i].ws.close();
      }
      tabs[0].ws.close();
      // Close tabs via Target.closeTarget
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      for (const t of list) {
        if (t.type === 'page' && list.indexOf(t) > 0) {
          await browser.send('Target.closeTarget', { targetId: t.id });
        }
      }
    }
    browser.bws.close();
  } finally {
    proc.kill();
    await sleep(300);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log('=== Push speedup ceiling further ===');
  console.log('Optimal flags: --disable-frame-rate-limit (no run-all-compositor-stages)\n');
  await stepSweep();
  await pipelineOverlap();
  await parallelWorkers();
}

main().catch(e => { console.error(e); process.exit(1); });
