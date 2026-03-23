/**
 * Overcrank — render any web page to video, faster than real-time.
 *
 * In cinema, overcranking = running the camera faster than normal.
 * We crank through frames as fast as the CPU allows.
 */

import { chromium, type Page, type CDPSession, type Browser } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from './virtual-clock'
import { Renderer, createRenderer } from './renderer'
import { encodeFrames, checkFfmpeg, stitchSegments } from './encoder'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cpus } from 'node:os'
import type { RenderOptions, RenderStats } from './types'

export { Renderer, createRenderer } from './renderer'
export { renderCanvas } from './render-canvas'
export { VIRTUAL_CLOCK_SCRIPT } from './virtual-clock'
export { checkFfmpeg, encodeFrames, stitchSegments } from './encoder'
export type {
  RenderOptions, RenderCanvasOptions, RenderStats, Frame, FrameHandler,
  FrameFormat, CaptureMethod, CDPPage, CDPSession,
} from './types'

const BROWSER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--disable-software-rasterizer',
  '--force-device-scale-factor=1',
]

interface Tab {
  page: Page
  cdp: CDPSession
}

async function createTab(
  browser: Browser,
  url: string,
  width: number,
  height: number,
): Promise<Tab> {
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // Kick virtual clock so RAF callbacks register
  await page.evaluate(() => (window as any).__virtualTime.advance(1))
  await page.waitForTimeout(50)
  const cdp = await page.context().newCDPSession(page)
  return { page, cdp }
}

/**
 * Render a web page to video. The simple, batteries-included API.
 *
 * Uses parallel browser tabs to capture multiple frames simultaneously,
 * bypassing the ~33ms per-frame CDP screenshot bottleneck.
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
    format = 'jpeg',
    x264Preset = 'veryfast',
    crf = 23,
    timestamps,
    workers,
    onProgress,
  } = options

  if (!duration && !timestamps) {
    throw new Error('Either duration or timestamps must be provided')
  }

  if (!(await checkFfmpeg())) {
    throw new Error('ffmpeg not found. Install it: brew install ffmpeg')
  }

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

  const totalFrames = captureTimes.length
  const tabCount = Math.min(
    workers ?? Math.min(cpus().length, 8),
    totalFrames,
  )

  const ext = format === 'png' ? 'png' : 'jpg'
  const tmpDir = join(tmpdir(), `overcrank-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })

  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS })
  const overallStart = performance.now()

  try {
    // Create parallel tabs
    const tabs: Tab[] = []
    for (let i = 0; i < tabCount; i++) {
      tabs.push(await createTab(browser, url, width, height))
    }

    const screenshotParams: Record<string, unknown> = {
      format,
      optimizeForSpeed: true,
    }
    if (format === 'jpeg') {
      screenshotParams.quality = quality
    }

    // Capture frames in parallel rounds
    const frameEntries: Array<{ path: string; durationS: number }> = []
    let framesCaptured = 0

    while (framesCaptured < totalFrames) {
      const batchSize = Math.min(tabCount, totalFrames - framesCaptured)

      // Advance each tab to its target virtual time
      const advancePromises: Promise<void>[] = []
      for (let i = 0; i < batchSize; i++) {
        const targetMs = captureTimes[framesCaptured + i]
        advancePromises.push(
          tabs[i].page.evaluate((ms: number) => {
            const current = (window as any).__virtualTime.now()
            const advance = ms - current
            if (advance > 0) (window as any).__virtualTime.advance(advance)
          }, targetMs + 1), // +1 accounts for initial kick
        )
      }
      await Promise.all(advancePromises)

      // Capture all tabs in parallel — this is where the speedup happens
      const capturePromises: Promise<any>[] = []
      for (let i = 0; i < batchSize; i++) {
        capturePromises.push(
          tabs[i].cdp.send('Page.captureScreenshot', screenshotParams),
        )
      }
      const screenshots = await Promise.all(capturePromises)

      // Write frames to disk
      for (let i = 0; i < batchSize; i++) {
        const frameIndex = framesCaptured + i
        const buffer = Buffer.from(screenshots[i].data as string, 'base64')
        const framePath = join(tmpDir, `frame-${String(frameIndex).padStart(6, '0')}.${ext}`)
        await writeFile(framePath, buffer)

        let durationS: number
        if (frameIndex < totalFrames - 1) {
          durationS = Math.max(0.001, (captureTimes[frameIndex + 1] - captureTimes[frameIndex]) / 1000)
        } else {
          durationS = 1 / fps
        }
        frameEntries.push({ path: framePath, durationS })
      }

      framesCaptured += batchSize
      onProgress?.(framesCaptured, totalFrames)
    }

    // Close tabs
    for (const tab of tabs) {
      await tab.cdp.detach().catch(() => {})
    }

    // Encode to video
    await encodeFrames(frameEntries, outputPath, { x264Preset, crf, fps })

    const wallClockMs = performance.now() - overallStart
    const durationMs = captureTimes[captureTimes.length - 1] - captureTimes[0]

    return {
      frames: totalFrames,
      durationMs,
      wallClockMs: Math.round(wallClockMs),
      speedup: durationMs > 0 ? Math.round((durationMs / wallClockMs) * 10) / 10 : 0,
    }
  } finally {
    await browser.close()
    await rm(tmpDir, { recursive: true, force: true })
  }
}
