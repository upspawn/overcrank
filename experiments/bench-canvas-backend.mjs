/**
 * End-to-end benchmark of the setCanvasTarget backend on a pure
 * RAF-driven canvas workload. No Canary / html-in-canvas required.
 */
import { chromium } from 'playwright';
import { Renderer, VIRTUAL_CLOCK_SCRIPT, LAUNCH_ARGS } from '../src/index.ts';
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

const STEP = 500;
const FRAMES = 80;

async function bench(label, { canvasTarget = null } = {}) {
  const browser = await chromium.launch({ headless: true, args: [...LAUNCH_ARGS] });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT);
    await page.goto(FIXTURE);
    await page.waitForFunction(() => window.__READY === true);

    const renderer = await Renderer.create(page);
    renderer.setQuality(80).setFormat('jpeg');
    if (canvasTarget) renderer.setCanvasTarget(canvasTarget);

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
      `${label.padEnd(20)} adv p50 ${fmt(a.p50)} min ${fmt(a.min)} | cap p50 ${fmt(c.p50)} min ${fmt(c.min)} | ${speedup.toFixed(2).padStart(7)}×`
    );
    await renderer.close();
  } finally {
    await browser.close();
  }
}

console.log('=== Canvas backend vs captureScreenshot (RAF workload) ===');
console.log(`step=${STEP}ms, ${FRAMES} frames + 10 warmup, 400×240 JPEG q80\n`);
await bench('captureScreenshot');
await bench('canvas target',    { canvasTarget: '#scene' });
await bench('canvas target #2', { canvasTarget: '#scene' });
