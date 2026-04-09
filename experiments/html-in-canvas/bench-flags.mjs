/**
 * Benchmark: sweep launch flags to find the minimum capture wall time.
 * Goal: break the ~25ms per-capture floor on macOS.
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
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    min: sorted[0],
  };
}
const fmt = (n) => n.toFixed(1).padStart(6);

async function bench(label, extraFlags, step = 500, frames = 40) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'canary-flag-'));
  const port = 9400 + Math.floor(Math.random() * 100);
  const baseFlags = [
    '--headless=new',
    '--enable-features=CanvasDrawElement',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
  ];

  const proc = Bun.spawn([
    CANARY, ...baseFlags, ...extraFlags,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdout: 'pipe', stderr: 'pipe' });

  try {
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) break;
      } catch {}
    }
    const listRes = await fetch(`http://127.0.0.1:${port}/json`);
    const targets = await listRes.json();
    const pageTarget = targets.find(t => t.type === 'page');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
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

    // Prime
    await cdp('Runtime.evaluate', {
      expression: '(() => { let r = 16; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()',
    });
    await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true });

    // Warmup
    for (let i = 0; i < 10; i++) {
      await cdp('Runtime.evaluate', { expression: `(() => { let r = ${step}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()` });
      await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true });
    }

    const captureTimes = [];
    const totalTimes = [];
    const wallStart = performance.now();
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      await cdp('Runtime.evaluate', { expression: `(() => { let r = ${step}; while (r > 0) { const c = Math.min(r,16); window.__virtualTime.advance(c); r-=c; } })()` });
      const t1 = performance.now();
      await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true });
      const t2 = performance.now();
      captureTimes.push(t2 - t1);
      totalTimes.push(t2 - t0);
    }
    const wallTotal = performance.now() - wallStart;
    const speedup = (frames * step) / wallTotal;

    const c = stats(captureTimes);
    const t = stats(totalTimes);
    console.log(
      `  ${label.padEnd(50)} cap p50 ${fmt(c.p50)} p95 ${fmt(c.p95)} min ${fmt(c.min)} | tot ${fmt(t.mean)}ms | ${speedup.toFixed(2).padStart(6)}×`
    );
    ws.close();
    return { label, speedup, captureTime: c };
  } finally {
    proc.kill();
    await sleep(200);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log('\n=== Launch flag sweep: break the 25ms capture floor ===');
  console.log('All tests: 800×600, step=500ms, 40 frames + 10 warmup, JPEG q80 optimizeForSpeed\n');

  const configs = [
    // Baseline: flags we've been using
    ['CURRENT (beginFrame-tuned flags)', [
      '--deterministic-mode',
      '--run-all-compositor-stages-before-draw',
      '--disable-new-content-rendering-timeout',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
      '--disable-checker-imaging',
      '--disable-image-animation-resync',
    ]],

    ['MINIMAL (no extra flags)', []],

    // Strip flags one-by-one
    ['CURRENT - deterministic-mode', [
      '--run-all-compositor-stages-before-draw',
      '--disable-new-content-rendering-timeout',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
      '--disable-checker-imaging',
      '--disable-image-animation-resync',
    ]],

    ['CURRENT - run-all-compositor', [
      '--deterministic-mode',
      '--disable-new-content-rendering-timeout',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
      '--disable-checker-imaging',
      '--disable-image-animation-resync',
    ]],

    ['CURRENT - disable-threaded-animation', [
      '--deterministic-mode',
      '--run-all-compositor-stages-before-draw',
      '--disable-new-content-rendering-timeout',
      '--disable-threaded-scrolling',
      '--disable-checker-imaging',
      '--disable-image-animation-resync',
    ]],

    ['CURRENT - disable-checker-imaging', [
      '--deterministic-mode',
      '--run-all-compositor-stages-before-draw',
      '--disable-new-content-rendering-timeout',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
      '--disable-image-animation-resync',
    ]],

    // Try positive flags that might help
    ['MINIMAL + disable-frame-rate-limit', [
      '--disable-frame-rate-limit',
    ]],

    ['MINIMAL + in-process-gpu', [
      '--in-process-gpu',
    ]],

    ['MINIMAL + disable-gpu-vsync', [
      '--disable-gpu-vsync',
    ]],

    // Enable GPU (we've been disabling it)
    ['ENABLE GPU (remove --disable-gpu)', [
      '--enable-gpu-rasterization',
    ]],
  ];

  const results = [];
  for (const [label, flags] of configs) {
    try {
      results.push(await bench(label, flags));
    } catch (e) {
      console.log(`  ${label.padEnd(50)} ERROR: ${e.message}`);
    }
  }

  console.log('\n=== Top speedups ===');
  results.sort((a, b) => b.speedup - a.speedup);
  for (const r of results.slice(0, 5)) {
    console.log(`  ${r.speedup.toFixed(2).padStart(7)}×  (cap p50 ${r.captureTime.p50.toFixed(1)}ms)  ${r.label}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
