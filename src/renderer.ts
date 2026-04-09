/**
 * Core renderer — advance virtual time + capture screenshots.
 *
 * Three capture backends, in descending priority:
 *  1. Canvas (opt-in via setCanvasTarget): canvas.toDataURL inside the page.
 *     Bypasses the compositor entirely — ~5ms/frame on macOS, ~4x faster
 *     than captureScreenshot. Only works if your entire visual output is
 *     drawn into a single canvas (html-in-canvas, Three.js, etc.).
 *  2. beginFrame: HeadlessExperimental.beginFrame (Linux chrome-headless-shell,
 *     ~13ms/frame). Auto-detected on launch.
 *  3. CDP: Page.captureScreenshot (universal, ~5ms/frame with
 *     --disable-frame-rate-limit on macOS; falls back to ~16–33ms without it).
 */

import type { CDPPage, CDPSession, Frame, FrameFormat, FrameHandler } from './types'

/** Step size for virtual time advance — matches browser's native ~60fps RAF rate. */
const RAF_STEP_MS = 16

/** Duck-type Playwright vs Puppeteer CDP session creation. */
async function openCDPSession(page: CDPPage): Promise<CDPSession> {
  if (typeof page.createCDPSession === 'function') {
    return page.createCDPSession()
  }
  if (typeof page.context === 'function') {
    return page.context()!.newCDPSession(page)
  }
  throw new Error(
    'Could not create CDP session. Pass a Playwright or Puppeteer page object.',
  )
}

/**
 * Renderer — controls virtual time and captures screenshots from a browser page.
 *
 * Auto-detects `HeadlessExperimental.beginFrame` support (Linux chrome-headless-shell).
 * When available, capture is ~2x faster (composite + screenshot in one CDP call).
 * Falls back to `Page.captureScreenshot` on macOS or regular Chrome.
 */
/** One-process-wide flag so we don't spam the slow-capture warning. */
let _warnedVsyncPaced = false

export class Renderer {
  private page: CDPPage
  private cdp: CDPSession
  private handlers: FrameHandler[] = []
  private _frameCount = 0
  private _elapsedMs = 0
  private _quality = 80
  private _format: FrameFormat = 'jpeg'
  private _useBeginFrame = false
  private _frameTimeTicks = 0
  private _canvasSelector: string | null = null
  private _canvasExpr: string | null = null
  // First few captureScreenshot durations — used to detect the VSync-paced
  // floor (~16ms) and warn the user to pass LAUNCH_ARGS.
  private _probeMs: number[] = []

  private constructor(page: CDPPage, cdp: CDPSession) {
    this.page = page
    this.cdp = cdp
  }

  /** Create a renderer attached to a Playwright or Puppeteer page. */
  static async create(page: CDPPage): Promise<Renderer> {
    const cdp = await openCDPSession(page)
    const renderer = new Renderer(page, cdp)
    await renderer._detectBeginFrame()
    return renderer
  }

  /** Probe whether beginFrame is available. */
  private async _detectBeginFrame(): Promise<void> {
    try {
      this._frameTimeTicks = Date.now() * 1000
      await this.cdp.send('HeadlessExperimental.beginFrame', {
        frameTimeTicks: this._frameTimeTicks,
      })
      this._frameTimeTicks += 16000
      this._useBeginFrame = true
    } catch {
      this._useBeginFrame = false
    }
  }

  // --- Config (chainable) ---

  /** Set JPEG quality (1-100). Default: 80. */
  setQuality(quality: number): this {
    this._quality = quality
    this._rebuildCanvasExpr()
    return this
  }

  /** Set screenshot format ('jpeg' or 'png'). Default: 'jpeg'. */
  setFormat(format: FrameFormat): this {
    this._format = format
    this._rebuildCanvasExpr()
    return this
  }

