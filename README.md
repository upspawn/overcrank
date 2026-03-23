# Overcrank

Render any web page to video, faster than real-time.

> In cinema, *overcranking* means running the camera faster than normal — capturing more frames per second — so playback appears in slow motion. Overcrank does the opposite of real-time: it cranks through frames as fast as the CPU allows.

## How it works

Overcrank patches the browser's time APIs (requestAnimationFrame, Date, setTimeout, setInterval, performance.now) with a virtual clock. Instead of waiting for real time to pass, it advances time instantly and captures a screenshot at each frame boundary. Frames are piped to ffmpeg for encoding.

On Linux, overcrank auto-detects `chrome-headless-shell` and uses `HeadlessExperimental.beginFrame` — a single CDP call that forces the compositor to render and returns the screenshot inline. This is **2-3x faster** than standard CDP screenshots.

## Performance

| Platform | Method | Speed | Any HTML? |
|----------|--------|-------|-----------|
| Linux | `beginFrame` + `--disable-frame-rate-limit` | **~78 fps** (5.5ms/frame) | Yes |
| Linux | `beginFrame` (default) | ~60 fps (13ms/frame) | Yes |
| macOS | `Page.captureScreenshot` | ~30 fps (33ms/frame) | Yes |

Combine with lower FPS for faster-than-real-time rendering:

| Output FPS | Linux | macOS |
|------------|-------|-------|
| 30 fps | 2.6x real-time | 1x |
| 10 fps | 7.8x real-time | 3x |
| 5 fps | 15x real-time | 6x |

## Install

```bash
# With Playwright (recommended)
npm install overcrank playwright

# Or with Puppeteer
npm install overcrank puppeteer
```

