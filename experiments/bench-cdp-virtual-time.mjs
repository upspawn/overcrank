/**
 * Does `Emulation.setVirtualTimePolicy` break the CSS-keyframe compositor
 * cap that captureScreenshot hits on animation.html (~17ms p50 on macOS)?
 *
 * The hypothesis from notes-virtualtimepolicy.md:
 *   Virtual time overrides TimeTicks::Now at the platform layer, so composited
 *   CSS @keyframes should freeze when policy=pause. If true, capture cost
 *   should drop to the canvas-raf.html baseline (~1-3ms) on animation.html.
 *
 * The experiment prescribed by the research agent (verbatim-ish):
 *   1. Load animation.html
 *   2. setVirtualTimePolicy({policy:'pause'})
 *   3. Loop: advance budget=16ms → wait budgetExpired → pause → captureScreenshot
 *   4. Measure per-frame wall-clock cost + verify frames progress
 *
 * Also compares against:
 *   - baseline captureScreenshot on animation.html (current 17ms cap)
 *   - baseline captureScreenshot on canvas-raf.html (current 1-3ms floor)
 *   - IIFE virtual clock on animation.html (should ALSO cap at 17ms
 *     because JS patching can't freeze compositor-driven CSS animations)
 */
import { chromium } from 'playwright';
import { VIRTUAL_CLOCK_SCRIPT, LAUNCH_ARGS } from '../src/index.ts';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { writeFile } from 'node:fs/promises';

const DIR = resolve(fileURLToPath(import.meta.url), '..');
const ANIM = `file://${resolve(DIR, '../test/fixtures/animation.html')}`;
const CANVAS = `file://${resolve(DIR, '../test/fixtures/canvas-raf.html')}`;

const STEP_MS = 16;
const FRAMES = 50;
const WARMUP = 5;

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    min: s[0],
    max: s[s.length - 1],
  };
}
const fmt = (n) => n.toFixed(2).padStart(6);

async function launch() {
  return chromium.launch({ headless: true, args: [...LAUNCH_ARGS] });
}

async function benchBaseline(label, url) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const cdp = await page.context().newCDPSession(page);

    // warmup
    for (let i = 0; i < WARMUP; i++) {
      await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    }

    const caps = [];
    const wallStart = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      const t = performance.now();
      await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
      caps.push(performance.now() - t);
    }
    const wall = performance.now() - wallStart;
    const c = stats(caps);
    console.log(
      `${label.padEnd(48)} cap p50 ${fmt(c.p50)} p95 ${fmt(c.p95)} min ${fmt(c.min)} | wall ${wall.toFixed(0)}ms`,
    );
  } finally {
    await browser.close();
  }
}

async function benchIIFEClock(label, url) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const cdp = await page.context().newCDPSession(page);

    for (let i = 0; i < WARMUP; i++) {
      await page.evaluate((ms) => window.__virtualTime.advance(ms), STEP_MS);
      await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    }

    const caps = [];
    const wallStart = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      await page.evaluate((ms) => window.__virtualTime.advance(ms), STEP_MS);
      const t = performance.now();
      await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
      caps.push(performance.now() - t);
    }
    const wall = performance.now() - wallStart;
    const c = stats(caps);
    console.log(
      `${label.padEnd(48)} cap p50 ${fmt(c.p50)} p95 ${fmt(c.p95)} min ${fmt(c.min)} | wall ${wall.toFixed(0)}ms`,
    );
  } finally {
    await browser.close();
  }
}

async function benchVirtualTime(label, url, { saveFrames = false } = {}) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const cdp = await page.context().newCDPSession(page);

    // Enable virtual time + pause immediately so the page sits frozen at t=0
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });

    // Helper: advance by N virtual ms, then re-pause. Each call is 2 CDP
    // round-trips + 1 event wait.
    async function step(ms) {
      const expired = new Promise((r) => {
        const handler = () => {
          cdp.off('Emulation.virtualTimeBudgetExpired', handler);
          r();
        };
        cdp.on('Emulation.virtualTimeBudgetExpired', handler);
      });
      await cdp.send('Emulation.setVirtualTimePolicy', {
        policy: 'advance',
        budget: ms,
        maxVirtualTimeTaskStarvationCount: 1000,
      });
      await expired;
      await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    }

    // Warmup
    for (let i = 0; i < WARMUP; i++) {
      await step(STEP_MS);
      await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    }

    const stepTimes = [];
    const caps = [];
    const wallStart = performance.now();
    const savedFrames = [];

    for (let i = 0; i < FRAMES; i++) {
      const tStep = performance.now();
      await step(STEP_MS);
      stepTimes.push(performance.now() - tStep);

      const tCap = performance.now();
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
      caps.push(performance.now() - tCap);

      if (saveFrames && (i === 0 || i === 10 || i === 25 || i === 49)) {
        savedFrames.push({ idx: i, data });
      }
    }
    const wall = performance.now() - wallStart;
    const c = stats(caps);
    const s = stats(stepTimes);
    console.log(
      `${label.padEnd(48)} cap p50 ${fmt(c.p50)} p95 ${fmt(c.p95)} min ${fmt(c.min)} | step p50 ${fmt(s.p50)} | wall ${wall.toFixed(0)}ms`,
    );

    if (saveFrames && savedFrames.length > 0) {
      for (const f of savedFrames) {
        const path = resolve(DIR, `vt-frame-${String(f.idx).padStart(3, '0')}.jpg`);
        await writeFile(path, Buffer.from(f.data, 'base64'));
      }
      console.log(
        `  saved frames: ${savedFrames.map((f) => `vt-frame-${String(f.idx).padStart(3, '0')}.jpg`).join(', ')}`,
      );
    }
  } finally {
    await browser.close();
  }
}

console.log(`=== Emulation.setVirtualTimePolicy vs animation.html (CSS @keyframes) ===`);
console.log(`${STEP_MS}ms step × ${FRAMES} frames (+ ${WARMUP} warmup), 640x480 JPEG q80\n`);

console.log('-- animation.html (CSS @keyframes compositor cap) --');
await benchBaseline('baseline captureScreenshot (wall-clock)', ANIM);
await benchIIFEClock('IIFE virtual clock (JS-only patching)', ANIM);
await benchVirtualTime('CDP setVirtualTimePolicy (pause/advance)', ANIM, { saveFrames: true });

console.log('\n-- canvas-raf.html (RAF canvas — control, no CSS compositor) --');
await benchBaseline('baseline captureScreenshot (wall-clock)', CANVAS);
await benchIIFEClock('IIFE virtual clock', CANVAS);
await benchVirtualTime('CDP setVirtualTimePolicy', CANVAS);

console.log('\nDone. Inspect vt-frame-*.jpg to verify CSS animation progression.');
