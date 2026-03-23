/**
 * Core renderer — advance virtual time + capture CDP screenshots.
 *
 * The page MUST have the virtual clock script injected before navigation.
 * This module doesn't know about ffmpeg, encoding, or rrweb — it just
 * controls time and captures frames.
 */

import type { CDPPage, CDPSession, CaptureMethod, Frame, FrameFormat, FrameHandler } from './types'

const FAST_FORWARD_CHUNK_MS = 500

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
 * ```ts
 * const renderer = await Renderer.create(page)
 * renderer.setFormat('png').setQuality(90)
 *
 * await renderer.advance(1000)
 * const frame = await renderer.capture()
 *
 * console.log(renderer.frameCount)  // 1
 * console.log(renderer.elapsedMs)   // 1000
 * ```
 */
export class Renderer {
  private page: CDPPage
  private cdp: CDPSession
  private handlers: FrameHandler[] = []
  private _frameCount = 0
  private _elapsedMs = 0
  private _quality = 80
  private _format: FrameFormat = 'jpeg'
  private _capture: CaptureMethod = 'cdp'
  private _canvasSelector = 'canvas'

  private constructor(page: CDPPage, cdp: CDPSession) {
    this.page = page
    this.cdp = cdp
  }

  /** Create a renderer attached to a Playwright or Puppeteer page. */
  static async create(page: CDPPage): Promise<Renderer> {
    const cdp = await openCDPSession(page)
    return new Renderer(page, cdp)
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

  /** Set capture method — 'cdp' for any page, 'canvas' for canvas pages (6x faster). */
  setCapture(method: CaptureMethod): this {
    this._capture = method
    return this
  }

  /** Set CSS selector for target canvas element (used with capture='canvas'). Default: 'canvas'. */
  setCanvasSelector(selector: string): this {
    this._canvasSelector = selector
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

  // --- Actions ---

  /** Advance virtual time by the given number of milliseconds. */
  async advance(ms: number): Promise<void> {
    let remaining = ms
    while (remaining > 0) {
      const chunk = Math.min(remaining, FAST_FORWARD_CHUNK_MS)
      await this.page.evaluate(
        (ms: number) => (window as any).__virtualTime.advance(ms),
        chunk,
      )
      remaining -= chunk
    }
    this._elapsedMs += ms
  }

  /** Capture a screenshot at the current virtual time. */
  async capture(): Promise<Frame> {
    let buffer: Buffer

    if (this._capture === 'canvas') {
      // Canvas mode — toDataURL inside the page, 6x faster than CDP
      const dataUrl: string = await this.page.evaluate(
        (opts: { selector: string; format: string; quality: number }) => {
          const canvas = document.querySelector(opts.selector) as HTMLCanvasElement
          if (!canvas) throw new Error(`Canvas not found: ${opts.selector}`)
          return canvas.toDataURL(`image/${opts.format}`, opts.quality / 100)
        },
        { selector: this._canvasSelector, format: this._format, quality: this._quality },
      )
      buffer = Buffer.from(dataUrl.split(',')[1], 'base64')
    } else {
      // CDP mode — works for any page content
      const params: Record<string, unknown> = {
        format: this._format,
        optimizeForSpeed: true,
      }
      if (this._format === 'jpeg') {
        params.quality = this._quality
      }
      const { data } = await this.cdp.send('Page.captureScreenshot', params)
      buffer = Buffer.from(data as string, 'base64')
    }

    const timestamp = await this.page.evaluate(
      () => (window as any).__virtualTime.now(),
    )
    const frame: Frame = {
      data: buffer,
      timestamp,
      index: this._frameCount++,
    }

    for (const handler of this.handlers) {
      await handler(frame)
    }

    return frame
  }

  /** Register a callback for each captured frame. */
  onFrame(handler: FrameHandler): this {
    this.handlers.push(handler)
    return this
  }

  /** Get current virtual time in ms (reads from browser). */
  async currentTime(): Promise<number> {
    return this.page.evaluate(() => (window as any).__virtualTime.now())
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
