/**
 * Experiment: Compare frame capture methods.
 *
 * 1. CDP screenshot — Page.captureScreenshot over CDP WebSocket
 * 2. Canvas toDataURL — per-frame evaluate, returns base64
 * 3. Batch in-page — advance + capture ALL frames in one evaluate call
 * 4. Canvas toBlob + POST — browser encodes JPEG blob, POSTs to local server
 * 5. MediaRecorder — browser encodes video natively (VP8)
 *
 * Run: bun experiments/capture-methods.ts
 */

import { chromium, type Page, type Browser } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from '../src/virtual-clock'
import http from 'node:http'

const WIDTH = 1280
const HEIGHT = 720
const FRAMES = 100
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

interface BenchResult {
  name: string
  totalMs: number
  avgFrameMs: number
  fps: number
  totalBytes: number
}

/** Server that serves the test page AND receives frame uploads on /upload */
async function createServer(): Promise<{ port: number; close: () => void; receivedBytes: number; receivedChunks: Buffer[] }> {
  const state = { receivedBytes: 0, receivedChunks: [] as Buffer[] }
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.url === '/upload' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const buf = Buffer.concat(chunks)
        state.receivedBytes += buf.length
        state.receivedChunks.push(buf)
        res.writeHead(200)
        res.end()
      })
      return
    }

    // Serve test page
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(TEST_PAGE)
  })
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as { port: number }).port
  return { port, close: () => server.close(), get receivedBytes() { return state.receivedBytes }, get receivedChunks() { return state.receivedChunks } }
}

async function setup(port: number): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => (window as any).__virtualTime.advance(1))
  await page.waitForTimeout(50)
  return { browser, page }
}

// --- Method 1: CDP Screenshot (baseline) ---

async function benchCDP(): Promise<BenchResult> {
  const srv = await createServer()
  const { browser, page } = await setup(srv.port)
  const cdp = await page.context().newCDPSession(page)
  let totalBytes = 0

  const start = performance.now()
  for (let i = 0; i < FRAMES; i++) {
    await page.evaluate((ms: number) => (window as any).__virtualTime.advance(ms), INTERVAL_MS)
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 80, optimizeForSpeed: true,
    })
    totalBytes += Buffer.from(data as string, 'base64').length
  }
  const totalMs = performance.now() - start

  await browser.close()
  srv.close()
  return { name: 'CDP screenshot', totalMs: Math.round(totalMs), avgFrameMs: Math.round(totalMs / FRAMES * 100) / 100, fps: Math.round(FRAMES / totalMs * 1000 * 10) / 10, totalBytes }
}

// --- Method 2: Canvas toDataURL (per-frame evaluate) ---

async function benchCanvasDataURL(): Promise<BenchResult> {
  const srv = await createServer()
  const { browser, page } = await setup(srv.port)
  let totalBytes = 0

  const start = performance.now()
  for (let i = 0; i < FRAMES; i++) {
    const dataUrl: string = await page.evaluate((ms: number) => {
      ;(window as any).__virtualTime.advance(ms)
      return document.getElementById('c')!.toDataURL('image/jpeg', 0.8)
    }, INTERVAL_MS)
    totalBytes += Buffer.from(dataUrl.split(',')[1], 'base64').length
  }
  const totalMs = performance.now() - start

  await browser.close()
  srv.close()
  return { name: 'Canvas toDataURL', totalMs: Math.round(totalMs), avgFrameMs: Math.round(totalMs / FRAMES * 100) / 100, fps: Math.round(FRAMES / totalMs * 1000 * 10) / 10, totalBytes }
}

// --- Method 3: Batch in-page (one round-trip for all frames) ---

async function benchBatch(): Promise<BenchResult> {
  const srv = await createServer()
  const { browser, page } = await setup(srv.port)
  let totalBytes = 0

  const start = performance.now()

  const results: string[] = await page.evaluate((opts: { frames: number; intervalMs: number }) => {
    const canvas = document.getElementById('c') as HTMLCanvasElement
    const frames: string[] = []
    for (let i = 0; i < opts.frames; i++) {
      ;(window as any).__virtualTime.advance(opts.intervalMs)
      frames.push(canvas.toDataURL('image/jpeg', 0.8))
    }
    return frames
  }, { frames: FRAMES, intervalMs: INTERVAL_MS })

  for (const dataUrl of results) {
    totalBytes += Buffer.from(dataUrl.split(',')[1], 'base64').length
  }

  const totalMs = performance.now() - start

  await browser.close()
  srv.close()
  return { name: 'Batch in-page (1 RT)', totalMs: Math.round(totalMs), avgFrameMs: Math.round(totalMs / FRAMES * 100) / 100, fps: Math.round(FRAMES / totalMs * 1000 * 10) / 10, totalBytes }
}

