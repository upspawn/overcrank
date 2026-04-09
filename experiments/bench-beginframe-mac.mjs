/**
 * MASSIVE FINDING: Playwright ships `chrome-headless-shell` on macOS (not full
 * Chromium). That's the same binary that supports HeadlessExperimental.beginFrame
 * on Linux — we just need to pass --enable-begin-frame-control to unlock it.
 *
 * This benchmark proves the hypothesis: compare captureScreenshot vs
 * beginFrame on the canvas-raf.html fixture via Playwright's bundled
 * chrome-headless-shell on macOS.
 */
import { chromium } from 'playwright';
import { Renderer, VIRTUAL_CLOCK_SCRIPT } from '../src/index.ts';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const DIR = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURE = `file://${resolve(DIR, '../test/fixtures/canvas-raf.html')}`;

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    min: s[0],
  };
}
const fmt = (n) => n.toFixed(2).padStart(6);

const BASE_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--disable-software-rasterizer',
  '--force-device-scale-factor=1',
  '--disable-frame-rate-limit',
];

const BEGIN_FRAME_ARGS = [
  '--enable-begin-frame-control',
  '--run-all-compositor-stages-before-draw',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
];

const STEP = 500;
const FRAMES = 60;

async function bench(label, { extraArgs = [] } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [...BASE_ARGS, ...extraArgs],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT);
    await page.goto(FIXTURE);
    await page.waitForFunction(() => window.__READY === true);

    const renderer = await Renderer.create(page);
    renderer.setQuality(80).setFormat('jpeg');

    await renderer.advance(16);
    await renderer.capture(); // prime

    for (let i = 0; i < 10; i++) {
      await renderer.advance(STEP);
      await renderer.capture();
    }

    const advs = [], caps = [];
    const wallStart = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      const t0 = performance.now();
      await renderer.advance(STEP);
      const t1 = performance.now();
      await renderer.capture();
      const t2 = performance.now();
      advs.push(t1 - t0);
      caps.push(t2 - t1);
    }
    const wall = performance.now() - wallStart;
    const speedup = (FRAMES * STEP) / wall;
    const a = stats(advs);
    const c = stats(caps);
    console.log(
      `${label.padEnd(40)} usesBeginFrame=${String(renderer.usesBeginFrame).padEnd(5)} ` +
      `adv p50 ${fmt(a.p50)} | cap p50 ${fmt(c.p50)} min ${fmt(c.min)} | ${speedup.toFixed(1).padStart(7)}×`
    );
    await renderer.close();
  } finally {
    await browser.close();
  }
}

console.log('=== macOS beginFrame on Playwright chrome-headless-shell ===');
console.log(`step=${STEP}ms, ${FRAMES} frames + 10 warmup, 400×240 JPEG q80 (canvas-raf.html)\n`);

await bench('(A) default — captureScreenshot');
await bench('(B) + begin-frame-control only', { extraArgs: ['--enable-begin-frame-control'] });
await bench('(C) + run-all-compositor-stages', { extraArgs: ['--enable-begin-frame-control', '--run-all-compositor-stages-before-draw'] }).catch(e => console.log('(C) crashed:', e.message));
await bench('(D) + disable-threaded-animation', { extraArgs: ['--enable-begin-frame-control', '--disable-threaded-animation'] }).catch(e => console.log('(D) crashed:', e.message));
await bench('(E) + disable-threaded-scrolling', { extraArgs: ['--enable-begin-frame-control', '--disable-threaded-scrolling'] }).catch(e => console.log('(E) crashed:', e.message));
await bench('(F) full BEGIN_FRAME_ARGS', { extraArgs: BEGIN_FRAME_ARGS }).catch(e => console.log('(F) crashed:', e.message));
