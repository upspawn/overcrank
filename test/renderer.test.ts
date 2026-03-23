import { describe, test, expect } from 'bun:test'
import { createRenderer } from '../src/renderer'
import { chromium } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from '../src/virtual-clock'
import { join } from 'node:path'

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'animation.html')

describe('renderer', () => {
  test('createRenderer captures frames from a page', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })

    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
    await page.goto(`file://${FIXTURE_PATH}`)

    const renderer = await createRenderer(page, { fps: 10 })

    const frames: Buffer[] = []
    renderer.onFrame(async (frame) => {
      frames.push(frame.data)
    })

    // Advance 1 second (10 frames at 10fps)
    for (let i = 0; i < 10; i++) {
      await renderer.advance(100)
      await renderer.capture()
    }

    expect(frames.length).toBe(10)
    // Each frame should be a valid JPEG (starts with FFD8)
    for (const frame of frames) {
      expect(frame[0]).toBe(0xFF)
      expect(frame[1]).toBe(0xD8)
    }

    await renderer.close()
    await browser.close()
  }, 30_000)

  test('advance moves virtual time correctly', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })

    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
    await page.goto(`file://${FIXTURE_PATH}`)

    const renderer = await createRenderer(page)

    await renderer.advance(500)
    expect(await renderer.currentTime()).toBe(500)

    await renderer.advance(1500)
    expect(await renderer.currentTime()).toBe(2000)

    await renderer.close()
    await browser.close()
  }, 15_000)
})