  /**
   * Opt into the in-page canvas capture backend.
   *
   * When a selector is set, `capture()` reads pixels via
   * `canvas.toDataURL()` inside the page instead of going through
   * `Page.captureScreenshot`. This skips the compositor entirely — on
   * macOS, capture p50 drops from ~16ms to ~4ms (~4x faster).
   *
   * **Use this when your content is drawn to a `<canvas>` from a
   * `requestAnimationFrame` loop** — Three.js, PixiJS, hand-rolled canvas
   * 2D, etc. Overcrank flushes RAF as part of `advance()`, so by the
   * time `capture()` runs, the canvas backing store is already fresh.
   *
   * **Do NOT use this for html-in-canvas `paint`-event workloads** (with
   * `layoutsubtree` + `drawElementImage`). Those require a real
   * compositor paint to produce fresh element snapshots — which only
   * `Page.captureScreenshot` / `beginFrame` trigger. Stick with the
   * default backend for those pages.
   *
   * Pass `null` to disable and fall back to captureScreenshot / beginFrame.
   *
   * ```ts
   * renderer.setCanvasTarget('#scene')
   * ```
   */
  setCanvasTarget(selector: string | null): this {
    this._canvasSelector = selector
    this._rebuildCanvasExpr()
    return this
  }

  /** Pre-build the in-page capture expression once — avoids per-frame string work. */
  private _rebuildCanvasExpr(): void {
    if (!this._canvasSelector) {
      this._canvasExpr = null
      return
    }
    const sel = JSON.stringify(this._canvasSelector)
    const mime = this._format === 'png' ? "'image/png'" : "'image/jpeg'"
    const qArg = this._format === 'jpeg' ? `,${this._quality / 100}` : ''
    this._canvasExpr = `document.querySelector(${sel}).toDataURL(${mime}${qArg})`
  }

  // --- State ---

  /** Number of frames captured so far. */
  get frameCount(): number {
    return this._frameCount
  }

  /** Total virtual time advanced so far (ms). */
  get elapsedMs(): number {
    return this._elapsedMs
  }

  /** Whether the fast beginFrame backend is active. */
  get usesBeginFrame(): boolean {
    return this._useBeginFrame
  }

  // --- Actions ---

  /**
   * Advance virtual time by the given number of milliseconds.
   * Steps in ~16ms increments (matching browser's native 60fps RAF rate)
   * so accumulated animations (trails, physics) render correctly.
   *
   * Uses raw CDP Runtime.evaluate instead of page.evaluate — the
   * Playwright/Puppeteer abstraction serializes args and installs a
   * binding per call, which costs ~1-2ms we don't need.
   */
  async advance(ms: number): Promise<void> {
    await this.cdp.send('Runtime.evaluate', {
      expression:
        `(()=>{let r=${ms | 0};while(r>0){const c=r<${RAF_STEP_MS}?r:${RAF_STEP_MS};window.__virtualTime.advance(c);r-=c;}})()`,
      returnByValue: false,
      awaitPromise: false,
    })
    this._elapsedMs += ms
  }

  /** Capture a screenshot at the current virtual time. */
  async capture(): Promise<Frame> {
    let buffer: Buffer

    if (this._canvasExpr) {
      // In-page canvas backend — skips the compositor (~5ms on macOS).
      buffer = await this._canvasCapture()
    } else if (this._useBeginFrame) {
      // beginFrame: force composite + screenshot in one CDP call (~13ms)
      this._frameTimeTicks += 16000
      const result = await this.cdp.send('HeadlessExperimental.beginFrame', {
        frameTimeTicks: this._frameTimeTicks,
        screenshot: { format: this._format, quality: this._quality },
      })
      if (result.screenshotData) {
        buffer = Buffer.from(result.screenshotData as string, 'base64')
      } else {
        // No visual change — force a regular screenshot as fallback
        buffer = await this._cdpScreenshot()
      }
    } else {
      // CDP: Page.captureScreenshot
      buffer = await this._cdpScreenshot()
    }

    // Use locally-tracked elapsed time — exact match to __virtualTime.now()
    // because advance() is the only thing that moves the clock. This saves
    // a full CDP round-trip (~2ms) per captured frame.
    const frame: Frame = {
      data: buffer,
      timestamp: this._elapsedMs,
      index: this._frameCount++,
    }

    for (const handler of this.handlers) {
      await handler(frame)
    }

    return frame
  }

