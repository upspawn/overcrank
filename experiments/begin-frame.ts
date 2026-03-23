/**
 * Experiment: HeadlessExperimental.beginFrame with chrome-headless-shell.
 *
 * One CDP call = force compositor render + return screenshot.
 * No separate captureScreenshot needed.
 *
 * Run: bun experiments/begin-frame.ts
 */

import { chromium, type Browser } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from '../src/virtual-clock'
import { encodeFrames, type FrameEntry } from '../src/encoder'
import { writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { readFileSync } from 'node:fs'

const HEADLESS_SHELL = join(
  process.env.HOME!,
  'Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell',
)

const WIDTH = 1280
const HEIGHT = 720
const DURATION_S = 5
const FPS = 30
const TOTAL_FRAMES = DURATION_S * FPS
const INTERVAL_MS = 1000 / FPS
const RAF_STEP_MS = 16

const DEMO_HTML = readFileSync(join(import.meta.dir, '..', 'examples', 'demo.html'), 'utf-8')

async function servePage(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(DEMO_HTML)
  })
  await new Promise<void>((r) => server.listen(0, r))
  return { port: (server.address() as { port: number }).port, close: () => server.close() }
}

// --- Method 1: CDP screenshot baseline (regular chromium) ---

async function benchCDP(port: number): Promise<{ name: string; fps: number; totalMs: number; file: string }> {
  const outDir = join(tmpdir(), `overcrank-bf-cdp-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const outputPath = join(outDir, 'output.mp4')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => (window as any).__virtualTime.advance(1))
  await page.waitForTimeout(50)

  const cdp = await page.context().newCDPSession(page)
  const frames: FrameEntry[] = []

  const start = performance.now()
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    // Advance in 16ms steps
    await page.evaluate(([ms, step]) => {
      let r = ms; while (r > 0) { const c = Math.min(r, step); (window as any).__virtualTime.advance(c); r -= c }
    }, [INTERVAL_MS, RAF_STEP_MS] as const)

    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true })
    const framePath = join(outDir, `frame-${String(i).padStart(6, '0')}.jpg`)
    await writeFile(framePath, Buffer.from(data as string, 'base64'))
    frames.push({ path: framePath, durationS: INTERVAL_MS / 1000 })
  }
  const captureMs = performance.now() - start

  await encodeFrames(frames, outputPath, { x264Preset: 'veryfast', crf: 23, fps: FPS })
  const totalMs = performance.now() - start

  await browser.close()
  return { name: 'CDP screenshot', fps: Math.round(TOTAL_FRAMES / captureMs * 1000 * 10) / 10, totalMs: Math.round(totalMs), file: outputPath }
}

// --- Method 2: beginFrame with chrome-headless-shell ---

async function benchBeginFrame(port: number): Promise<{ name: string; fps: number; totalMs: number; file: string }> {
  const outDir = join(tmpdir(), `overcrank-bf-new-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const outputPath = join(outDir, 'output.mp4')

  // Launch chrome-headless-shell with begin-frame-control
  const browser = await chromium.launch({
    executablePath: HEADLESS_SHELL,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--enable-begin-frame-control',
      '--run-all-compositor-stages-before-draw',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
    ],
  })

  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => (window as any).__virtualTime.advance(1))
  await page.waitForTimeout(50)

  const cdp = await page.context().newCDPSession(page)

  // Enable HeadlessExperimental
  await cdp.send('HeadlessExperimental.enable')

  const frames: FrameEntry[] = []
  let frameTimeTicks = Date.now() * 1000 // microseconds

  const start = performance.now()
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    // Advance virtual time in 16ms steps
    await page.evaluate(([ms, step]) => {
      let r = ms; while (r > 0) { const c = Math.min(r, step); (window as any).__virtualTime.advance(c); r -= c }
    }, [INTERVAL_MS, RAF_STEP_MS] as const)

    // beginFrame: force composite + get screenshot in one call
    frameTimeTicks += INTERVAL_MS * 1000 // advance by frame interval in microseconds
    const result = await cdp.send('HeadlessExperimental.beginFrame', {
      frameTimeTicks,
      screenshot: { format: 'jpeg', quality: 80 },
    })

    if (result.screenshotData) {
      const framePath = join(outDir, `frame-${String(i).padStart(6, '0')}.jpg`)
      await writeFile(framePath, Buffer.from(result.screenshotData as string, 'base64'))
      frames.push({ path: framePath, durationS: INTERVAL_MS / 1000 })
    }
  }
  const captureMs = performance.now() - start

  await encodeFrames(frames, outputPath, { x264Preset: 'veryfast', crf: 23, fps: FPS })
  const totalMs = performance.now() - start

  await browser.close()
  return { name: 'beginFrame', fps: Math.round(TOTAL_FRAMES / captureMs * 1000 * 10) / 10, totalMs: Math.round(totalMs), file: outputPath }
}

