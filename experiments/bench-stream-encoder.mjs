/**
 * Measure the win from piping frames directly to ffmpeg stdin vs
 * writing to tmp files + concat demuxer. Runs the same render() call
 * in both modes by temporarily forcing the timestamps branch for the
 * file path.
 *
 * Each mode runs N trials to smooth out GC / I/O jitter.
 */
import { chromium } from 'playwright';
import { Renderer, VIRTUAL_CLOCK_SCRIPT, LAUNCH_ARGS, StreamEncoder, encodeFrames } from '../src/index.ts';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'url';

const DIR = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURE = `file://${resolve(DIR, '../test/fixtures/canvas-raf.html')}`;

const FPS = 30;
const DURATION_S = 4;
const TRIALS = 3;

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length * 0.5)], min: s[0], max: s[s.length - 1] };
}

async function runStreaming() {
  const browser = await chromium.launch({ headless: true, args: [...LAUNCH_ARGS] });
  const outputPath = join(tmpdir(), `stream-${Date.now()}.mp4`);
  const t0 = performance.now();
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT);
    await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
    const renderer = await Renderer.create(page);
    renderer.setQuality(80).setFormat('jpeg');
    await renderer.advance(1);

    const intervalMs = 1000 / FPS;
    const total = DURATION_S * 1000;
    const encoder = new StreamEncoder(outputPath, { fps: FPS, format: 'jpeg', crf: 23 });

    let cur = 1;
    let frames = 0;
    for (let t = 0; t <= total; t += intervalMs) {
      const target = Math.round(t);
      if (target > cur) { await renderer.advance(target - cur); cur = target; }
      const f = await renderer.capture();
      await encoder.writeFrame(f.data);
      frames++;
    }
    await renderer.close();
    await encoder.finish();
    return { wall: performance.now() - t0, frames };
  } finally {
    await browser.close();
    await rm(outputPath, { force: true });
  }
}

async function runFileBased() {
  const browser = await chromium.launch({ headless: true, args: [...LAUNCH_ARGS] });
  const tmpDir = join(tmpdir(), `file-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  const outputPath = join(tmpdir(), `file-${Date.now()}.mp4`);
  const t0 = performance.now();
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT);
    await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
    const renderer = await Renderer.create(page);
    renderer.setQuality(80).setFormat('jpeg');
    await renderer.advance(1);

    const intervalMs = 1000 / FPS;
    const total = DURATION_S * 1000;
    const entries = [];
    let cur = 1;
    let frames = 0;

    for (let t = 0; t <= total; t += intervalMs) {
      const target = Math.round(t);
      if (target > cur) { await renderer.advance(target - cur); cur = target; }
      const f = await renderer.capture();
      const fp = join(tmpDir, `frame-${String(frames).padStart(6, '0')}.jpg`);
      await writeFile(fp, f.data);
      entries.push({ path: fp, durationS: 1 / FPS });
      frames++;
    }
    await renderer.close();
    await encodeFrames(entries, outputPath, { fps: FPS, crf: 23 });
    return { wall: performance.now() - t0, frames };
  } finally {
    await browser.close();
    await rm(tmpDir, { recursive: true, force: true });
    await rm(outputPath, { force: true });
  }
}

console.log(`=== StreamEncoder vs file-based concat ===`);
console.log(`canvas-raf.html, 400x240, ${FPS}fps, ${DURATION_S}s video, ${TRIALS} trials each\n`);

const streamResults = [];
const fileResults = [];

// Warmup — first run is always slower due to CDP/Playwright cold start
console.log('warmup...');
await runStreaming();

for (let i = 0; i < TRIALS; i++) {
  const s = await runStreaming();
  streamResults.push(s.wall);
  const f = await runFileBased();
  fileResults.push(f.wall);
  console.log(`trial ${i + 1}: stream=${s.wall.toFixed(0)}ms  file=${f.wall.toFixed(0)}ms`);
}

const ss = stats(streamResults);
const fs = stats(fileResults);
console.log(`\nStream  p50: ${ss.p50.toFixed(0)}ms  min: ${ss.min.toFixed(0)}ms  max: ${ss.max.toFixed(0)}ms`);
console.log(`File    p50: ${fs.p50.toFixed(0)}ms  min: ${fs.min.toFixed(0)}ms  max: ${fs.max.toFixed(0)}ms`);
console.log(`Delta (file - stream) p50: ${(fs.p50 - ss.p50).toFixed(0)}ms  (${(((fs.p50 - ss.p50) / fs.p50) * 100).toFixed(1)}%)`);
