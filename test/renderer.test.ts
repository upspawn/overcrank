import { describe, test, expect } from 'bun:test'
import { Renderer, createRenderer } from '../src/renderer'
import { render } from '../src/index'
import { chromium } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from '../src/virtual-clock'
import { existsSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'animation.html')

describe('Renderer class', () => {
  test('captures frames and tracks state', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })

    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
    await page.goto(`file://${FIXTURE_PATH}`)

    const renderer = await Renderer.create(page)

    expect(renderer.frameCount).toBe(0)
    expect(renderer.elapsedMs).toBe(0)

    await renderer.advance(100)
    const frame = await renderer.capture()

    expect(renderer.frameCount).toBe(1)
    expect(renderer.elapsedMs).toBe(100)
    expect(frame.index).toBe(0)
    expect(frame.data[0]).toBe(0xFF) // JPEG magic
    expect(frame.data[1]).toBe(0xD8)

    await renderer.advance(400)
    await renderer.capture()

    expect(renderer.frameCount).toBe(2)
    expect(renderer.elapsedMs).toBe(500)

    await renderer.close()
    await browser.close()
  }, 30_000)

  test('chainable config methods', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })

    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
    await page.goto(`file://${FIXTURE_PATH}`)

    const renderer = await Renderer.create(page)
    const same = renderer.setQuality(90).setFormat('png')
    expect(same).toBe(renderer) // returns this

    await renderer.advance(100)
    const frame = await renderer.capture()

    // PNG magic bytes
    expect(frame.data[0]).toBe(0x89)
    expect(frame.data[1]).toBe(0x50) // 'P'
    expect(frame.data[2]).toBe(0x4E) // 'N'
    expect(frame.data[3]).toBe(0x47) // 'G'

    await renderer.close()
    await browser.close()
  }, 30_000)

  test('onFrame is chainable', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })

    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
    await page.goto(`file://${FIXTURE_PATH}`)

    const frames: number[] = []
    const renderer = await Renderer.create(page)
    renderer
      .onFrame((f) => { frames.push(f.index) })
      .setQuality(50)

    await renderer.advance(100)
    await renderer.capture()
    await renderer.advance(100)
    await renderer.capture()

    expect(frames).toEqual([0, 1])

    await renderer.close()
    await browser.close()
  }, 30_000)
})

describe('createRenderer() backward compat', () => {
  test('captures frames from a page', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })

    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
    await page.goto(`file://${FIXTURE_PATH}`)

    const renderer = await createRenderer(page, { fps: 10 })

    const frames: Buffer[] = []
    renderer.onFrame(async (frame) => {
      frames.push(frame.data)
    })

    for (let i = 0; i < 10; i++) {
      await renderer.advance(100)
      await renderer.capture()
    }

    expect(frames.length).toBe(10)
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
    expect(stats.frames).toBe(21)
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

  test('reports progress', async () => {
    const progress: Array<[number, number]> = []
    await render(`file://${FIXTURE_PATH}`, OUTPUT, {
      duration: 1,
      fps: 5,
      width: 320,
      height: 240,
      x264Preset: 'ultrafast',
      onProgress: (frame, total) => { progress.push([frame, total]) },
    })

    expect(progress.length).toBe(6) // 0ms to 1000ms at 200ms = 6 frames
    expect(progress[0]).toEqual([1, 6])
    expect(progress[progress.length - 1]).toEqual([6, 6])

    await rm(OUTPUT, { force: true })
  }, 60_000)
})
