/**
 * Visually verify overcrank output: render the two canonical fixtures
 * end-to-end through the high-level render() API, then spot-check frames
 * via ffprobe and extract keyframes for Quick Look.
 */
import { render } from '../src/index.ts';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const DIR = resolve(fileURLToPath(import.meta.url), '..');
const ROOT = resolve(DIR, '..');
const OUT_DIR = join(ROOT, 'experiments', 'verify-out');

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const fixtures = [
  {
    label: 'CSS @keyframes (animation.html)',
    url: `file://${join(ROOT, 'test/fixtures/animation.html')}`,
    out: join(OUT_DIR, 'css-animation.mp4'),
    duration: 4, fps: 30, width: 1280, height: 720,
  },
  {
    label: 'Canvas RAF (canvas-raf.html)',
    url: `file://${join(ROOT, 'test/fixtures/canvas-raf.html')}`,
    out: join(OUT_DIR, 'canvas-raf.mp4'),
    duration: 4, fps: 30, width: 400, height: 240,
  },
];

function probe(path) {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=nb_read_frames,width,height,r_frame_rate,duration,codec_name',
    '-of', 'default=noprint_wrappers=1',
    path,
  ], { encoding: 'utf-8' });
  return r.stdout.trim();
}

function extractFrames(videoPath, outDirForFrames) {
  // Extract 5 evenly-spaced frames
  const r = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', videoPath,
    '-vf', 'fps=1',  // 1 frame per second
    join(outDirForFrames, 'frame-%02d.png'),
  ], { encoding: 'utf-8' });
  if (r.status !== 0) console.error('ffmpeg extract failed:', r.stderr);
}

for (const f of fixtures) {
  console.log(`\n=== ${f.label} ===`);
  const t0 = performance.now();
  const stats = await render(f.url, f.out, {
    duration: f.duration,
    fps: f.fps,
    width: f.width,
    height: f.height,
  });
  const wall = performance.now() - t0;
  console.log(`  frames: ${stats.frames}`);
  console.log(`  video duration: ${(stats.durationMs / 1000).toFixed(2)}s`);
  console.log(`  wall: ${wall.toFixed(0)}ms`);
  console.log(`  speedup: ${stats.speedup}x`);
  console.log(`  file: ${f.out}`);
  console.log(`  ffprobe:\n${probe(f.out).split('\n').map((l) => '    ' + l).join('\n')}`);

  const framesDir = join(OUT_DIR, f.out.split('/').pop().replace('.mp4', '') + '-frames');
  await mkdir(framesDir, { recursive: true });
  extractFrames(f.out, framesDir);
  console.log(`  keyframes extracted to: ${framesDir}`);
}

console.log(`\n--- Open in Quick Look ---`);
console.log(`  open ${OUT_DIR}/css-animation.mp4`);
console.log(`  open ${OUT_DIR}/canvas-raf.mp4`);
console.log(`  open ${OUT_DIR}/css-animation-frames/`);
console.log(`  open ${OUT_DIR}/canvas-raf-frames/`);
