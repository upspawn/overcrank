/**
 * Experiment: Can we push beginFrame past 60fps?
 * Tests each flag independently with a per-test timeout.
 */

import { chromium } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from '../src/virtual-clock'
import { execSync } from 'node:child_process'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WIDTH = 1280
const HEIGHT = 720
const FRAMES = 60
const INTERVAL_MS = 33
const RAF_STEP_MS = 16

const DEMO_HTML = readFileSync(join(import.meta.dir, '..', 'examples', 'demo.html'), 'utf-8')

function findHeadlessShell(): string {
  const result = execSync(
    'find /root/.cache/ms-playwright -name "headless_shell" -type f 2>/dev/null || ' +
    'find /root/.cache/ms-playwright -name "chrome-headless-shell" -type f 2>/dev/null',
    { encoding: 'utf-8' },
  )
  return result.trim().split('\n')[0]
}

async function servePage(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(DEMO_HTML)
  })
  await new Promise<void>((r) => server.listen(0, r))
  return { port: (server.address() as { port: number }).port, close: () => server.close() }
}

async function bench(name: string, extraArgs: string[], port: number, screenshotOpts?: Record<string, any>) {
  const headlessShell = findHeadlessShell()

  // Per-test timeout
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 15000))

  const run = async () => {
    const browser = await chromium.launch({
      executablePath: headlessShell,
      headless: true,
      args: [
        '--no-sandbox', '--disable-dev-shm-usage',
        '--enable-begin-frame-control',
        '--run-all-compositor-stages-before-draw',
        '--disable-threaded-animation',
        '--disable-threaded-scrolling',
        ...extraArgs,
      ],
    })

    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
    const cdp = await page.context().newCDPSession(page)
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })

    let ft = Date.now() * 1000
    await cdp.send('HeadlessExperimental.beginFrame', { frameTimeTicks: ft })
    ft += 16000
    await page.evaluate(() => (window as any).__virtualTime.advance(1))
    await cdp.send('HeadlessExperimental.beginFrame', { frameTimeTicks: ft })
    ft += 16000

    const ssOpts = screenshotOpts || { format: 'jpeg', quality: 80 }

    let advTotal = 0, bfTotal = 0
    const start = performance.now()
    for (let i = 0; i < FRAMES; i++) {
      const t1 = performance.now()
      await page.evaluate(([ms, step]) => {
        let r = ms; while (r > 0) { const c = Math.min(r, step); (window as any).__virtualTime.advance(c); r -= c }
      }, [INTERVAL_MS, RAF_STEP_MS] as const)
      advTotal += performance.now() - t1

      ft += INTERVAL_MS * 1000
      const t2 = performance.now()
      await cdp.send('HeadlessExperimental.beginFrame', { frameTimeTicks: ft, screenshot: ssOpts })
      bfTotal += performance.now() - t2
    }
    const totalMs = performance.now() - start
    await browser.close()
    return { fps: Math.round(FRAMES / totalMs * 1000 * 10) / 10, adv: (advTotal / FRAMES).toFixed(1), bf: (bfTotal / FRAMES).toFixed(1) }
  }

  try {
    const result = await Promise.race([run(), timeout]) as any
    console.log(`  ${name.padEnd(40)} ${String(result.fps).padStart(6)} fps  adv=${result.adv}ms  bf=${result.bf}ms`)
  } catch (e: any) {
    console.log(`  ${name.padEnd(40)} FAILED: ${e.message.slice(0, 60)}`)
  }
}

console.log(`\nbeginFrame Turbo Experiment`)
console.log(`${WIDTH}x${HEIGHT}, ${FRAMES} frames\n`)

const srv = await servePage()

await bench('baseline (no extra flags)', [], srv.port)
await bench('--disable-frame-rate-limit', ['--disable-frame-rate-limit'], srv.port)
await bench('--disable-gpu-vsync', ['--disable-gpu-vsync'], srv.port)
await bench('--in-process-gpu', ['--in-process-gpu'], srv.port)
await bench('--disable-gpu', ['--disable-gpu'], srv.port)
await bench('all speed flags', ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--in-process-gpu'], srv.port)
await bench('baseline + q50 jpeg', [], srv.port, { format: 'jpeg', quality: 50 })
await bench('baseline + q30 jpeg', [], srv.port, { format: 'jpeg', quality: 30 })
await bench('baseline + png', [], srv.port, { format: 'png' })

srv.close()
