/**
 * Core renderer — advance virtual time + capture CDP screenshots.
 *
 * The page MUST have the virtual clock script injected before navigation.
 * This module doesn't know about ffmpeg, encoding, or rrweb — it just
 * controls time and captures frames.
 */

import type { CDPPage, CDPSession, RendererOptions, Frame, FrameHandler } from './types'

const FAST_FORWARD_CHUNK_MS = 500

export interface Renderer {
  /** Advance virtual time by the given number of milliseconds */
  advance(ms: number): Promise<void>
  /** Capture a screenshot at the current virtual time */
  capture(): Promise<Frame>
  /** Register a callback for each captured frame */
  onFrame(handler: FrameHandler): void
  /** Get current virtual time in ms */
  currentTime(): Promise<number>
  /** Clean up CDP session */
  close(): Promise<void>
}

/**
 * Create a renderer attached to an existing page.
 * The page MUST already have the virtual clock script injected via addInitScript.
 */
export async function createRenderer(
  page: CDPPage,
  options: RendererOptions = {},
): Promise<Renderer> {
  const { quality = 80 } = options
  const cdp = await page.context().newCDPSession(page)
  const handlers: FrameHandler[] = []
  let frameIndex = 0

  return {
    async advance(ms: number): Promise<void> {
      let remaining = ms
      while (remaining > 0) {
        const chunk = Math.min(remaining, FAST_FORWARD_CHUNK_MS)
        await page.evaluate((ms: number) => (window as any).__virtualTime.advance(ms), chunk)
        remaining -= chunk
      }
    },

    async capture(): Promise<Frame> {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality,
        optimizeForSpeed: true,
      })
      const buffer = Buffer.from(data as string, 'base64')
      const timestamp = await page.evaluate(() => (window as any).__virtualTime.now())
      const frame: Frame = { data: buffer, timestamp, index: frameIndex++ }

      for (const handler of handlers) {
        await handler(frame)
      }

      return frame
    },

    onFrame(handler: FrameHandler): void {
      handlers.push(handler)
    },

    async currentTime(): Promise<number> {
      return page.evaluate(() => (window as any).__virtualTime.now())
    },

    async close(): Promise<void> {
      await cdp.detach().catch(() => {})
    },
  }
}