  private async _cdpScreenshot(): Promise<Buffer> {
    const params: Record<string, unknown> = {
      format: this._format,
      optimizeForSpeed: true,
    }
    if (this._format === 'jpeg') {
      params.quality = this._quality
    }
    const t0 = performance.now()
    const { data } = await this.cdp.send('Page.captureScreenshot', params)
    this._recordProbe(performance.now() - t0)
    return Buffer.from(data as string, 'base64')
  }

  /**
   * Record the first few captureScreenshot durations to detect VSync-paced
   * capture (the flag footgun). After 5 samples, if the MIN is still
   * ≥ 12ms, every capture — including the fastest — is paced to the 60Hz
   * VSync floor, which strongly implies the browser is missing
   * `--disable-frame-rate-limit`. Using min (not median) avoids false
   * positives from cold-start warmup. Warns once per process.
   */
  private _recordProbe(ms: number): void {
    if (_warnedVsyncPaced || this._probeMs.length >= 5) return
    this._probeMs.push(ms)
    if (this._probeMs.length < 5) return
    const min = Math.min(...this._probeMs)
    if (min >= 12) {
      _warnedVsyncPaced = true
      console.warn(
        `[overcrank] capture min ≈ ${min.toFixed(1)}ms — browser looks VSync-paced. ` +
          `Launch Chromium with overcrank's LAUNCH_ARGS for ~10–20x faster capture:\n` +
          `  import { LAUNCH_ARGS } from 'overcrank'\n` +
          `  chromium.launch({ args: [...LAUNCH_ARGS] })`,
      )
    }
  }

  /**
   * In-page canvas backend — pulls pixels via `canvas.toDataURL()` inside
   * the page. Much faster than captureScreenshot because it reads the
   * canvas backing store directly instead of waiting for a VSync-paced
   * compositor present.
   */
  private async _canvasCapture(): Promise<Buffer> {
    const { result, exceptionDetails } = await this.cdp.send('Runtime.evaluate', {
      expression: this._canvasExpr!,
      returnByValue: true,
      awaitPromise: false,
    })
    if (exceptionDetails) {
      throw new Error(
        `canvas capture failed for selector ${JSON.stringify(this._canvasSelector)}: ` +
          (exceptionDetails.exception?.description ??
            exceptionDetails.text ??
            'canvas.toDataURL() threw'),
      )
    }
    const dataUrl = result.value as string
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      throw new Error(
        `canvas capture: selector ${JSON.stringify(this._canvasSelector)} ` +
          `did not match a <canvas> element`,
      )
    }
    const comma = dataUrl.indexOf(',')
    return Buffer.from(dataUrl.slice(comma + 1), 'base64')
  }

  /** Register a callback for each captured frame. */
  onFrame(handler: FrameHandler): this {
    this.handlers.push(handler)
    return this
  }

  /**
   * Current virtual time in ms.
   * Returns the locally-tracked elapsed time — always equal to
   * `window.__virtualTime.now()` because `advance()` is authoritative.
   * Kept async for API compatibility with earlier versions.
   */
  async currentTime(): Promise<number> {
    return this._elapsedMs
  }

  /** Detach CDP session. */
  async close(): Promise<void> {
    await this.cdp.detach().catch(() => {})
  }
}

/**
 * Create a renderer attached to an existing page.
 * Shorthand for `Renderer.create(page)` — kept for backward compatibility.
 */
export async function createRenderer(
  page: CDPPage,
  options: { fps?: number; quality?: number; format?: FrameFormat } = {},
): Promise<Renderer> {
  const renderer = await Renderer.create(page)
  if (options.quality) renderer.setQuality(options.quality)
  if (options.format) renderer.setFormat(options.format)
  return renderer
}
