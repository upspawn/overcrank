/**
 * beginFrame experiment — runs on Linux where BeginFrameControl works.
 *
 * Uses chrome-headless-shell with --enable-begin-frame-control.
 * beginFrame = force one compositor frame + return screenshot in same call.
 */

import { chromium } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from '../src/virtual-clock'
import { encodeFrames, type FrameEntry } from '../src/encoder'
import { writeFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import http from 'node:http'
import { readFileSync } from 'node:fs'

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

function findHeadlessShell(): string {
  const result = execSync(
    'find /root/.cache/ms-playwright -name "headless_shell" -type f 2>/dev/null || ' +
    'find /root/.cache/ms-playwright -name "chrome-headless-shell" -type f 2>/dev/null',
    { encoding: 'utf-8' },
  )
  return result.trim().split('\n')[0]
}

// --- Method 1: CDP screenshot baseline ---

async function benchCDP(port: number) {
  const outDir = join(tmpdir(), `bf-cdp-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const outputPath = join(outDir, 'output.mp4')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => (window as any).__virtualTime.advance(1))
  await page.waitForTimeout(50)

  const cdp = await page.context().newCDPSession(page)
  const frames: FrameEntry[] = []

  const start = performance.now()
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    await page.evaluate(([ms, step]) => {
      let r = ms; while (r > 0) { const c = Math.min(r, step); (window as any).__virtualTime.advance(c); r -= c }
    }, [INTERVAL_MS, RAF_STEP_MS] as const)

    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true })
    const framePath = join(outDir, `frame-${String(i).padStart(6, '0')}.jpg`)
    await writeFile(framePath, Buffer.from(data as string, 'base64'))
    frames.push({ path: framePath, durationS: INTERVAL_MS / 1000 })
  }
  const captureMs = performance.now() - start

  await encodeFrames(frames, outputPath, { x264Preset: 'ultrafast', crf: 23, fps: FPS })
  await browser.close()
  return { fps: Math.round(TOTAL_FRAMES / captureMs * 1000 * 10) / 10, captureMs: Math.round(captureMs), file: outputPath }
}

// --- Method 2: beginFrame ---

async function benchBeginFrame(port: number) {
  const outDir = join(tmpdir(), `bf-new-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const outputPath = join(outDir, 'output.mp4')

  const browser = await chromium.launch({
    executablePath: findHeadlessShell(),
    headless: true,
    args: [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--enable-begin-frame-control',
      '--run-all-compositor-stages-before-draw',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
    ],
  })

  // Create page via Playwright (for addInitScript to work)
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } })
  const page = await context.newPage()

  // Inject virtual clock BEFORE navigation via addInitScript
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)

  // Get CDP session
  const cdp = await page.context().newCDPSession(page)

  // Navigate
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })

  // Kick virtual clock + render initial frame
  let frameTimeTicks = Date.now() * 1000
  await cdp.send('HeadlessExperimental.beginFrame', { frameTimeTicks })
  frameTimeTicks += 16000

  await page.evaluate(() => (window as any).__virtualTime.advance(1))
  await cdp.send('HeadlessExperimental.beginFrame', { frameTimeTicks })
  frameTimeTicks += 16000

  const frames: FrameEntry[] = []
  let advanceTotal = 0, bfTotal = 0

  const start = performance.now()
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    // Advance virtual time in 16ms steps
    const t1 = performance.now()
    await page.evaluate(([ms, step]) => {
      let r = ms; while (r > 0) { const c = Math.min(r, step); (window as any).__virtualTime.advance(c); r -= c }
    }, [INTERVAL_MS, RAF_STEP_MS] as const)
    advanceTotal += performance.now() - t1

    // beginFrame: composite + screenshot in one CDP call
    frameTimeTicks += INTERVAL_MS * 1000
    const t2 = performance.now()
    const result = await cdp.send('HeadlessExperimental.beginFrame', {
      frameTimeTicks,
      screenshot: { format: 'jpeg', quality: 80 },
    })
    bfTotal += performance.now() - t2

    if (result.screenshotData) {
      const framePath = join(outDir, `frame-${String(i).padStart(6, '0')}.jpg`)
      await writeFile(framePath, Buffer.from(result.screenshotData as string, 'base64'))
      frames.push({ path: framePath, durationS: INTERVAL_MS / 1000 })
    } else {
      // No visual change — reuse previous frame
      if (frames.length > 0) {
        frames.push({ path: frames[frames.length - 1].path, durationS: INTERVAL_MS / 1000 })
      }
    }
  }
  const captureMs = performance.now() - start

  console.log(`    advance avg: ${(advanceTotal / TOTAL_FRAMES).toFixed(1)}ms, beginFrame avg: ${(bfTotal / TOTAL_FRAMES).toFixed(1)}ms`)
  console.log(`    frames with screenshots: ${frames.filter((f, i, a) => i === 0 || f.path !== a[i-1].path).length}/${TOTAL_FRAMES}`)

  if (frames.length > 0) await encodeFrames(frames, outputPath, { x264Preset: 'ultrafast', crf: 23, fps: FPS })
  await browser.close()
  return { fps: Math.round(TOTAL_FRAMES / captureMs * 1000 * 10) / 10, captureMs: Math.round(captureMs), frames: frames.length, file: outputPath }
}

