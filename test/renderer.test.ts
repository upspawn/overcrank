import { describe, test, expect } from 'bun:test'
import { createRenderer } from '../src/renderer'
import { render } from '../src/index'
import { chromium } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from '../src/virtual-clock'
import { existsSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
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

describe('render() high-level API', () => {
  const OUTPUT = join(import.meta.dir, 'output-test.mp4')

  test('renders a CSS animation to video', async () => {
    const stats = await render(`file://${FIXTURE_PATH}`, OUTPUT, {
      duration: 2,
      fps: 10,
      width: 640,
      height: 480,
      x264Preset: 'ultrafast',
      crf: 28,
    })

    expect(existsSync(OUTPUT)).toBe(true)
    const st = await stat(OUTPUT)
    expect(st.size).toBeGreaterThan(1000)
    expect(stats.frames).toBe(21) // 0ms to 2000ms at 100ms intervals = 21 frames
    expect(stats.speedup).toBeGreaterThan(0)

    await rm(OUTPUT, { force: true })
  }, 60_000)

  test('renders with variable timestamps', async () => {
    const stats = await render(`file://${FIXTURE_PATH}`, OUTPUT, {
      timestamps: [0, 100, 500, 1000, 1500, 2000],
      width: 640,
      height: 480,
      x264Preset: 'ultrafast',
      crf: 28,
    })

    expect(existsSync(OUTPUT)).toBe(true)
    expect(stats.frames).toBe(6)

    await rm(OUTPUT, { force: true })
  }, 60_000)
})
