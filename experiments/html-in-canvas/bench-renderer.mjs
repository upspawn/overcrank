/**
 * End-to-end bench using the actual Renderer class.
 * Exercises the full advance() + capture() path the way users do.
 */
import { chromium } from 'playwright';
import { Renderer, VIRTUAL_CLOCK_SCRIPT, findChromeCanary, CANARY_DRAW_ELEMENT_ARGS } from '../../src/index.ts';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const DIR = resolve(fileURLToPath(import.meta.url), '..');
const TEST_PAGE = `file://${resolve(DIR, 'test-animation.html')}`;

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    min: s[0], max: s[s.length - 1],
  };
}
const fmt = (n) => n.toFixed(2).padStart(6);

const STEP = 500;
const FRAMES = 60;

async function bench(label) {
  const canaryPath = findChromeCanary();
  const browser = await chromium.launch({
    executablePath: canaryPath ?? undefined,
    args: canaryPath ? [...CANARY_DRAW_ELEMENT_ARGS, '--disable-frame-rate-limit'] : [],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT);
    await page.goto(TEST_PAGE);
    await page.waitForFunction(() => window.__HTML_IN_CANVAS_READY === true);

    const renderer = await Renderer.create(page);
    renderer.setQuality(80).setFormat('jpeg');

    // Prime
    await renderer.advance(16);
    await renderer.capture();

    // Warmup
    for (let i = 0; i < 10; i++) {
      await renderer.advance(STEP);
      await renderer.capture();
    }

    // Measure
    const advs = [];
    const caps = [];
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

console.log('=== Renderer end-to-end bench ===');
console.log(`step=${STEP}ms, ${FRAMES} frames + 10 warmup, html-in-canvas page\n`);
await bench('Tier 1');
