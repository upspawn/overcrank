/**
 * Example: Variable framerate — capture at specific timestamps.
 *
 * Useful when you know exactly which moments matter (e.g., event-driven replay).
 *
 * Run: bun examples/variable-framerate.ts
 */

import { render } from '../src/index'
import { join } from 'node:path'

const fixture = join(import.meta.dir, '..', 'test', 'fixtures', 'animation.html')

// Capture at specific moments — dense at the start, sparse at the end
const timestamps = [
  0, 50, 100, 150, 200,       // 50ms intervals (fast action)
  500, 1000, 1500,             // 500ms intervals (slower)
  3000, 5000, 8000, 10000,    // sparse (not much happening)
]

const stats = await render(`file://${fixture}`, 'variable-framerate.mp4', {
  timestamps,
  width: 1280,
  height: 720,
})

console.log(`Done! ${stats.frames} frames covering ${(stats.durationMs / 1000).toFixed(1)}s`)
console.log(`Wall clock: ${(stats.wallClockMs / 1000).toFixed(1)}s`)
