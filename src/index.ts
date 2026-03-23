/**
 * Overcrank — render any web page to video, faster than real-time.
 *
 * In cinema, overcranking = running the camera faster than normal.
 * We crank through frames as fast as the CPU allows.
 */

import { chromium } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from './virtual-clock'
import { createRenderer } from './renderer'
import { encodeFrames, checkFfmpeg, stitchSegments } from './encoder'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RenderOptions, RenderStats } from './types'

export { createRenderer } from './renderer'
export { VIRTUAL_CLOCK_SCRIPT } from './virtual-clock'
export { checkFfmpeg, encodeFrames, stitchSegments } from './encoder'
export type {
  RenderOptions, RenderStats, Frame, FrameHandler,
  RendererOptions, CDPPage, CDPSession,
} from './types'
export type { Renderer } from './renderer'

/**
 * Render a web page to video. The simple, batteries-included API.
 *
 * Opens a browser, injects virtual clock, captures frames, encodes to video.
 */
export async function render(
  url: string,
  outputPath: string,
  options: RenderOptions = {},
): Promise<RenderStats> {
  const {
    duration,
    fps = 30,
    width = 1920,
    height = 1080,
    quality = 80,
    x264Preset = 'veryfast',
    crf = 23,
    timestamps,
  } = options

  if (!duration && !timestamps) {
    throw new Error('Either duration or timestamps must be provided')
  }

  if (!(await checkFfmpeg())) {
    throw new Error('ffmpeg not found. Install it: brew install ffmpeg')
  }

  const tmpDir = join(tmpdir(), `overcrank-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-software-rasterizer',
      '--force-device-scale-factor=1',
    ],
  })

  const overallStart = performance.now()

  try {
    const page = await browser.newPage({ viewport: { width, height } })
    page.setDefaultTimeout(60_000)
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    const renderer = await createRenderer(page, { fps, quality })

    // Determine capture timestamps
    let captureTimes: number[]
    if (timestamps) {
      captureTimes = [...timestamps].sort((a, b) => a - b)
    } else {
      const intervalMs = 1000 / fps
      const totalMs = duration! * 1000
      captureTimes = []
      for (let t = 0; t <= totalMs; t += intervalMs) {
        captureTimes.push(Math.round(t))
      }
    }

    // Capture frames
    const frameEntries: Array<{ path: string; durationS: number }> = []
    let currentMs = 0

    for (let i = 0; i < captureTimes.length; i++) {
      const targetMs = captureTimes[i]
      const advance = targetMs - currentMs
      if (advance > 0) {
        await renderer.advance(advance)
        currentMs = targetMs
      }

      const frame = await renderer.capture()
      const framePath = join(tmpDir, `frame-${String(i).padStart(6, '0')}.jpg`)
      await writeFile(framePath, frame.data)

      let durationS: number
      if (i < captureTimes.length - 1) {
        durationS = Math.max(0.001, (captureTimes[i + 1] - captureTimes[i]) / 1000)
      } else {
        durationS = 1 / fps
      }
      frameEntries.push({ path: framePath, durationS })
    }

    await renderer.close()

    // Encode to video
    await encodeFrames(frameEntries, outputPath, { x264Preset, crf, fps })

    const wallClockMs = performance.now() - overallStart
    const durationMs = captureTimes[captureTimes.length - 1] - captureTimes[0]

    return {
      frames: captureTimes.length,
      durationMs,
      wallClockMs: Math.round(wallClockMs),
      speedup: durationMs > 0 ? Math.round((durationMs / wallClockMs) * 10) / 10 : 0,
    }
  } finally {
    await browser.close()
    await rm(tmpDir, { recursive: true, force: true })
  }
}
