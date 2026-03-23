/** Minimal page interface — works with Playwright or Puppeteer */
export interface CDPPage {
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>
  context(): { newCDPSession(page: any): Promise<CDPSession> }
}

export interface CDPSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>
  detach(): Promise<void>
}

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
  /** x264 preset (default: 'veryfast') */
  x264Preset?: string
  /** x264 CRF value (default: 23) */
  crf?: number
  /** Timestamps (ms) to capture — overrides duration/fps for variable framerate */
  timestamps?: number[]
}

/** Options for createRenderer() — lower-level control */
export interface RendererOptions {
  fps?: number
  quality?: number
}

/** A single captured frame */
export interface Frame {
  /** Raw JPEG buffer */
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
