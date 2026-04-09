/**
 * Benchmark: find the speedup ceiling for html-in-canvas on macOS.
 *
 * Methodology:
 * 1. Breakdown wall time per frame into: advance, capture, save-to-disk
 * 2. Sweep virtual step size (100, 200, 500, 1000 ms)
 * 3. Sweep capture format (JPEG q50/80, PNG)
 * 4. Sweep viewport (640x360, 1280x720, 1920x1080)
 * 5. Skip save-to-disk to find pure capture+advance throughput
 * 6. Use Page.captureScreenshot with optimizeForSpeed
 */
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const CANARY = '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary';
const DIR = resolve(fileURLToPath(import.meta.url), '..');
const TEST_PAGE = join(DIR, 'test-animation.html');
const VCLOCK_PATH = resolve(DIR, '../../src/virtual-clock.iife.js');
const PORT_BASE = 9400;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const virtualClockSrc = readFileSync(VCLOCK_PATH, 'utf8');

function stats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    mean: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
function fmt(n) { return n.toFixed(1).padStart(6); }

class CanaryCDP {
  constructor(port) {
    this.port = port;
    this.msgId = 1;
    this.userDataDir = mkdtempSync(join(tmpdir(), 'canary-bench-'));
  }

  async launch({ width, height }) {
    this.proc = Bun.spawn([
      CANARY, '--headless=new',
      '--enable-features=CanvasDrawElement',
      '--disable-gpu',
      '--deterministic-mode',
      '--run-all-compositor-stages-before-draw',
      '--disable-new-content-rendering-timeout',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
      '--disable-checker-imaging',
      '--disable-image-animation-resync',
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run', '--no-default-browser-check',
      'about:blank',
    ], { stdout: 'pipe', stderr: 'pipe' });

    // Wait for ready
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (r.ok) break;
      } catch {}
    }
    const listRes = await fetch(`http://127.0.0.1:${this.port}/json`);
    const targets = await listRes.json();
    const page = targets.find(t => t.type === 'page');
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });

    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const handler = (event) => {
        const data = JSON.parse(event.data);
        if (data.id === id) {
          this.ws.removeEventListener('message', handler);
          if (data.error) reject(new Error(`${method}: ${JSON.stringify(data.error)}`));
          else resolve(data.result);
        }
      };
      this.ws.addEventListener('message', handler);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() {
    try { this.ws?.close(); } catch {}
    try { this.proc?.kill(); } catch {}
    await sleep(200);
    try { rmSync(this.userDataDir, { recursive: true, force: true }); } catch {}
  }
}

async function runScenario(label, { width, height, step, format, quality, frames = 60, warmup = 10, optimizeForSpeed = true }) {
  const cdp = new CanaryCDP(PORT_BASE + Math.floor(Math.random() * 100));
  try {
    await cdp.launch({ width, height });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: virtualClockSrc });
    await cdp.send('Page.navigate', { url: `file://${TEST_PAGE}` });

    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const r = await cdp.send('Runtime.evaluate', { expression: 'window.__HTML_IN_CANVAS_READY === true' });
      if (r.result.value === true) break;
    }
    await sleep(200);

    // Prime initial snapshot
    await cdp.send('Runtime.evaluate', {
      expression: `(() => { let r = 16; while (r > 0) { const c = Math.min(r, 16); window.__virtualTime.advance(c); r -= c; } })()`,
    });
    await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });

    const captureParams = { format };
    if (format === 'jpeg') captureParams.quality = quality;
    if (optimizeForSpeed) captureParams.optimizeForSpeed = true;

    // Warmup
    for (let i = 0; i < warmup; i++) {
      await cdp.send('Runtime.evaluate', {
        expression: `(() => { let r = ${step}; while (r > 0) { const c = Math.min(r, 16); window.__virtualTime.advance(c); r -= c; } })()`,
      });
      await cdp.send('Page.captureScreenshot', captureParams);
    }

    // Measure
    const advanceTimes = [];
    const captureTimes = [];
    const totalTimes = [];
    const screenshotSizes = [];

    const wallStart = performance.now();
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();

      await cdp.send('Runtime.evaluate', {
        expression: `(() => { let r = ${step}; while (r > 0) { const c = Math.min(r, 16); window.__virtualTime.advance(c); r -= c; } })()`,
      });
      const t1 = performance.now();

      const result = await cdp.send('Page.captureScreenshot', captureParams);
      const t2 = performance.now();

      advanceTimes.push(t1 - t0);
      captureTimes.push(t2 - t1);
      totalTimes.push(t2 - t0);
      screenshotSizes.push(result.data.length * 0.75); // base64 → bytes
    }
    const wallTotal = performance.now() - wallStart;

    const virtualTotal = frames * step;
    const speedup = virtualTotal / wallTotal;
    const a = stats(advanceTimes);
    const c = stats(captureTimes);
    const t = stats(totalTimes);
    const sizeMean = screenshotSizes.reduce((a, b) => a + b, 0) / screenshotSizes.length;

    console.log(
      `  ${label.padEnd(45)} | ` +
      `adv ${fmt(a.mean)}ms | ` +
      `cap p50 ${fmt(c.p50)} p95 ${fmt(c.p95)} | ` +
      `tot ${fmt(t.mean)}ms | ` +
      `${speedup.toFixed(2).padStart(5)}× | ` +
      `${(sizeMean / 1024).toFixed(0).padStart(4)}KB`
    );

    return { label, speedup, advance: a, capture: c, total: t, wallTotal, virtualTotal };
  } finally {
    await cdp.close();
  }
}

