/**
 * Sanity check: capture frames with Tier 1 Renderer, write them to disk,
 * and verify they actually differ frame-to-frame (proves virtual time is
 * advancing + compositor is re-drawing + no caching shortcut is lying).
 */
import { chromium } from 'playwright';
import { Renderer, VIRTUAL_CLOCK_SCRIPT, findChromeCanary, CANARY_DRAW_ELEMENT_ARGS } from '../../src/index.ts';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync } from 'fs';

const DIR = resolve(fileURLToPath(import.meta.url), '..');
const OUT = resolve(DIR, 'verify-frames');
mkdirSync(OUT, { recursive: true });

const canaryPath = findChromeCanary();
const browser = await chromium.launch({
  executablePath: canaryPath ?? undefined,
  args: canaryPath ? [...CANARY_DRAW_ELEMENT_ARGS, '--disable-frame-rate-limit'] : [],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.addInitScript(VIRTUAL_CLOCK_SCRIPT);
await page.goto(`file://${resolve(DIR, 'test-animation.html')}`);
await page.waitForFunction(() => window.__HTML_IN_CANVAS_READY === true);

const renderer = await Renderer.create(page);
renderer.setQuality(80);

const hashes = new Set();
for (let i = 0; i < 5; i++) {
  await renderer.advance(500);
  const frame = await renderer.capture();
  // Hash the middle of the JPEG (past the header/huffman tables)
  const mid = Math.floor(frame.data.length / 2);
  const h = frame.data.subarray(mid, mid + 512).reduce((a, b) => (a * 31 + b) >>> 0, 0);
  hashes.add(h);
  writeFileSync(`${OUT}/frame-${i}-ts${frame.timestamp}.jpg`, frame.data);
  console.log(`frame ${i}  ts=${frame.timestamp}ms  size=${frame.data.length}b  hash=${h}`);
}
console.log(`\nunique hashes: ${hashes.size}/5 ${hashes.size > 1 ? '✓' : '✗ FRAMES NOT CHANGING'}`);
console.log(`elapsedMs=${renderer.elapsedMs}`);

await renderer.close();
await browser.close();
