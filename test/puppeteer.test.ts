import { describe, test, expect } from 'bun:test'
import puppeteer from 'puppeteer'
import { createRenderer } from '../src/renderer'
import { VIRTUAL_CLOCK_SCRIPT } from '../src/virtual-clock'
import { LAUNCH_ARGS } from '../src/index'
import { join } from 'node:path'

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'animation.html')

describe('puppeteer support', () => {
  test('createRenderer works with a Puppeteer page', async () => {
    const browser = await puppeteer.launch({ headless: true, args: [...LAUNCH_ARGS] })
    const page = await browser.newPage()
    await page.setViewport({ width: 640, height: 480 })

    await page.evaluateOnNewDocument(VIRTUAL_CLOCK_SCRIPT)
    await page.goto(`file://${FIXTURE_PATH}`)

    const renderer = await createRenderer(page as any, { fps: 10 })

    const frames: Buffer[] = []
    renderer.onFrame(async (frame) => {
      frames.push(frame.data)
    })

    for (let i = 0; i < 5; i++) {
      await renderer.advance(100)
      await renderer.capture()
    }

    expect(frames.length).toBe(5)
    // Valid JPEGs
    for (const frame of frames) {
      expect(frame[0]).toBe(0xFF)
      expect(frame[1]).toBe(0xD8)
    }

    await renderer.close()
    await browser.close()
  }, 30_000)

  test('virtual time advances correctly via Puppeteer', async () => {
    const browser = await puppeteer.launch({ headless: true, args: [...LAUNCH_ARGS] })
    const page = await browser.newPage()

    await page.evaluateOnNewDocument(VIRTUAL_CLOCK_SCRIPT)
    await page.goto(`file://${FIXTURE_PATH}`)

    const renderer = await createRenderer(page as any)

    await renderer.advance(750)
    expect(await renderer.currentTime()).toBe(750)

    await renderer.close()
    await browser.close()
  }, 15_000)
})
