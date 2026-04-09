/**
 * What's the captureScreenshot ceiling on animation.html (CSS keyframes)
 * vs canvas-raf.html (RAF canvas)? Hypothesis: CSS threaded animations
 * hold the compositor hostage even with --disable-frame-rate-limit.
 */
import { chromium } from 'playwright';
import { Renderer, VIRTUAL_CLOCK_SCRIPT, LAUNCH_ARGS } from '../src/index.ts';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const DIR = resolve(fileURLToPath(import.meta.url), '..');
const ANIM   = `file://${resolve(DIR, '../test/fixtures/animation.html')}`;
const CANVAS = `file://${resolve(DIR, '../test/fixtures/canvas-raf.html')}`;

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length * 0.5)], min: s[0] };
}
const fmt = (n) => n.toFixed(2).padStart(6);

const STEP = 500;
const FRAMES = 40;

async function bench(label, { url, extraArgs = [], width = 640, height = 480 }) {
  const browser = await chromium.launch({
    headless: true,
    args: [...LAUNCH_ARGS, ...extraArgs],
  });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT);
    await page.goto(url);

    const renderer = await Renderer.create(page);
    renderer.setQuality(80).setFormat('jpeg');

    for (let i = 0; i < 5; i++) { await renderer.advance(16); await renderer.capture(); }

    const caps = [];
    const wallStart = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      await renderer.advance(STEP);
      const t = performance.now();
      await renderer.capture();
      caps.push(performance.now() - t);
    }
    const wall = performance.now() - wallStart;
    const c = stats(caps);
    console.log(
      `${label.padEnd(42)} cap p50 ${fmt(c.p50)} min ${fmt(c.min)} | ${((FRAMES*STEP)/wall).toFixed(1).padStart(7)}×`
    );
    await renderer.close();
  } finally {
    await browser.close();
  }
}

console.log('=== CSS animation vs RAF canvas on macOS ===\n');
console.log('-- animation.html (CSS @keyframes, 640x480) --');
await bench('baseline LAUNCH_ARGS', { url: ANIM });
await bench('+ --disable-threaded-animation', { url: ANIM, extraArgs: ['--disable-threaded-animation'] });
await bench('+ --disable-background-timer-throttling', { url: ANIM, extraArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
await bench('+ --disable-composited-animations', { url: ANIM, extraArgs: ['--disable-threaded-animation', '--disable-threaded-scrolling', '--disable-checker-imaging'] });
await bench('+ --blink-settings=acceleratedAnimationEnabled=false', { url: ANIM, extraArgs: ['--blink-settings=acceleratedAnimationEnabled=false'] });

console.log('\n-- canvas-raf.html (RAF canvas, 640x480) for comparison --');
await bench('baseline LAUNCH_ARGS', { url: CANVAS });
