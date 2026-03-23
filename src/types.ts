/**
 * Minimal page interface — accepts Playwright or Puppeteer page objects.
 * Renderer duck-types the CDP session creation automatically.
 */
export interface CDPPage {
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>
  // Playwright: page.context().newCDPSession(page)
  context?: () => { newCDPSession(page: any): Promise<CDPSession> }
  // Puppeteer: page.createCDPSession()
  createCDPSession?: () => Promise<CDPSession>
}

export interface CDPSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>
  detach(): Promise<void>
}

/** Screenshot format */
export type FrameFormat = 'jpeg' | 'png'

/** Capture method — CDP for any page, canvas for canvas-based pages (6x faster) */
export type CaptureMethod = 'cdp' | 'canvas'

/** Options for the high-level render() function */
export interface RenderOptions {
  /** Duration in seconds (for duration mode) */
  duration?: number
  /** Frames per second (default: 30) */
  fps?: number
  /** Viewport width (default: 1920) */
  width?: number
  /** Viewport height (default: 1080) */
  height?: number
  /** JPEG quality 1-100 (default: 80) */
  quality?: number
  /** Screenshot format (default: 'jpeg') */
  format?: FrameFormat
  /** Capture method — 'cdp' for any page, 'canvas' for canvas pages (6x faster) */
  capture?: CaptureMethod
  /** CSS selector for target canvas element (required when capture='canvas'). Default: 'canvas' */
  canvasSelector?: string
  /** x264 preset (default: 'veryfast') */
  x264Preset?: string
  /** x264 CRF value (default: 23) */
  crf?: number
  /** Timestamps (ms) to capture — overrides duration/fps for variable framerate */
  timestamps?: number[]
  /** Number of parallel browser tabs for capture (default: CPU count, max 8) */
  workers?: number
  /** Progress callback */
  onProgress?: (frame: number, total: number) => void
}

/** Options for renderCanvas() — MediaRecorder-based, 22x faster */
export interface RenderCanvasOptions {
  /** Duration in seconds */
  duration: number
  /** Frames per second (default: 30) */
  fps?: number
  /** Viewport width (default: 1920) */
  width?: number
  /** Viewport height (default: 1080) */
  height?: number
  /** CSS selector for target canvas element. Default: 'canvas' */
  canvasSelector?: string
  /** Video bitrate in bps (default: 5_000_000) */
  videoBitrate?: number
}

/** A single captured frame */
export interface Frame {
  /** Raw image buffer (JPEG or PNG) */
  data: Buffer
  /** Virtual timestamp in ms */
  timestamp: number
  /** Frame index (0-based) */
  index: number
}

/** Callback for each captured frame */
export type FrameHandler = (frame: Frame) => void | Promise<void>

/** Stats returned after rendering */
export interface RenderStats {
  frames: number
  durationMs: number
  wallClockMs: number
  speedup: number
}
