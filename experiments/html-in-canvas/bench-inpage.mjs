/**
 * Hypothesis: for html-in-canvas workloads, we can skip
 * Page.captureScreenshot entirely and just read the canvas backing
 * store with canvas.toDataURL() inside the page. CDP captureScreenshot
 * on macOS is gated on a VSync-paced present step (~16ms p50), whereas
 * toDataURL should read directly from the GPU/CPU bitmap.
 *
 * Compare four capture paths at step=500ms:
 *   A) captureScreenshot (baseline, compositor path)
 *   B) Runtime.evaluate canvas.toDataURL (bitmap path)
 *   C) Runtime.evaluate canvas.convertToBlob + base64 (OffscreenCanvas path)
 *   D) In-page loop: advance + toDataURL × N frames → return array
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
  // Prime both capture paths
  await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true });
}

const advanceExpr = (step) =>
  `(() => { let r = ${step}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()`;

async function main() {
  console.log('=== In-page capture vs CDP captureScreenshot ===\n');
  const userDataDir = mkdtempSync(join(tmpdir(), 'canary-inpage-'));
  const port = 9600 + Math.floor(Math.random() * 100);
  const proc = await launch(port, userDataDir);
  try {
    const { ws, cdp } = await connect(port);
    await primePage({ cdp });

    const STEP = 500;
    const FRAMES = 60;

    // ---- A) captureScreenshot baseline ----
    for (let i = 0; i < 10; i++) {
      await cdp('Runtime.evaluate', { expression: advanceExpr(STEP) });
      await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true });
    }
    {
      const caps = [];
      const wallStart = performance.now();
      for (let i = 0; i < FRAMES; i++) {
        await cdp('Runtime.evaluate', { expression: advanceExpr(STEP) });
        const t1 = performance.now();
        await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true });
        caps.push(performance.now() - t1);
      }
      const wall = performance.now() - wallStart;
      const c = stats(caps);
      console.log(
        `  [A] captureScreenshot  cap p50 ${fmt(c.p50)} p95 ${fmt(c.p95)} min ${fmt(c.min)} | ${((FRAMES*STEP)/wall).toFixed(2).padStart(7)}×`
      );
    }

    // ---- B) Runtime.evaluate canvas.toDataURL, returnByValue ----
    for (let i = 0; i < 10; i++) {
      await cdp('Runtime.evaluate', { expression: advanceExpr(STEP) });
      await cdp('Runtime.evaluate', {
        expression: `document.getElementById('c').toDataURL('image/jpeg', 0.8)`,
        returnByValue: true,
      });
    }
    {
      const caps = [];
      const wallStart = performance.now();
      for (let i = 0; i < FRAMES; i++) {
        await cdp('Runtime.evaluate', { expression: advanceExpr(STEP) });
        const t1 = performance.now();
        await cdp('Runtime.evaluate', {
          expression: `document.getElementById('c').toDataURL('image/jpeg', 0.8)`,
          returnByValue: true,
        });
        caps.push(performance.now() - t1);
      }
      const wall = performance.now() - wallStart;
      const c = stats(caps);
      console.log(
        `  [B] toDataURL inline  cap p50 ${fmt(c.p50)} p95 ${fmt(c.p95)} min ${fmt(c.min)} | ${((FRAMES*STEP)/wall).toFixed(2).padStart(7)}×`
      );
    }

    // ---- C) In-page combined advance + toDataURL in one Runtime.evaluate ----
    for (let i = 0; i < 10; i++) {
      await cdp('Runtime.evaluate', {
        expression: `(() => {
          let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; }
          return document.getElementById('c').toDataURL('image/jpeg', 0.8);
        })()`,
        returnByValue: true,
      });
    }
    {
      const caps = [];
      const wallStart = performance.now();
      for (let i = 0; i < FRAMES; i++) {
        const t1 = performance.now();
        await cdp('Runtime.evaluate', {
          expression: `(() => {
            let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; }
            return document.getElementById('c').toDataURL('image/jpeg', 0.8);
          })()`,
          returnByValue: true,
        });
        caps.push(performance.now() - t1);
      }
      const wall = performance.now() - wallStart;
      const c = stats(caps);
      console.log(
        `  [C] combined eval     cap p50 ${fmt(c.p50)} p95 ${fmt(c.p95)} min ${fmt(c.min)} | ${((FRAMES*STEP)/wall).toFixed(2).padStart(7)}×`
      );
    }

    // ---- D) In-page batched loop: 1 CDP call renders many frames ----
    for (const BATCH of [5, 10, 20, 40]) {
      // Warmup a small batch
      await cdp('Runtime.evaluate', {
        expression: `(() => {
          const out = [];
          for (let f = 0; f < 3; f++) {
            let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; }
            out.push(document.getElementById('c').toDataURL('image/jpeg', 0.8).length);
          }
          return out;
        })()`,
        returnByValue: true,
      });

      const caps = [];
      const wallStart = performance.now();
      const batches = Math.ceil(FRAMES / BATCH);
      for (let b = 0; b < batches; b++) {
        const t1 = performance.now();
        const res = await cdp('Runtime.evaluate', {
          expression: `(() => {
            const out = [];
            for (let f = 0; f < ${BATCH}; f++) {
              let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; }
              out.push(document.getElementById('c').toDataURL('image/jpeg', 0.8));
            }
            return out;
          })()`,
          returnByValue: true,
        });
        caps.push((performance.now() - t1) / BATCH);
      }
      const wall = performance.now() - wallStart;
      const c = stats(caps);
      console.log(
        `  [D batch=${String(BATCH).padStart(2)}]         cap p50 ${fmt(c.p50)} p95 ${fmt(c.p95)} min ${fmt(c.min)} | ${((batches*BATCH*STEP)/wall).toFixed(2).padStart(7)}×`
      );
    }

    // ---- E) Skip JPEG encode — return only byte length (cost of paint only) ----
    for (let i = 0; i < 10; i++) {
      await cdp('Runtime.evaluate', {
        expression: `(() => {
          let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; }
          return 0; // no capture, just paint work
        })()`,
        returnByValue: true,
      });
    }
    {
      const caps = [];
      const wallStart = performance.now();
      for (let i = 0; i < FRAMES; i++) {
        const t1 = performance.now();
        await cdp('Runtime.evaluate', {
          expression: `(() => {
            let r = ${STEP}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; }
            return 0;
          })()`,
          returnByValue: true,
        });
        caps.push(performance.now() - t1);
      }
      const wall = performance.now() - wallStart;
      const c = stats(caps);
      console.log(
        `  [E] advance only      cap p50 ${fmt(c.p50)} p95 ${fmt(c.p95)} min ${fmt(c.min)} | ${((FRAMES*STEP)/wall).toFixed(2).padStart(7)}×`
      );
    }

    ws.close();
  } finally {
    proc.kill();
    await sleep(200);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(e => { console.error(e); process.exit(1); });
