# Changelog

## 0.4.0

### Added
- **`setCanvasTarget(selector)`** — new in-page capture backend that reads pixels from a `<canvas>` via `canvas.toDataURL()`, bypassing the compositor and VSync pacing. Drops capture p50 from ~16ms to ~0.6ms on macOS for canvas-driven scenes. Use for Three.js/PixiJS/canvas-2D content drawn from a RAF loop.
- **`LAUNCH_ARGS`** export — the browser flags overcrank needs for unpaced capture. If you call `Renderer.create(page)` directly, pass these to `chromium.launch({ args: [...LAUNCH_ARGS] })` or `Page.captureScreenshot` is floored at ~16ms/frame by VSync pacing.
- **Runtime VSync-pacing probe** — `Renderer.create()` logs a warning if it detects that capture is VSync-paced, pointing at the missing `--disable-frame-rate-limit` flag.
- **`StreamEncoder`** — fixed-fps `render()` now pipes frames directly to `ffmpeg` stdin via `jpeg_pipe`/`png_pipe`. No tmpdir, no concat demuxer, and exact frame counts (concat demuxer used to repeat the last frame). ~7% wall-clock win on small canvas fixtures. Exposed for custom pipelines.
- **`renderMany(jobs, options)`** — bounded worker pool for batch rendering. Each job is an independent `render()` call with per-job error isolation. Built for workloads like "convert N rrweb session replays to MP4s" where parallelism is *across* recordings, not within one.
- **Experimental HTML-in-canvas support** — works out of the box with Chrome Canary's WICG `drawElementImage()` proposal. New exports: `findChromeCanary()`, `hasHtmlInCanvasSupport()`, `CANARY_DRAW_ELEMENT_ARGS`.

### Changed
- **Reframed CSS `@keyframes` / `transition` as *known-incorrect output*, not just unsupported.** CSS animations without a JS driver run on the Chromium compositor thread, which reads its own `TimeTicks::Now` clock that overcrank's in-page JS patching cannot reach. Result: the video shows the CSS animation progressing at wall-clock speed, desynced from the captured JS clock — animations look frozen or run at the wrong speed. See `README.md` → "Supported workloads" and `experiments/FINDINGS.md` for frame-by-frame evidence. `experiments/notes-virtualtimepolicy.md` has the full research write-up on why `Emulation.setVirtualTimePolicy` isn't a drop-in fix.

### Performance
- Capture p50 on M-series Mac, JPEG q80, pure-RAF canvas fixture:

  | Backend | 400×240 | 1920×1080 |
  |---|---|---|
  | `setCanvasTarget` | ~0.6ms | ~0.6ms |
  | `Page.captureScreenshot` (with `LAUNCH_ARGS`) | ~0.9ms | ~6.0ms |
  | Same, without `--disable-frame-rate-limit` | ~8ms | ~16ms |

  At `step=500ms`, canvas-target hits ~590× real-time; `captureScreenshot` at 1920×1080 hits ~77×.

## 0.3.0

- `HeadlessExperimental.beginFrame` fast backend — auto-detected on Linux with `chrome-headless-shell`, ~2-3x faster capture than `Page.captureScreenshot`.
- `advance()` now steps virtual time in 16ms increments to match the browser's native 60fps RAF rate, fixing accumulated-animation bugs (trails, physics).
- `--disable-frame-rate-limit` added to beginFrame launch args.

## 0.2.1

- Renamed `virtual-clock.js` → `virtual-clock.iife.js` to avoid Bun module-resolution conflicts.