// --- Method 4: Canvas toBlob + POST to server ---

async function benchToBlob(): Promise<BenchResult> {
  const srv = await createServer()
  const { browser, page } = await setup(srv.port)

  const start = performance.now()

  // toBlob is async, so we need the REAL setTimeout for the promise.
  // Our virtual clock patches it, but we saved the original.
  // Use a MessageChannel trick instead — postMessage is not patched.
  for (let i = 0; i < FRAMES; i++) {
    await page.evaluate(async (opts: { ms: number; port: number }) => {
      ;(window as any).__virtualTime.advance(opts.ms)
      const canvas = document.getElementById('c') as HTMLCanvasElement
      const blob: Blob = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.8)
      })
      await fetch(`http://127.0.0.1:${opts.port}/upload`, { method: 'POST', body: blob })
    }, { ms: INTERVAL_MS, port: srv.port })
  }

  const totalMs = performance.now() - start

  await browser.close()
  const totalBytes = srv.receivedBytes
  srv.close()
  return { name: 'Canvas toBlob+POST', totalMs: Math.round(totalMs), avgFrameMs: Math.round(totalMs / FRAMES * 100) / 100, fps: Math.round(FRAMES / totalMs * 1000 * 10) / 10, totalBytes }
}

// --- Method 5: MediaRecorder ---

async function benchMediaRecorder(): Promise<BenchResult> {
  const srv = await createServer()
  const { browser, page } = await setup(srv.port)

  const start = performance.now()

  // All work happens inside the page. Use MessageChannel for real async yields
  // since setTimeout is patched by virtual clock.
  await page.evaluate(async (opts: { frames: number; intervalMs: number; port: number }) => {
    const canvas = document.getElementById('c') as HTMLCanvasElement
    const stream = canvas.captureStream(0) // 0 = manual frame request
    const recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp8',
      videoBitsPerSecond: 5_000_000,
    })

    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }

    // Real async yield — MessageChannel bypasses virtual clock
    function realYield(): Promise<void> {
      return new Promise((resolve) => {
        const ch = new MessageChannel()
        ch.port1.onmessage = () => resolve()
        ch.port2.postMessage(null)
      })
    }

    recorder.start(100) // request data every 100ms

    for (let i = 0; i < opts.frames; i++) {
      ;(window as any).__virtualTime.advance(opts.intervalMs)
      ;(stream.getVideoTracks()[0] as any).requestFrame()
      // Yield to let recorder process — must use real async, not patched setTimeout
      await realYield()
    }

    recorder.stop()
    await new Promise<void>((resolve) => { recorder.onstop = () => resolve() })

    const blob = new Blob(chunks, { type: 'video/webm' })
    await fetch(`http://127.0.0.1:${opts.port}/upload`, { method: 'POST', body: blob })
  }, { frames: FRAMES, intervalMs: INTERVAL_MS, port: srv.port })

  const totalMs = performance.now() - start

  await browser.close()
  const totalBytes = srv.receivedBytes
  srv.close()
  return { name: 'MediaRecorder (VP8)', totalMs: Math.round(totalMs), avgFrameMs: Math.round(totalMs / FRAMES * 100) / 100, fps: Math.round(FRAMES / totalMs * 1000 * 10) / 10, totalBytes }
}

// --- Run all ---

console.log(`\nOvercrank Capture Method Benchmark`)
console.log(`${WIDTH}x${HEIGHT}, ${FRAMES} frames, ${INTERVAL_MS}ms interval\n`)

const methods = [
  { name: 'CDP screenshot', fn: benchCDP },
  { name: 'Canvas toDataURL', fn: benchCanvasDataURL },
  { name: 'Batch in-page', fn: benchBatch },
  { name: 'Canvas toBlob+POST', fn: benchToBlob },
  { name: 'MediaRecorder', fn: benchMediaRecorder },
]

const results: BenchResult[] = []

for (const method of methods) {
  process.stdout.write(`  ${method.name.padEnd(22)}`)
  try {
    const result = await method.fn()
    results.push(result)
    console.log(`${String(result.fps).padStart(6)} fps   ${String(result.avgFrameMs).padStart(6)}ms/f   ${(result.totalBytes / 1024).toFixed(0)}KB`)
  } catch (e: any) {
    console.log(`FAILED: ${e.message.slice(0, 100)}`)
  }
}

console.log(`\n${'─'.repeat(65)}`)
const baseline = results[0]?.fps || 1
for (const r of results) {
  const speedup = (r.fps / baseline).toFixed(1)
  const bar = '█'.repeat(Math.max(1, Math.round(r.fps / 20)))
  console.log(`  ${r.name.padEnd(22)} ${String(r.fps).padStart(6)} fps  (${speedup}x)  ${bar}`)
}
console.log('─'.repeat(65))
