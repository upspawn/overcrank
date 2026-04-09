/**
 * Overcrank — render any web page to video, faster than real-time.
 *
 * In cinema, overcranking = running the camera faster than normal.
 * We crank through frames as fast as the CPU allows.
 */

import { chromium } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from './virtual-clock'
import { Renderer, createRenderer } from './renderer'
import { encodeFrames, checkFfmpeg, stitchSegments } from './encoder'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import type { RenderOptions, RenderStats } from './types'

export { Renderer, createRenderer } from './renderer'
export { VIRTUAL_CLOCK_SCRIPT } from './virtual-clock'
export { checkFfmpeg, encodeFrames, stitchSegments } from './encoder'
export {
  findChromeCanary,
  hasHtmlInCanvasSupport,
  CANARY_DRAW_ELEMENT_ARGS,
} from './canary'
export type {
  RenderOptions, RenderStats, Frame, FrameHandler,
  FrameFormat, CDPPage, CDPSession,
} from './types'

const BROWSER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--disable-software-rasterizer',
  '--force-device-scale-factor=1',
]

const BEGIN_FRAME_ARGS = [
  '--enable-begin-frame-control',
  '--run-all-compositor-stages-before-draw',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  '--disable-frame-rate-limit',
]

/**
 * Find chrome-headless-shell binary (supports beginFrame, Linux only).
 * Returns the path if found, null otherwise.
 */
function findHeadlessShell(): string | null {
  if (process.platform !== 'linux') return null

  // Check Playwright's cache
  try {
    const result = execSync(
      'find ${HOME}/.cache/ms-playwright -name "headless_shell" -type f 2>/dev/null | head -1',
      { encoding: 'utf-8', timeout: 3000 },
    )
    const path = result.trim()
    if (path && existsSync(path)) return path
  } catch {}

  return null
}

/**
 * Render a web page to video. The simple, batteries-included API.
 *
 * On Linux with chrome-headless-shell: uses HeadlessExperimental.beginFrame (~2x faster).
 * On macOS or without headless shell: uses Page.captureScreenshot.
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
    onProgress,
  } = options

  if (!duration && !timestamps) {
    throw new Error('Either duration or timestamps must be provided')
  }

  if (!(await checkFfmpeg())) {
    throw new Error('ffmpeg not found. Install it: brew install ffmpeg')
  }

  // Try chrome-headless-shell for beginFrame support (Linux only, ~2x faster)
  const headlessShell = findHeadlessShell()
  const launchOptions = headlessShell
    ? {
        executablePath: headlessShell,
        headless: true as const,
        args: [...BROWSER_ARGS, ...BEGIN_FRAME_ARGS],
      }
    : {
        headless: true as const,
        args: BROWSER_ARGS,
      }

  const ext = format === 'png' ? 'png' : 'jpg'
  const tmpDir = join(tmpdir(), `overcrank-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })

  const browser = await chromium.launch(launchOptions)
  const overallStart = performance.now()

  try {
    const page = await browser.newPage({ viewport: { width, height } })
    page.setDefaultTimeout(60_000)
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    const renderer = await Renderer.create(page)
    renderer.setQuality(quality).setFormat(format)

    // Kick virtual clock
    await renderer.advance(1)

    // Render an initial frame so the page is composited
    if (renderer.usesBeginFrame) {
      await renderer.capture() // prime the compositor
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

    // Capture frames
    const frameEntries: Array<{ path: string; durationS: number }> = []
    // currentMs starts at 1 because we kicked the clock above
    let currentMs = 1

    for (let i = 0; i < captureTimes.length; i++) {
      const targetMs = captureTimes[i]
      const advance = targetMs - currentMs
      if (advance > 0) {
        await renderer.advance(advance)
        currentMs = targetMs
      }

      const frame = await renderer.capture()
      const framePath = join(tmpDir, `frame-${String(i).padStart(6, '0')}.${ext}`)
      await writeFile(framePath, frame.data)

      let durationS: number
      if (i < captureTimes.length - 1) {
        durationS = Math.max(0.001, (captureTimes[i + 1] - captureTimes[i]) / 1000)
      } else {
        durationS = 1 / fps
      }
      frameEntries.push({ path: framePath, durationS })

      onProgress?.(i + 1, captureTimes.length)
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