// --- Method 3: beginFrame WITHOUT separate advance (advance inside page + beginFrame) ---

async function benchBeginFrameCombined(port: number): Promise<{ name: string; fps: number; totalMs: number; file: string }> {
  const outDir = join(tmpdir(), `overcrank-bf-combo-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const outputPath = join(outDir, 'output.mp4')

  const browser = await chromium.launch({
    executablePath: HEADLESS_SHELL,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--enable-begin-frame-control',
      '--run-all-compositor-stages-before-draw',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
    ],
  })

  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => (window as any).__virtualTime.advance(1))
  await page.waitForTimeout(50)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeadlessExperimental.enable')

  const frames: FrameEntry[] = []
  let frameTimeTicks = Date.now() * 1000

  const start = performance.now()

  // Try: advance + beginFrame pipelined (don't await advance before beginFrame)
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    // Fire advance (don't await yet)
    const advancePromise = page.evaluate(([ms, step]) => {
      let r = ms; while (r > 0) { const c = Math.min(r, step); (window as any).__virtualTime.advance(c); r -= c }
    }, [INTERVAL_MS, RAF_STEP_MS] as const)

    await advancePromise

    frameTimeTicks += INTERVAL_MS * 1000
    const result = await cdp.send('HeadlessExperimental.beginFrame', {
      frameTimeTicks,
      screenshot: { format: 'jpeg', quality: 80 },
    })

    if (result.screenshotData) {
      const framePath = join(outDir, `frame-${String(i).padStart(6, '0')}.jpg`)
      await writeFile(framePath, Buffer.from(result.screenshotData as string, 'base64'))
      frames.push({ path: framePath, durationS: INTERVAL_MS / 1000 })
    }
  }
  const captureMs = performance.now() - start

  await encodeFrames(frames, outputPath, { x264Preset: 'veryfast', crf: 23, fps: FPS })
  const totalMs = performance.now() - start

  await browser.close()
  return { name: 'beginFrame (v2)', fps: Math.round(TOTAL_FRAMES / captureMs * 1000 * 10) / 10, totalMs: Math.round(totalMs), file: outputPath }
}

// --- Run ---

console.log(`\nbeginFrame Experiment`)
console.log(`${WIDTH}x${HEIGHT}, ${TOTAL_FRAMES} frames (${DURATION_S}s @ ${FPS}fps)\n`)

const srv = await servePage()

const methods = [
  { name: 'CDP screenshot', fn: () => benchCDP(srv.port) },
  { name: 'beginFrame', fn: () => benchBeginFrame(srv.port) },
  { name: 'beginFrame v2', fn: () => benchBeginFrameCombined(srv.port) },
]

const results: Array<{ name: string; fps: number; totalMs: number; file: string }> = []

for (const method of methods) {
  process.stdout.write(`  ${method.name.padEnd(22)}`)
  try {
    const result = await method.fn()
    results.push(result)
    console.log(`${String(result.fps).padStart(6)} fps   ${(result.totalMs / 1000).toFixed(1)}s total`)
    console.log(`${''.padEnd(24)}→ ${result.file}`)
  } catch (e: any) {
    console.log(`FAILED: ${e.message.slice(0, 150)}`)
  }
}

srv.close()

console.log(`\n${'─'.repeat(55)}`)
const baseline = results[0]?.fps || 1
for (const r of results) {
  const speedup = (r.fps / baseline).toFixed(1)
  const bar = '█'.repeat(Math.max(1, Math.round(r.fps / 5)))
  console.log(`  ${r.name.padEnd(22)} ${String(r.fps).padStart(6)} fps  (${speedup}x)  ${bar}`)
}
console.log('─'.repeat(55))
console.log('\nOpen the output files to compare visual quality.')
