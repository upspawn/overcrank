/**
 * MediaRecorder-based rendering — 22x faster than CDP screenshots.
 *
 * The browser's native VP8 encoder processes frames entirely in-process.
 * Zero IPC, zero base64, zero round-trips per frame.
 *
 * Outputs WebM (VP8). Convert to MP4 with: ffmpeg -i output.webm -c:v libx264 output.mp4
 *
 * Limitation: only works for canvas-based pages.
 */

import { chromium } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from './virtual-clock'
import type { RenderCanvasOptions, RenderStats } from './types'
import http from 'node:http'
import { writeFile } from 'node:fs/promises'

/**
 * Render a canvas-based web page to video using the browser's native encoder.
 * ~22x faster than CDP screenshots. Outputs WebM (VP8).
 */
export async function renderCanvas(
  url: string,
  outputPath: string,
  options: RenderCanvasOptions,
): Promise<RenderStats> {
  const {
    duration,
    fps = 30,
    width = 1920,
    height = 1080,
    canvasSelector = 'canvas',
    videoBitrate = 5_000_000,
  } = options

  const totalFrames = Math.ceil(duration * fps)
  const intervalMs = 1000 / fps

  // Server to receive the encoded video blob from the browser
  let videoBuffer: Buffer | null = null
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      videoBuffer = Buffer.concat(chunks)
      res.writeHead(200)
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as { port: number }).port

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

    // Kick virtual clock
    await page.evaluate(() => (window as any).__virtualTime.advance(1))
    await page.waitForTimeout(50)

    // Everything happens inside the browser — one round-trip for all frames
    await page.evaluate(async (opts: {
      frames: number; intervalMs: number; port: number;
      selector: string; bitrate: number
    }) => {
      const canvas = document.querySelector(opts.selector) as HTMLCanvasElement
      if (!canvas) throw new Error(`Canvas not found: ${opts.selector}`)

      const stream = canvas.captureStream(0) // 0 = manual frame request
      const recorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp8',
        videoBitsPerSecond: opts.bitrate,
      })

      const chunks: Blob[] = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }

      // Real async yield via MessageChannel — bypasses virtual clock's setTimeout patch
      function realYield(): Promise<void> {
        return new Promise((resolve) => {
          const ch = new MessageChannel()
          ch.port1.onmessage = () => resolve()
          ch.port2.postMessage(null)
        })
      }

      recorder.start(100)

      for (let i = 0; i < opts.frames; i++) {
        ;(window as any).__virtualTime.advance(opts.intervalMs)
        ;(stream.getVideoTracks()[0] as any).requestFrame()
        await realYield()
      }

      recorder.stop()
      await new Promise<void>((resolve) => { recorder.onstop = () => resolve() })

      const blob = new Blob(chunks, { type: 'video/webm' })
      await fetch(`http://127.0.0.1:${opts.port}/upload`, { method: 'POST', body: blob })
    }, {
      frames: totalFrames,
      intervalMs,
      port,
      selector: canvasSelector,
      bitrate: videoBitrate,
    })

    const wallClockMs = performance.now() - overallStart
    const durationMs = totalFrames * intervalMs

    // Write video to disk
    if (videoBuffer) {
      await writeFile(outputPath, videoBuffer)
    }

    return {
      frames: totalFrames,
      durationMs: Math.round(durationMs),
      wallClockMs: Math.round(wallClockMs),
      speedup: durationMs > 0 ? Math.round((durationMs / wallClockMs) * 10) / 10 : 0,
    }
  } finally {
    await browser.close()
    server.close()
  }
}