You also need [ffmpeg](https://ffmpeg.org/) installed:
```bash
brew install ffmpeg    # macOS
apt install ffmpeg     # Linux
```

## Quick start

```typescript
import { render } from 'overcrank'

const stats = await render('https://my-animation.com', 'output.mp4', {
  duration: 10,  // seconds
  fps: 30,
  width: 1920,
  height: 1080,
})

console.log(`${stats.frames} frames, ${stats.speedup}x real-time`)
```

## Advanced: control each frame

Works with both Playwright and Puppeteer — just pass your page object. On Linux with `chrome-headless-shell`, `Renderer.create()` auto-detects and uses `beginFrame` for faster capture.

**Playwright:**
```typescript
import { Renderer, VIRTUAL_CLOCK_SCRIPT } from 'overcrank'
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
await page.goto('https://my-animation.com')

const renderer = await Renderer.create(page)
renderer.setQuality(90).setFormat('jpeg')

console.log(renderer.usesBeginFrame) // true on Linux, false on macOS

renderer.onFrame(async (frame) => {
  // frame.data — JPEG or PNG Buffer
  // frame.timestamp — virtual time in ms
  // frame.index — 0-based frame number
})

for (let t = 0; t < 10_000; t += 33) {
  await renderer.advance(33)
  await renderer.capture()
}

console.log(renderer.frameCount)  // 303
console.log(renderer.elapsedMs)   // 9999

await renderer.close()
await browser.close()
```

**Puppeteer:**
```typescript
import { Renderer, VIRTUAL_CLOCK_SCRIPT } from 'overcrank'
import puppeteer from 'puppeteer'

const browser = await puppeteer.launch()
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1080 })
await page.evaluateOnNewDocument(VIRTUAL_CLOCK_SCRIPT)
await page.goto('https://my-animation.com')

const renderer = await Renderer.create(page)
// same API from here — advance, capture, onFrame, close
```

**Lossless PNG frames:**
```typescript
const renderer = await Renderer.create(page)
renderer.setFormat('png')  // lossless, larger files, slower capture
```

## Variable framerate

Instead of fixed FPS, capture at specific timestamps:

```typescript
import { render } from 'overcrank'

await render('https://my-page.com', 'output.mp4', {
  timestamps: [0, 100, 500, 1000, 2500, 5000, 10000],
  width: 1920,
  height: 1080,
})
```

Overcrank uses ffmpeg's concat demuxer to handle variable-duration frames correctly.

## API

### `render(url, outputPath, options)`

High-level API — opens a browser, renders, encodes, returns stats.

On Linux, auto-discovers `chrome-headless-shell` in Playwright's cache and uses `beginFrame` for ~2-3x faster capture.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `duration` | `number` | — | Duration in seconds (required unless `timestamps` is set) |
| `fps` | `number` | `30` | Frames per second |
| `width` | `number` | `1920` | Viewport width |
| `height` | `number` | `1080` | Viewport height |
| `quality` | `number` | `80` | JPEG quality (1-100) |
| `format` | `'jpeg' \| 'png'` | `'jpeg'` | Screenshot format |
| `x264Preset` | `string` | `'veryfast'` | ffmpeg x264 preset |
| `crf` | `number` | `23` | ffmpeg CRF value |
| `timestamps` | `number[]` | — | Capture at specific ms timestamps (overrides duration/fps) |
| `onProgress` | `(frame, total) => void` | — | Progress callback |

Returns `RenderStats`: `{ frames, durationMs, wallClockMs, speedup }`

### `Renderer`

Low-level class — attach to an existing Playwright/Puppeteer page. Auto-detects `beginFrame` support.

```typescript
const renderer = await Renderer.create(page)
```

**Config (chainable):**
- `renderer.setQuality(n)` — JPEG quality 1-100
- `renderer.setFormat('jpeg' | 'png')` — screenshot format

**Actions:**
- `renderer.advance(ms)` — advance virtual time (steps at 16ms to match 60fps RAF)
- `renderer.capture()` — take a screenshot, returns `Frame`
- `renderer.onFrame(handler)` — callback for each capture (chainable)
- `renderer.currentTime()` — get current virtual time from browser
- `renderer.close()` — detach CDP session

**State:**
- `renderer.frameCount` — number of frames captured
- `renderer.elapsedMs` — total virtual time advanced
- `renderer.usesBeginFrame` — whether the fast backend is active

### `VIRTUAL_CLOCK_SCRIPT`

The raw JavaScript string that patches browser time APIs. Inject via `page.addInitScript()` before navigation.

### `encodeFrames(frames, outputPath, options)`

Encode frame images to MP4 via ffmpeg concat demuxer. Used internally by `render()`, exposed for custom pipelines.

### `checkFfmpeg()`

Returns `true` if ffmpeg is available on the system.

## How the virtual clock works

The virtual clock is a self-contained IIFE injected into the page before any scripts run. It patches:

- `requestAnimationFrame` / `cancelAnimationFrame` — queues callbacks, flushes on advance
- `setTimeout` / `clearTimeout` — tracks timers, fires when virtual time reaches their deadline
- `setInterval` / `clearInterval` — same, with automatic re-scheduling
- `Date` / `Date.now()` — returns virtual time offset from session start
- `performance.now()` — returns virtual time in ms

`window.__virtualTime.advance(ms)` advances the clock and flushes all due timers and RAF callbacks synchronously. This is what makes "faster than real-time" possible — a 5-minute animation completes in seconds because we skip the waiting.

The `advance()` method steps in 16ms increments internally (matching the browser's native 60fps RAF rate) so that accumulated animations — canvas trails, physics simulations, anything that depends on previous frames — render correctly.

## Architecture

```
Your code
  │
  ├── render(url, output, options)     ← high-level: URL → video
  │     ├── Renderer.create(page)      ← auto-detects beginFrame
  │     ├── advance() + capture() loop
  │     └── encodeFrames() → ffmpeg
  │
  └── Renderer.create(page)            ← low-level: frame-by-frame control
        ├── virtual clock (JS IIFE)    ← patches RAF, Date, setTimeout, performance.now
        └── capture backend
              ├── beginFrame           ← Linux: composite + screenshot in 1 call (~5ms)
              └── captureScreenshot    ← macOS: standard CDP (~33ms)
```

## Use cases

- **CSS/Lottie animations → video** — render any web animation to MP4
- **Web presentations → video** — Reveal.js, Slidev slides
- **Canvas/WebGL → video** — Three.js scenes, D3 visualizations
- **Session replay → video** — rrweb recordings (what we built this for)
- **Social media generators** — template pages with dynamic data
- **Visual regression** — deterministic video captures for testing

## License

MIT
