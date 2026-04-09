/**
 * Benchmark: how fast can overcrank render an rrweb-style recording?
 *
 * Uses the rrweb-like synthetic fixture (setTimeout-driven DOM mutations —
 * same cost profile as a real rrweb Replayer playing events back). Measures
 * end-to-end render() wall-clock vs the recording length to derive a real
 * speedup number.
 *
 * Runs multiple configurations so we can see how resolution, fps, and
 * duration affect the speedup — the thing a user actually cares about
 * for batch rrweb → MP4 conversion.
 */
import { render } from '../src/index.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

const DIR = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURE = `file://${resolve(DIR, '../test/fixtures/rrweb-like.html')}`;

const configs = [
  { label: '1280×720 @ 30fps, 30s',   width: 1280, height: 720,  fps: 30, duration: 30 },
  { label: '1280×720 @ 30fps, 10s',   width: 1280, height: 720,  fps: 30, duration: 10 },
  { label: '1920×1080 @ 30fps, 30s',  width: 1920, height: 1080, fps: 30, duration: 30 },
  { label: '1280×720 @ 15fps, 30s',   width: 1280, height: 720,  fps: 15, duration: 30 },
  { label: '800×600 @ 30fps, 30s',    width: 800,  height: 600,  fps: 30, duration: 30 },
];

console.log('=== rrweb-like replay: render() speedup ===');
console.log(`fixture: ${FIXTURE}\n`);

const results = [];

for (const c of configs) {
  const outputPath = join(tmpdir(), `rrweb-bench-${Date.now()}.mp4`);
  try {
    const stats = await render(FIXTURE, outputPath, {
      duration: c.duration,
      fps: c.fps,
      width: c.width,
      height: c.height,
      quality: 80,
    });
    results.push({ c, stats });
    console.log(
      `${c.label.padEnd(28)}  ` +
      `frames=${String(stats.frames).padStart(4)}  ` +
      `wall=${String(stats.wallClockMs).padStart(5)}ms  ` +
      `recording=${c.duration}s  ` +
      `speedup=${stats.speedup}x`
    );
  } finally {
    await rm(outputPath, { force: true });
  }
}

console.log('\n=== Summary ===');
const best = results.reduce((a, b) => (b.stats.speedup > a.stats.speedup ? b : a));
const worst = results.reduce((a, b) => (b.stats.speedup < a.stats.speedup ? b : a));
console.log(`best:  ${best.c.label.padEnd(28)} ${best.stats.speedup}x real-time`);
console.log(`worst: ${worst.c.label.padEnd(28)} ${worst.stats.speedup}x real-time`);
