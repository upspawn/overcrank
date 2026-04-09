/**
 * Overcrank — render any web page to video, faster than real-time.
 *
 * In cinema, overcranking = running the camera faster than normal.
 * We crank through frames as fast as the CPU allows.
 */

import { chromium } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from './virtual-clock'
import { Renderer, createRenderer } from './renderer'
import { encodeFrames, checkFfmpeg, stitchSegments, StreamEncoder } from './encoder'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import type {
  RenderOptions, RenderStats, RenderJob, RenderJobResult, RenderManyOptions,
} from './types'

export { Renderer, createRenderer } from './renderer'
export { VIRTUAL_CLOCK_SCRIPT } from './virtual-clock'
export { checkFfmpeg, encodeFrames, stitchSegments, StreamEncoder } from './encoder'
export {
  findChromeCanary,
  hasHtmlInCanvasSupport,
  CANARY_DRAW_ELEMENT_ARGS,
} from './canary'
export type {
  RenderOptions, RenderStats, Frame, FrameHandler,
  FrameFormat, CDPPage, CDPSession,
  RenderJob, RenderJobResult, RenderManyOptions,
} from './types'

/**
 * Browser launch args overcrank needs for maximum capture speed.
 *
 * **If you call `Renderer.create(page)` directly, you MUST pass these to
 * `chromium.launch({ args: [...LAUNCH_ARGS] })`** — otherwise
 * `Page.captureScreenshot` is paced to the 60Hz VSync cadence and capture
 * runs at ~16ms/frame instead of ~1–6ms/frame (a ~10–20x difference at
 * 1920×1080 on macOS).
 *
 * The high-level `render()` API passes these for you automatically.
 */
export const LAUNCH_ARGS: readonly string[] = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--disable-software-rasterizer',
  '--force-device-scale-factor=1',
  // Unpaces captureScreenshot from the 60Hz VSync cadence. Without this
  // flag, capture p50 floors at ~16ms on macOS regardless of viewport size;
  // with it, we run at the true GPU/encode cost (~1ms at 400×240,
  // ~6ms at 1920×1080). Universally safe — we never want to wait for a real
  // display refresh in headless rendering.
  '--disable-frame-rate-limit',
]

const BROWSER_ARGS = LAUNCH_ARGS

const BEGIN_FRAME_ARGS = [
  '--enable-begin-frame-control',
  '--run-all-compositor-stages-before-draw',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
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
        args: [...BROWSER_ARGS],
      }

  // Fixed-fps mode pipes frames directly to ffmpeg stdin — no tmpdir.
  // Variable-timestamps mode still needs the concat demuxer for variable
  // per-frame durations, so it keeps the file-based path.
  const useStreamingEncoder = !timestamps
  const ext = format === 'png' ? 'png' : 'jpg'
  const tmpDir = useStreamingEncoder
    ? null
    : join(tmpdir(), `overcrank-${Date.now()}`)
  if (tmpDir) await mkdir(tmpDir, { recursive: true })

  const browser = await chromium.launch(launchOptions)
  const overallStart = performance.now()

  let encoder: StreamEncoder | null = null

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

    if (useStreamingEncoder) {
      encoder = new StreamEncoder(outputPath, { fps, format, x264Preset, crf })
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

      if (encoder) {
        await encoder.writeFrame(frame.data)
      } else {
        const framePath = join(tmpDir!, `frame-${String(i).padStart(6, '0')}.${ext}`)
        await writeFile(framePath, frame.data)
        let durationS: number
        if (i < captureTimes.length - 1) {
          durationS = Math.max(0.001, (captureTimes[i + 1] - captureTimes[i]) / 1000)
        } else {
          durationS = 1 / fps
        }
        frameEntries.push({ path: framePath, durationS })
      }

      onProgress?.(i + 1, captureTimes.length)
    }

    await renderer.close()

    // Encode to video
    if (encoder) {
      await encoder.finish()
      encoder = null
    } else {
      await encodeFrames(frameEntries, outputPath, { x264Preset, crf, fps })
    }

    const wallClockMs = performance.now() - overallStart
    const durationMs = captureTimes[captureTimes.length - 1] - captureTimes[0]

    return {
      frames: captureTimes.length,
      durationMs,
      wallClockMs: Math.round(wallClockMs),
      speedup: durationMs > 0 ? Math.round((durationMs / wallClockMs) * 10) / 10 : 0,
    }
  } finally {
    if (encoder) encoder.kill()
    await browser.close()
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Render many pages to video concurrently with a bounded worker pool.
 *
 * Each job is an independent `render()` call — there's no timeline splitting
 * or shared state between jobs. This is the right primitive for batch
 * workloads like "convert 50 rrweb sessions to MP4s" where the parallelism
 * is *across* recordings, not within one.
 *
 * Errors from individual jobs are isolated: one failing job does not affect
 * the others. Each result carries either `{ ok: true, stats }` or
 * `{ ok: false, error }`.
 *
 * Default concurrency is 4. Don't set it higher than your physical core
 * count — each worker launches a full headless Chromium.
 */
export async function renderMany(
  jobs: RenderJob[],
  options: RenderManyOptions = {},
): Promise<RenderJobResult[]> {
  const { concurrency = 4, onJobComplete } = options
  if (concurrency < 1) throw new Error('concurrency must be >= 1')
  if (jobs.length === 0) return []

  const results: RenderJobResult[] = new Array(jobs.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++
      if (i >= jobs.length) return
      const job = jobs[i]
      let result: RenderJobResult
      try {
        const stats = await render(job.url, job.output, job.options ?? {})
        result = { index: i, job, ok: true, stats }
      } catch (err) {
        result = {
          index: i,
          job,
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        }
      }
      results[i] = result
      onJobComplete?.(result)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, worker)
  await Promise.all(workers)
  return results
}
