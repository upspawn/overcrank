/**
 * Core renderer — advance virtual time + capture screenshots.
 *
 * Two capture backends:
 * - CDP: Page.captureScreenshot (works everywhere, ~33ms/frame)
 * - beginFrame: HeadlessExperimental.beginFrame (Linux chrome-headless-shell, ~13ms/frame)
 *
 * The renderer auto-detects beginFrame support and uses it when available.
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
    return this
  }

  /** Set screenshot format ('jpeg' or 'png'). Default: 'jpeg'. */
  setFormat(format: FrameFormat): this {
    this._format = format
    return this
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

    if (this._useBeginFrame) {
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
    const { data } = await this.cdp.send('Page.captureScreenshot', params)
    return Buffer.from(data as string, 'base64')
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
