/**
 * Experiment: Parallel tab screenshot pipeline.
 *
 * Open N browser tabs, each with the same page + virtual clock.
 * Capture N frames simultaneously — one per tab.
 * The 33ms CDP round-trip happens in parallel across tabs.
 *
 * Run: bun experiments/parallel-tabs.ts
 */

import { chromium, type Page, type CDPSession } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from '../src/virtual-clock'
import http from 'node:http'

const WIDTH = 1280
const HEIGHT = 720
const TOTAL_FRAMES = 300
const INTERVAL_MS = 33

const TEST_PAGE = `<!DOCTYPE html>
<html><head><style>
  body { margin: 0; overflow: hidden; }
  canvas { display: block; }
</style></head><body>
<canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

function draw(t) {
  const time = t / 1000;
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, ${WIDTH}, ${HEIGHT});

  for (let i = 0; i < 50; i++) {
    const x = ${WIDTH}/2 + Math.cos(time * 0.5 + i * 0.3) * (100 + i * 5);
    const y = ${HEIGHT}/2 + Math.sin(time * 0.7 + i * 0.3) * (80 + i * 4);
    const hue = (i * 7 + time * 30) % 360;
    ctx.beginPath();
    ctx.arc(x, y, 4 + Math.sin(time + i) * 2, 0, Math.PI * 2);
    ctx.fillStyle = 'hsl(' + hue + ', 100%, 60%)';
    ctx.fill();
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
</script></body></html>`;

async function servePage(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(TEST_PAGE)
  })
  await new Promise<void>((r) => server.listen(0, r))
  return { port: (server.address() as { port: number }).port, close: () => server.close() }
}

interface Tab {
  page: Page
  cdp: CDPSession
}

async function createTab(browser: any, port: number): Promise<Tab> {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } })
  const page = await context.newPage()
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => (window as any).__virtualTime.advance(1))
  await page.waitForTimeout(50)
  const cdp = await page.context().newCDPSession(page)
  return { page, cdp }
}

// --- Single tab baseline ---

async function benchSingle(port: number): Promise<{ fps: number; totalMs: number }> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  const tab = await createTab(browser, port)

  const start = performance.now()
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    await tab.page.evaluate((ms: number) => (window as any).__virtualTime.advance(ms), INTERVAL_MS)
    await tab.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true })
  }
  const totalMs = performance.now() - start

  await browser.close()
  return { fps: Math.round(TOTAL_FRAMES / totalMs * 1000 * 10) / 10, totalMs: Math.round(totalMs) }
}

// --- Parallel tabs ---

async function benchParallel(port: number, tabCount: number): Promise<{ fps: number; totalMs: number }> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })

  // Create N tabs
  const tabs: Tab[] = []
  for (let i = 0; i < tabCount; i++) {
    tabs.push(await createTab(browser, port))
  }

  const start = performance.now()

  // Process frames in rounds of N
  let framesCaptured = 0
  while (framesCaptured < TOTAL_FRAMES) {
    const batchSize = Math.min(tabCount, TOTAL_FRAMES - framesCaptured)

    // Advance each tab to its target time
    const advancePromises = []
    for (let i = 0; i < batchSize; i++) {
      const targetMs = (framesCaptured + i) * INTERVAL_MS
      // Each tab needs to be at the right virtual time
      // Fast-forward from current position to target
      advancePromises.push(
        tabs[i].page.evaluate((ms: number) => {
          const current = (window as any).__virtualTime.now()
          const advance = ms - current
          if (advance > 0) (window as any).__virtualTime.advance(advance)
        }, targetMs + 1) // +1 because we kicked with advance(1) at setup
      )
    }
    await Promise.all(advancePromises)

    // Capture all tabs in parallel
    const capturePromises = []
    for (let i = 0; i < batchSize; i++) {
      capturePromises.push(
        tabs[i].cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true })
      )
    }
    await Promise.all(capturePromises)

    framesCaptured += batchSize
  }

  const totalMs = performance.now() - start

  await browser.close()
  return { fps: Math.round(TOTAL_FRAMES / totalMs * 1000 * 10) / 10, totalMs: Math.round(totalMs) }
}

// --- Run ---

console.log(`\nParallel Tab Capture Benchmark`)
console.log(`${WIDTH}x${HEIGHT}, ${TOTAL_FRAMES} frames, ${INTERVAL_MS}ms interval\n`)

const srv = await servePage()

const configs = [
  { name: '1 tab (baseline)', tabs: 1, fn: () => benchSingle(srv.port) },
  { name: '2 tabs', tabs: 2, fn: () => benchParallel(srv.port, 2) },
  { name: '4 tabs', tabs: 4, fn: () => benchParallel(srv.port, 4) },
  { name: '8 tabs', tabs: 8, fn: () => benchParallel(srv.port, 8) },
  { name: '16 tabs', tabs: 16, fn: () => benchParallel(srv.port, 16) },
]

const results: Array<{ name: string; fps: number; totalMs: number }> = []

for (const config of configs) {
  process.stdout.write(`  ${config.name.padEnd(20)}`)
  try {
    const result = await config.fn()
    results.push({ name: config.name, ...result })
    console.log(`${String(result.fps).padStart(6)} fps   ${(result.totalMs / 1000).toFixed(1)}s`)
  } catch (e: any) {
    console.log(`FAILED: ${e.message.slice(0, 80)}`)
  }
}

srv.close()

console.log(`\n${'─'.repeat(55)}`)
const baseline = results[0]?.fps || 1
for (const r of results) {
  const speedup = (r.fps / baseline).toFixed(1)
  const bar = '█'.repeat(Math.max(1, Math.round(r.fps / 10)))
  console.log(`  ${r.name.padEnd(20)} ${String(r.fps).padStart(6)} fps  (${speedup}x)  ${bar}`)
}
console.log('─'.repeat(55))
