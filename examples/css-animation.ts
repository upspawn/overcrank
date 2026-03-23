/**
 * Example: Render a CSS animation to video.
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
