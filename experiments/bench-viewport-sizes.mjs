/**
 * Test captureScreenshot speed at realistic viewport sizes on Playwright macOS.
 *
 * The finding from bench-beginframe-mac.mjs: when we launch with our full
 * BASE_ARGS (including --disable-frame-rate-limit), captureScreenshot at
 * 400×240 runs at 0.88ms p50 — not the 16ms FINDINGS.md reported. The old
 * bench-canvas-backend.mjs was launching with no args and hitting the VSync
 * floor.
 *
 * So the real question: at 1920×1080 (normal use case), how fast IS the
 * captureScreenshot path with the right flags?
 */
import { chromium } from 'playwright';
import { Renderer, VIRTUAL_CLOCK_SCRIPT } from '../src/index.ts';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const DIR = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURE = `file://${resolve(DIR, '../test/fixtures/canvas-raf.html')}`;

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length * 0.5)], min: s[0] };
}
const fmt = (n) => n.toFixed(2).padStart(6);

const BASE_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--disable-software-rasterizer',
  '--force-device-scale-factor=1',
  '--disable-frame-rate-limit',
];

const STEP = 500;
const FRAMES = 60;

async function bench(label, { width, height, canvasTarget = null, launchArgs = BASE_ARGS }) {
  const browser = await chromium.launch({ headless: true, args: launchArgs });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT);
    await page.goto(FIXTURE);
    await page.waitForFunction(() => window.__READY === true);

    const renderer = await Renderer.create(page);
    renderer.setQuality(80).setFormat('jpeg');
    if (canvasTarget) renderer.setCanvasTarget(canvasTarget);

    await renderer.advance(16);
    await renderer.capture();

    for (let i = 0; i < 10; i++) {
      await renderer.advance(STEP);
      await renderer.capture();
    }

    const caps = [];
    const wallStart = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      await renderer.advance(STEP);
      const t = performance.now();
      await renderer.capture();
      caps.push(performance.now() - t);
    }
    const wall = performance.now() - wallStart;
    const speedup = (FRAMES * STEP) / wall;
    const c = stats(caps);
    console.log(
      `${label.padEnd(38)} cap p50 ${fmt(c.p50)} min ${fmt(c.min)} | ${speedup.toFixed(1).padStart(7)}×`
    );
    await renderer.close();
  } finally {
    await browser.close();
  }
}

console.log('=== Viewport size sweep (step=500, canvas-raf.html) ===\n');

console.log('-- Default Playwright launch (NO args — silent regression) --');
await bench('no-args  400x240  capture',   { width: 400,  height: 240,  launchArgs: [] });
await bench('no-args  400x240  canvas',    { width: 400,  height: 240,  launchArgs: [], canvasTarget: '#scene' });
await bench('no-args 1280x720  capture',   { width: 1280, height: 720,  launchArgs: [] });
await bench('no-args 1920x1080 capture',   { width: 1920, height: 1080, launchArgs: [] });

console.log('\n-- With BASE_ARGS (--disable-frame-rate-limit etc) --');
await bench('args    400x240  capture',    { width: 400,  height: 240  });
await bench('args    400x240  canvas',     { width: 400,  height: 240,  canvasTarget: '#scene' });
await bench('args    800x600  capture',    { width: 800,  height: 600  });
await bench('args    800x600  canvas',     { width: 800,  height: 600,  canvasTarget: '#scene' });
await bench('args   1280x720  capture',    { width: 1280, height: 720  });
await bench('args   1280x720  canvas',     { width: 1280, height: 720,  canvasTarget: '#scene' });
await bench('args   1920x1080 capture',    { width: 1920, height: 1080 });
await bench('args   1920x1080 canvas',     { width: 1920, height: 1080, canvasTarget: '#scene' });
