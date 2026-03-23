# Overcrank

Render any web page to video, faster than real-time.

> In cinema, *overcranking* means running the camera faster than normal — capturing more frames per second — so playback appears in slow motion. Overcrank does the opposite of real-time: it cranks through frames as fast as the CPU allows.

## How it works

Overcrank patches the browser's time APIs (requestAnimationFrame, Date, setTimeout, setInterval, performance.now) with a virtual clock. Instead of waiting for real time to pass, it advances time instantly and captures a CDP screenshot at each frame boundary. Frames are piped to ffmpeg for encoding.

This means a 5-minute animation renders in seconds, not minutes.

## Install

```bash
npm install overcrank playwright
# or
bun add overcrank playwright
```

You also need [ffmpeg](https://ffmpeg.org/) installed:
```bash
brew install ffmpeg    # macOS
apt install ffmpeg     # Linux
```

## Quick start

```typescript
import { render } from 'overcrank'

await render('https://my-animation.com', 'output.mp4', {
  duration: 10,  // seconds
  fps: 30,
  width: 1920,
  height: 1080,
})
```

## Advanced: control each frame

```typescript
import { createRenderer, VIRTUAL_CLOCK_SCRIPT } from 'overcrank'
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })

// Inject virtual clock before navigation
await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
await page.goto('https://my-animation.com')

const renderer = await createRenderer(page)

renderer.onFrame(async (frame) => {
  // frame.data is a JPEG Buffer
  // frame.timestamp is the virtual time in ms
  // frame.index is the 0-based frame number
})

// Advance time and capture at your own pace
for (let t = 0; t < 10_000; t += 33) {
  await renderer.advance(33)
  await renderer.capture()
}

await renderer.close()
await browser.close()
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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `duration` | `number` | — | Duration in seconds (required unless `timestamps` is set) |
| `fps` | `number` | `30` | Frames per second |
| `width` | `number` | `1920` | Viewport width |
| `height` | `number` | `1080` | Viewport height |
| `quality` | `number` | `80` | JPEG quality (1-100) |
| `x264Preset` | `string` | `'veryfast'` | ffmpeg x264 preset |
| `crf` | `number` | `23` | ffmpeg CRF value |
| `timestamps` | `number[]` | — | Capture at specific ms timestamps (overrides duration/fps) |

Returns `RenderStats`: `{ frames, durationMs, wallClockMs, speedup }`

### `createRenderer(page, options)`

Low-level API — attach to an existing Playwright/Puppeteer page.

- `renderer.advance(ms)` — advance virtual time
- `renderer.capture()` — take a screenshot, returns `Frame`
- `renderer.onFrame(handler)` — callback for each capture
- `renderer.currentTime()` — get current virtual time
- `renderer.close()` — detach CDP session

### `VIRTUAL_CLOCK_SCRIPT`

The raw JavaScript string that patches browser time APIs. Inject via `page.addInitScript()` before navigation.

### `encodeFrames(frames, outputPath, options)`

Encode frame images to MP4 via ffmpeg concat demuxer. Used internally by `render()`, exposed for custom pipelines.

### `checkFfmpeg()`

Returns `true` if ffmpeg is available on the system.

## Use cases

- **CSS/Lottie animations → video** — render any web animation to MP4
- **Web presentations → video** — Reveal.js, Slidev slides
- **Canvas/WebGL → video** — Three.js scenes, D3 visualizations
- **Session replay → video** — rrweb recordings (what we built this for)
- **Social media generators** — template pages with dynamic data
- **Visual regression** — deterministic video captures for testing

## License

MIT
