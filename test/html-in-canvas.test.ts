/**
 * Experimental: html-in-canvas (WICG drawElementImage API).
 *
 * These tests only run when Chrome Canary is installed. They verify that the
 * virtual clock + capture pipeline work with the new API, which lets us
 * rasterize HTML elements directly into a <canvas> buffer.
 *
 * See src/canary.ts for details.
 */
import { describe, test, expect } from 'bun:test'
import { chromium } from 'playwright'
import { join } from 'node:path'
import {
  Renderer,
  VIRTUAL_CLOCK_SCRIPT,
  findChromeCanary,
  CANARY_DRAW_ELEMENT_ARGS,
  LAUNCH_ARGS,
} from '../src/index'

const FIXTURE = `file://${join(import.meta.dir, 'fixtures', 'html-in-canvas.html')}`
const canaryPath = findChromeCanary()
const describeIfCanary = canaryPath ? describe : describe.skip

describeIfCanary('html-in-canvas (Chrome Canary)', () => {
  test('drawElementImage renders HTML into canvas via paint event', async () => {
    const browser = await chromium.launch({
      executablePath: canaryPath!,
      headless: true,
      args: [...LAUNCH_ARGS, ...CANARY_DRAW_ELEMENT_ARGS],
    })

    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
      await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
      await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => (window as any).__READY === true)

      // Verify the experimental API surface is actually present
      const api = await page.evaluate(() => ({
        hasDrawElementImage: (window as any).__hasDrawElementImage,
        hasLayoutSubtree: (window as any).__hasLayoutSubtree,
      }))
      expect(api.hasDrawElementImage).toBe(true)
      expect(api.hasLayoutSubtree).toBe(true)

      const renderer = await Renderer.create(page)
      renderer.setFormat('png') // easier to spot content via byte size

      // Prime the compositor so an initial children snapshot exists
      await renderer.advance(16)
      await renderer.capture()

      // Advance and capture several frames — each should show a different
      // text label driven by virtual time
      const frames = []
      const texts: string[] = []
      for (let i = 0; i < 5; i++) {
        await renderer.advance(100)
        const frame = await renderer.capture()
        frames.push(frame)
        texts.push(await page.evaluate(() => (window as any).__getCardText()))
      }

      // Each frame is a non-trivial PNG (not blank)
      for (const f of frames) {
        expect(f.data[0]).toBe(0x89) // PNG magic
        expect(f.data.length).toBeGreaterThan(1000)
      }

      // Card text should progress across frames (JS-driven animation captured)
      expect(texts[0]).not.toBe(texts[texts.length - 1])
      expect(texts[texts.length - 1]).toContain('Frame')

      // No drawElementImage errors accumulated during capture
      const errs = await page.evaluate(() => (window as any).__drawErrors ?? 0)
      expect(errs).toBe(0)

      // Virtual clock drove RAF enough times
      const animFrames = await page.evaluate(() => (window as any).__getFrameIdx())
      expect(animFrames).toBeGreaterThan(10)

      await renderer.close()
    } finally {
      await browser.close()
    }
  }, 60_000)

})

const CANVAS_RAF_FIXTURE = `file://${join(import.meta.dir, 'fixtures', 'canvas-raf.html')}`

describe('setCanvasTarget in-page capture backend', () => {
  test('captures fresh pixels every frame for a RAF-drawing canvas', async () => {
    // Works without Canary — this backend uses only stock Chromium APIs.
    const browser = await chromium.launch({ headless: true, args: [...LAUNCH_ARGS] })
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 240 } })
      await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
      await page.goto(CANVAS_RAF_FIXTURE, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => (window as any).__READY === true)

      const renderer = await Renderer.create(page)
      renderer.setQuality(80).setFormat('jpeg').setCanvasTarget('#scene')

      // Prime a RAF tick so the canvas has initial content
      await renderer.advance(16)
      const primeFrame = await renderer.capture()
      expect(primeFrame.data[0]).toBe(0xff) // JPEG SOI
      expect(primeFrame.data[1]).toBe(0xd8)
      expect(primeFrame.data.length).toBeGreaterThan(500)

      // Capture 5 frames with large step so the animation moves visibly
      const midHashes = new Set<number>()
      for (let i = 0; i < 5; i++) {
        await renderer.advance(200)
        const f = await renderer.capture()
        expect(f.data[0]).toBe(0xff)
        expect(f.data[1]).toBe(0xd8)
        const mid = Math.floor(f.data.length / 2)
        let h = 0
        for (let k = 0; k < 256 && mid + k < f.data.length; k++) {
          h = ((h * 31 + f.data[mid + k]!) >>> 0)
        }
        midHashes.add(h)
      }
      // All 5 mid-buffer hashes unique → toDataURL returned fresh pixels
      expect(midHashes.size).toBe(5)

      // Virtual time tracked locally (no roundtrip read)
      expect(renderer.elapsedMs).toBeGreaterThanOrEqual(1000 + 16)

      // Disabling the target falls back to captureScreenshot
      renderer.setCanvasTarget(null)
      await renderer.advance(16)
      const fallback = await renderer.capture()
      expect(fallback.data[0]).toBe(0xff) // JPEG
      expect(fallback.data.length).toBeGreaterThan(500)

      await renderer.close()
    } finally {
      await browser.close()
    }
  }, 60_000)

  test('throws a clear error when selector points at a non-canvas element', async () => {
    const browser = await chromium.launch({ headless: true, args: [...LAUNCH_ARGS] })
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 200 } })
      await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
      await page.goto(CANVAS_RAF_FIXTURE, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => (window as any).__READY === true)

      const renderer = await Renderer.create(page)
      // body exists but is not a canvas — toDataURL is not a function on it
      renderer.setCanvasTarget('body')

      await renderer.advance(16)
      await expect(renderer.capture()).rejects.toThrow()

      await renderer.close()
    } finally {
      await browser.close()
    }
  }, 60_000)
})

// Always run: resolver smoke test — exercise the module on every platform.
describe('canary module', () => {
  test('findChromeCanary returns a path or null without throwing', () => {
    const path = findChromeCanary()
    expect(path === null || typeof path === 'string').toBe(true)
  })

  test('CANARY_DRAW_ELEMENT_ARGS includes the feature flag', () => {
    expect(CANARY_DRAW_ELEMENT_ARGS).toContain('--enable-features=CanvasDrawElement')
  })
})
