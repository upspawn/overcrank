/**
 * Example: Frame-by-frame control with createRenderer.
 *
 * Captures frames manually and writes them to disk as individual JPEGs.
 * Useful when you want to process frames yourself instead of encoding to video.
 *
 * Run: bun examples/frame-by-frame.ts
 */

import { createRenderer, VIRTUAL_CLOCK_SCRIPT } from '../src/index'
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const fixture = join(import.meta.dir, '..', 'test', 'fixtures', 'animation.html')
const outDir = join(import.meta.dir, 'frames')
await mkdir(outDir, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
await page.goto(`file://${fixture}`)

const renderer = await createRenderer(page)

// Capture 30 frames at 100ms intervals (3 seconds, 10fps)
for (let i = 0; i < 30; i++) {
  await renderer.advance(100)
  const frame = await renderer.capture()
  const path = join(outDir, `frame-${String(i).padStart(4, '0')}.jpg`)
  await writeFile(path, frame.data)
}

console.log(`Wrote 30 frames to ${outDir}`)

await renderer.close()
await browser.close()
