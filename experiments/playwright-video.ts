/**
 * Experiment: Playwright built-in video recording + virtual time.
 *
 * Instead of CDP screenshots (33ms each), let Chrome's compositor
 * stream frames to a file internally. We just advance virtual time.
 * Then fix timestamps with ffmpeg.
 *
 * Run: bun experiments/playwright-video.ts
 */

import { chromium } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from '../src/virtual-clock'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, rm, stat, rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import http from 'node:http'

const WIDTH = 1280
const HEIGHT = 720
const DURATION_S = 5
const FPS = 30
const TOTAL_FRAMES = DURATION_S * FPS
const INTERVAL_MS = 1000 / FPS

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
  ctx.fillStyle = 'rgba(10, 10, 26, 0.08)';
  ctx.fillRect(0, 0, ${WIDTH}, ${HEIGHT});

  for (let i = 0; i < 50; i++) {
    const x = ${WIDTH}/2 + Math.cos(time * 0.5 + i * 0.3) * (100 + i * 5);
    const y = ${HEIGHT}/2 + Math.sin(time * 0.7 + i * 0.3) * (80 + i * 4);
    const hue = (i * 7 + time * 30) % 360;
    const pulse = Math.sin(time * 2 + i) * 0.5 + 0.5;

    const gradient = ctx.createRadialGradient(x, y, 0, x, y, 12);
    gradient.addColorStop(0, 'hsla(' + hue + ', 100%, 70%, ' + (0.4 + pulse * 0.6) + ')');
    gradient.addColorStop(1, 'hsla(' + hue + ', 100%, 30%, 0)');
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.font = '14px monospace';
  ctx.fillText(time.toFixed(1) + 's', 12, 24);

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

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit ${code}\n${stderr.slice(-300)}`))
    })
    proc.on('error', reject)
  })
}

// --- Method 1: CDP screenshot baseline ---

async function benchCDP(port: number): Promise<{ fps: number; totalMs: number; file: string }> {
  const outDir = join(tmpdir(), `overcrank-cdp-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const outputPath = join(outDir, 'output.mp4')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => (window as any).__virtualTime.advance(1))
  await page.waitForTimeout(50)

  const cdp = await page.context().newCDPSession(page)
  const { writeFile } = await import('node:fs/promises')

  const start = performance.now()

  const concatLines: string[] = []
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    await page.evaluate((ms: number) => (window as any).__virtualTime.advance(ms), INTERVAL_MS)
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true })
    const framePath = join(outDir, `frame-${String(i).padStart(6, '0')}.jpg`)
    await writeFile(framePath, Buffer.from(data as string, 'base64'))
    concatLines.push(`file '${framePath}'`)
    concatLines.push(`duration ${(INTERVAL_MS / 1000).toFixed(6)}`)
  }
  // Repeat last frame
  concatLines.push(`file '${join(outDir, `frame-${String(TOTAL_FRAMES - 1).padStart(6, '0')}.jpg`)}'`)

  const captureMs = performance.now() - start

  const concatPath = join(outDir, 'concat.txt')
  await writeFile(concatPath, concatLines.join('\n'))
  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', String(FPS), outputPath])

  const totalMs = performance.now() - start
  await browser.close()

  return { fps: Math.round(TOTAL_FRAMES / captureMs * 1000 * 10) / 10, totalMs: Math.round(totalMs), file: outputPath }
}

// --- Method 2: Playwright video recording ---

async function benchPlaywrightVideo(port: number): Promise<{ fps: number; totalMs: number; file: string }> {
  const outDir = join(tmpdir(), `overcrank-pvid-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const rawPath = join(outDir, 'raw.webm')
  const outputPath = join(outDir, 'output.mp4')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: outDir, size: { width: WIDTH, height: HEIGHT } },
  })
  const page = await context.newPage()
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => (window as any).__virtualTime.advance(1))
  await page.waitForTimeout(50)

  const start = performance.now()

  // Advance virtual time frame by frame
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    await page.evaluate((ms: number) => (window as any).__virtualTime.advance(ms), INTERVAL_MS)
    // Small yield to let compositor render the frame
    await page.waitForTimeout(1)
  }

  const captureMs = performance.now() - start

  // Close page to finalize the video file
  const videoPath = await page.video()!.path()
  await context.close()

  // Remap timestamps to correct FPS
  await ffmpeg(['-y', '-i', videoPath, '-filter:v', `setpts=N/${FPS}/TB`, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', outputPath])

  const totalMs = performance.now() - start
  await browser.close()

  return { fps: Math.round(TOTAL_FRAMES / captureMs * 1000 * 10) / 10, totalMs: Math.round(totalMs), file: outputPath }
}

// --- Method 3: Playwright video, no yield (maximum speed) ---

async function benchPlaywrightVideoFast(port: number): Promise<{ fps: number; totalMs: number; file: string }> {
  const outDir = join(tmpdir(), `overcrank-pfast-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const outputPath = join(outDir, 'output.mp4')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: outDir, size: { width: WIDTH, height: HEIGHT } },
  })
  const page = await context.newPage()
  await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => (window as any).__virtualTime.advance(1))
  await page.waitForTimeout(50)

  const start = performance.now()

  // Advance all frames in one evaluate — zero IPC per frame
  await page.evaluate((opts: { frames: number; intervalMs: number }) => {
    for (let i = 0; i < opts.frames; i++) {
      ;(window as any).__virtualTime.advance(opts.intervalMs)
    }
  }, { frames: TOTAL_FRAMES, intervalMs: INTERVAL_MS })

  // Give compositor time to flush
  await page.waitForTimeout(500)

  const captureMs = performance.now() - start

  const videoPath = await page.video()!.path()
  await context.close()

  await ffmpeg(['-y', '-i', videoPath, '-filter:v', `setpts=N/${FPS}/TB`, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', outputPath])

  const totalMs = performance.now() - start
  await browser.close()

  return { fps: Math.round(TOTAL_FRAMES / captureMs * 1000 * 10) / 10, totalMs: Math.round(totalMs), file: outputPath }
}

// --- Run ---

console.log(`\nPlaywright Video Recording Experiment`)
console.log(`${WIDTH}x${HEIGHT}, ${TOTAL_FRAMES} frames (${DURATION_S}s @ ${FPS}fps)\n`)

const srv = await servePage()

const methods = [
  { name: 'CDP screenshot', fn: () => benchCDP(srv.port) },
  { name: 'PW video (yield)', fn: () => benchPlaywrightVideo(srv.port) },
  { name: 'PW video (batch)', fn: () => benchPlaywrightVideoFast(srv.port) },
]

for (const method of methods) {
  process.stdout.write(`  ${method.name.padEnd(22)}`)
  try {
    const result = await method.fn()
    const st = await stat(result.file)
    console.log(`${String(result.fps).padStart(6)} fps   ${(result.totalMs / 1000).toFixed(1)}s total   ${(st.size / 1024).toFixed(0)}KB`)
    console.log(`${''.padEnd(24)}→ ${result.file}`)
  } catch (e: any) {
    console.log(`FAILED: ${e.message.slice(0, 100)}`)
  }
}

srv.close()

console.log(`\nOpen the output files to compare visual quality.`)
