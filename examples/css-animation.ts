/**
 * Example: Render a JS-driven animation to video.
 *
 * NOTE: Despite the filename, this fixture's box uses a pure CSS @keyframes
 * animation, which is a KNOWN-LIMITATION workload for overcrank — see the
 * "Supported workloads" section in the README. The output will show the
 * box sliding at wall-clock speed, desynced from the virtual-clock text
 * label, because composited CSS animations run on a clock overcrank's
 * in-page JS patching cannot reach.
 *
 * Kept around as the reference reproduction for that limitation.
 *
 * Run: bun examples/css-animation.ts
 */

import { render } from '../src/index'
import { join } from 'node:path'

const fixture = join(import.meta.dir, '..', 'test', 'fixtures', 'animation.html')

const stats = await render(`file://${fixture}`, 'css-animation.mp4', {
  duration: 4,
  fps: 30,
  width: 1280,
  height: 720,
})

console.log(`Done! ${stats.frames} frames in ${(stats.wallClockMs / 1000).toFixed(1)}s`)
console.log(`Video duration: ${(stats.durationMs / 1000).toFixed(1)}s, speedup: ${stats.speedup}x`)