// --- Method 3: beginFrame + Chrome native virtual time (no JS shim) ---

async function benchBeginFrameNative(port: number) {
  const outDir = join(tmpdir(), `bf-native-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const outputPath = join(outDir, 'output.mp4')

  const browser = await chromium.launch({
    executablePath: findHeadlessShell(),
    headless: true,
    args: [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--enable-begin-frame-control',
      '--run-all-compositor-stages-before-draw',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
    ],
  })

  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } })
  const page = await context.newPage()
  // NO virtual clock script — Chrome handles time natively
  const cdp = await page.context().newCDPSession(page)

  // Navigate with real time — page loads normally
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })

  // NOW freeze time — we take control from here
  await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' })

  // Render initial state
  let frameTimeTicks = Date.now() * 1000
  await cdp.send('HeadlessExperimental.beginFrame', { frameTimeTicks })
  frameTimeTicks += 16000

  const frames: FrameEntry[] = []
  let advanceTotal = 0, bfTotal = 0

  const start = performance.now()
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    // Advance Chrome's virtual time — budget consumed synchronously for JS-only work
    const t1 = performance.now()
    await cdp.send('Emulation.setVirtualTimePolicy', {
      policy: 'advance',
      budget: INTERVAL_MS,
    })
    // Re-pause immediately — budget already consumed (no async/network work)
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' })
    advanceTotal += performance.now() - t1

    // beginFrame: composite + screenshot
    frameTimeTicks += INTERVAL_MS * 1000
    const t2 = performance.now()
    const result = await cdp.send('HeadlessExperimental.beginFrame', {
      frameTimeTicks,
      screenshot: { format: 'jpeg', quality: 80 },
    })
    bfTotal += performance.now() - t2

    if (result.screenshotData) {
      const framePath = join(outDir, `frame-${String(i).padStart(6, '0')}.jpg`)
      await writeFile(framePath, Buffer.from(result.screenshotData as string, 'base64'))
      frames.push({ path: framePath, durationS: INTERVAL_MS / 1000 })
    } else {
      if (frames.length > 0) {
        frames.push({ path: frames[frames.length - 1].path, durationS: INTERVAL_MS / 1000 })
      }
    }
  }
  const captureMs = performance.now() - start

  console.log(`    advance avg: ${(advanceTotal / TOTAL_FRAMES).toFixed(1)}ms, beginFrame avg: ${(bfTotal / TOTAL_FRAMES).toFixed(1)}ms`)
  console.log(`    frames with screenshots: ${frames.filter((f, i, a) => i === 0 || f.path !== a[i-1].path).length}/${TOTAL_FRAMES}`)

  if (frames.length > 0) await encodeFrames(frames, outputPath, { x264Preset: 'ultrafast', crf: 23, fps: FPS })
  await browser.close()
  return { fps: Math.round(frames.length / captureMs * 1000 * 10) / 10, captureMs: Math.round(captureMs), frames: frames.length, file: outputPath }
}

// --- Run ---

console.log(`\nbeginFrame Linux Experiment`)
console.log(`${WIDTH}x${HEIGHT}, ${TOTAL_FRAMES} frames (${DURATION_S}s @ ${FPS}fps)\n`)

const srv = await servePage()

interface Result { name: string; fps: number; captureMs: number; frames?: number; file: string }
const results: Result[] = []

for (const method of [
  { name: 'CDP screenshot', fn: () => benchCDP(srv.port) },
  { name: 'beginFrame', fn: () => benchBeginFrame(srv.port) },
  { name: 'beginFrame+native', fn: () => benchBeginFrameNative(srv.port) },
]) {
  process.stdout.write(`  ${method.name.padEnd(22)}`)
  try {
    const r = await method.fn()
    const sz = (await stat(r.file)).size
    results.push({ name: method.name, ...r })
    console.log(`${String(r.fps).padStart(6)} fps   ${(r.captureMs / 1000).toFixed(1)}s   ${(sz/1024).toFixed(0)}KB`)
    console.log(`${''.padEnd(24)}→ ${r.file}`)
  } catch (e: any) {
    console.log(`FAILED: ${e.message.slice(0, 200)}`)
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
