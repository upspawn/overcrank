/**
 * Overcrank performance benchmark.
 *
 * Measures where time is spent in the render pipeline:
 * - Browser launch
 * - Page load + virtual clock injection
 * - Per-frame: advance() + capture() breakdown
 * - FFmpeg encoding
 *
 * Run: bun test/bench.ts
 */

import { Renderer, VIRTUAL_CLOCK_SCRIPT } from '../src/index'
import { encodeFrames, type FrameEntry } from '../src/encoder'
import { chromium } from 'playwright'
import { writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FIXTURE = join(import.meta.dir, 'fixtures', 'animation.html')
const SCENARIOS = [
  { name: 'Small (320x240, 30f)', width: 320, height: 240, frames: 30, fps: 30 },
  { name: 'HD (1280x720, 90f)',   width: 1280, height: 720, frames: 90, fps: 30 },
  { name: 'FHD (1920x1080, 90f)', width: 1920, height: 1080, frames: 90, fps: 30 },
  { name: 'Long (1280x720, 300f)', width: 1280, height: 720, frames: 300, fps: 30 },
]

interface TimingResult {
  scenario: string
  browserLaunchMs: number
  pageLoadMs: number
  advanceTotalMs: number
  captureTotalMs: number
  encodeTotalMs: number
  totalMs: number
  framesPerSec: number
  avgAdvanceMs: number
  avgCaptureMs: number
  avgFrameSizeKB: number
  outputSizeKB: number
}

async function benchScenario(scenario: typeof SCENARIOS[0]): Promise<TimingResult> {
  const tmpDir = join(tmpdir(), `overcrank-bench-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })
  const outputPath = join(tmpDir, 'output.mp4')

  const totalStart = performance.now()

  // Browser launch
  const launchStart = performance.now()
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--disable-software-rasterizer', '--force-device-scale-factor=1'],
  })
  const browserLaunchMs = performance.now() - launchStart

  // Page load
  const loadStart = performance.now()
  const page = await browser.newPage({ viewport: { width: scenario.width, height: scenario.height } })
  page.setDefaultTimeout(60_000)
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
  await page.goto(`file://${FIXTURE}`, { waitUntil: 'domcontentloaded' })
  const pageLoadMs = performance.now() - loadStart

  const renderer = await Renderer.create(page)

  // Capture frames — measure advance and capture separately
  const intervalMs = 1000 / scenario.fps
  let advanceTotalMs = 0
  let captureTotalMs = 0
  let totalFrameBytes = 0
  const frameEntries: FrameEntry[] = []

  for (let i = 0; i < scenario.frames; i++) {
    const advStart = performance.now()
    await renderer.advance(intervalMs)
    advanceTotalMs += performance.now() - advStart

    const capStart = performance.now()
    const frame = await renderer.capture()
    captureTotalMs += performance.now() - capStart

    totalFrameBytes += frame.data.length
    const framePath = join(tmpDir, `frame-${String(i).padStart(6, '0')}.jpg`)
    await writeFile(framePath, frame.data)
    frameEntries.push({ path: framePath, durationS: intervalMs / 1000 })
  }

  await renderer.close()
  await browser.close()

  // Encode
  const encodeStart = performance.now()
  await encodeFrames(frameEntries, outputPath, { x264Preset: 'veryfast', crf: 23, fps: scenario.fps })
  const encodeTotalMs = performance.now() - encodeStart

  const totalMs = performance.now() - totalStart

  let outputSizeKB = 0
  try { outputSizeKB = (await stat(outputPath)).size / 1024 } catch {}

  await rm(tmpDir, { recursive: true, force: true })

  return {
    scenario: scenario.name,
    browserLaunchMs: Math.round(browserLaunchMs),
    pageLoadMs: Math.round(pageLoadMs),
    advanceTotalMs: Math.round(advanceTotalMs),
    captureTotalMs: Math.round(captureTotalMs),
    encodeTotalMs: Math.round(encodeTotalMs),
    totalMs: Math.round(totalMs),
    framesPerSec: Math.round((scenario.frames / totalMs) * 1000 * 10) / 10,
    avgAdvanceMs: Math.round((advanceTotalMs / scenario.frames) * 100) / 100,
    avgCaptureMs: Math.round((captureTotalMs / scenario.frames) * 100) / 100,
    avgFrameSizeKB: Math.round(totalFrameBytes / scenario.frames / 1024 * 10) / 10,
    outputSizeKB: Math.round(outputSizeKB),
  }
}

console.log('Overcrank Performance Benchmark')
console.log('================================\n')

for (const scenario of SCENARIOS) {
  process.stdout.write(`Running: ${scenario.name}...`)
  const result = await benchScenario(scenario)
  console.log(` done (${(result.totalMs / 1000).toFixed(1)}s)\n`)

  console.log(`  Pipeline breakdown:`)
  console.log(`    Browser launch:  ${result.browserLaunchMs}ms`)
  console.log(`    Page load:       ${result.pageLoadMs}ms`)
  console.log(`    Advance (total): ${result.advanceTotalMs}ms  (avg ${result.avgAdvanceMs}ms/frame)`)
  console.log(`    Capture (total): ${result.captureTotalMs}ms  (avg ${result.avgCaptureMs}ms/frame)`)
  console.log(`    Encode (ffmpeg): ${result.encodeTotalMs}ms`)
  console.log(`  Throughput:        ${result.framesPerSec} frames/sec`)
  console.log(`  Avg frame size:    ${result.avgFrameSizeKB} KB`)
  console.log(`  Output size:       ${result.outputSizeKB} KB`)

  // Pie chart breakdown
  const overhead = result.browserLaunchMs + result.pageLoadMs
  const pctOverhead = ((overhead / result.totalMs) * 100).toFixed(0)
  const pctAdvance = ((result.advanceTotalMs / result.totalMs) * 100).toFixed(0)
  const pctCapture = ((result.captureTotalMs / result.totalMs) * 100).toFixed(0)
  const pctEncode = ((result.encodeTotalMs / result.totalMs) * 100).toFixed(0)
  console.log(`  Time split:        ${pctOverhead}% overhead, ${pctAdvance}% advance, ${pctCapture}% capture, ${pctEncode}% encode\n`)
}