async function main() {
  console.log('\n=== Benchmark: html-in-canvas speedup ceiling ===');
  console.log('All tests: macOS Canary headless, 60 frames + 10 warmup\n');

  const scenarios = [
    // Baseline — current user config
    { label: 'BASELINE 800×600 step=100 PNG',          width: 800,  height: 600,  step: 100,  format: 'png' },

    // Sweep 1: virtual step size (bigger step = more virtual time per wall frame)
    { label: 'STEP 800×600 step=100 JPEG q80',         width: 800,  height: 600,  step: 100,  format: 'jpeg', quality: 80 },
    { label: 'STEP 800×600 step=200 JPEG q80',         width: 800,  height: 600,  step: 200,  format: 'jpeg', quality: 80 },
    { label: 'STEP 800×600 step=500 JPEG q80',         width: 800,  height: 600,  step: 500,  format: 'jpeg', quality: 80 },
    { label: 'STEP 800×600 step=1000 JPEG q80',        width: 800,  height: 600,  step: 1000, format: 'jpeg', quality: 80 },

    // Sweep 2: format
    { label: 'FORMAT 800×600 step=100 PNG',            width: 800,  height: 600,  step: 100,  format: 'png' },
    { label: 'FORMAT 800×600 step=100 JPEG q90',       width: 800,  height: 600,  step: 100,  format: 'jpeg', quality: 90 },
    { label: 'FORMAT 800×600 step=100 JPEG q50',       width: 800,  height: 600,  step: 100,  format: 'jpeg', quality: 50 },
    { label: 'FORMAT 800×600 step=100 JPEG q30',       width: 800,  height: 600,  step: 100,  format: 'jpeg', quality: 30 },

    // Sweep 3: viewport size
    { label: 'SIZE 640×360 step=100 JPEG q50',         width: 640,  height: 360,  step: 100,  format: 'jpeg', quality: 50 },
    { label: 'SIZE 800×600 step=100 JPEG q50',         width: 800,  height: 600,  step: 100,  format: 'jpeg', quality: 50 },
    { label: 'SIZE 1280×720 step=100 JPEG q50',        width: 1280, height: 720,  step: 100,  format: 'jpeg', quality: 50 },
    { label: 'SIZE 1920×1080 step=100 JPEG q50',       width: 1920, height: 1080, step: 100,  format: 'jpeg', quality: 50 },

    // MAX push: biggest step + smallest viewport + cheapest format
    { label: 'MAX 640×360 step=500 JPEG q50',          width: 640,  height: 360,  step: 500,  format: 'jpeg', quality: 50 },
    { label: 'MAX 640×360 step=1000 JPEG q50',         width: 640,  height: 360,  step: 1000, format: 'jpeg', quality: 50 },
    { label: 'MAX 640×360 step=2000 JPEG q50',         width: 640,  height: 360,  step: 2000, format: 'jpeg', quality: 50 },
  ];

  const results = [];
  for (const sc of scenarios) {
    try {
      results.push(await runScenario(sc.label, sc));
    } catch (e) {
      console.log(`  ${sc.label.padEnd(45)} | ERROR: ${e.message}`);
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  results.sort((a, b) => b.speedup - a.speedup);
  console.log('Top 5 by speedup:');
  for (const r of results.slice(0, 5)) {
    console.log(`  ${r.speedup.toFixed(2).padStart(6)}×  ${r.label}`);
  }
  console.log(`\nBottom 3:`);
  for (const r of results.slice(-3)) {
    console.log(`  ${r.speedup.toFixed(2).padStart(6)}×  ${r.label}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
