# Overcrank perf investigation — findings log

Running log of what we tried, what worked, and what didn't. Dated entries
below. Most benchmarks ran on macOS (darwin 25.3.0) with Chrome Canary
and stock Playwright Chromium, 800×600 or smaller viewports, JPEG q80
with `optimizeForSpeed: true`.

---

## 2026-04-09 — Tier 1: flag set + CDP path cleanup

### Starting point

Original bench (first run of `bench-flags.mjs` on macOS, `step=500ms`):

- **2.37x** speedup end-to-end on `test-animation.html` (Canary,
  html-in-canvas fixture).
- Capture p50 ~33ms, min ~25ms.
- Flags inherited from Linux `beginFrame` tuning:
  `--deterministic-mode`, `--run-all-compositor-stages-before-draw`,
  `--disable-new-content-rendering-timeout`, `--disable-threaded-animation`,
  `--disable-threaded-scrolling`, `--disable-checker-imaging`,
  `--disable-image-animation-resync`.

### Flag sweep (`bench-flags.mjs`)

Stripped flags one-by-one and tried new ones:

| Config | cap p50 | speedup |
|---|---|---|
| CURRENT (old beginFrame-tuned) | ~25ms | **20.17x** |
| MINIMAL (`--headless=new --disable-gpu` only) | ~20ms | ~24x |
| CURRENT − `--run-all-compositor-stages-before-draw` | ~15ms | ~32x |
| **MINIMAL + `--disable-frame-rate-limit`** | **16.4ms** (min 5.1ms) | **40.37x** |

Key finding: **`--run-all-compositor-stages-before-draw` was actively
harmful on macOS.** It was only useful for the Linux `beginFrame`
backend — on the macOS `captureScreenshot` path it forces the
compositor to stall on every stage, adding ~10ms per frame.

`--disable-frame-rate-limit` unpaces `Page.captureScreenshot` from the
60Hz VSync cadence. Without it, capture is bound to ~16.7ms (one
VSync period) even when the GPU is idle. With it, capture can
occasionally hit its true floor of ~5ms, though p50 still floats up
to ~16ms on the raw CDP path (unclear why — maybe CoreAnimation
flushes on a slower cadence).

### Step size sweep (`bench-push.mjs`)

At optimal flags + `step=500ms`, capture p50 stays ~16.5ms regardless
of step size (confirming the per-frame cost is bounded, not amortized
over step size). Speedup scales linearly with step:

| step | cap p50 | speedup |
|---|---|---|
| 16ms (60fps) | 16.2 | 1.32x |
| 33ms (30fps) | 16.4 | 2.30x |
| 100ms (10fps) | 5.5 | 9.26x |
| 500ms (2fps) | 16.5 | 35.19x |
| 1000ms (1fps) | 16.6 | 63.81x |
| 2000ms (0.5fps) | 16.6 | **133.07x** |

So the **practical speedup is determined by your output FPS**:
bigger advances = more virtual time per wall frame = higher speedup.

### Pipeline overlap

Firing `advance(N+1)` while `capture(N)` is still in flight gave
**+5.5%** (40.01x → 42.34x at step=500ms). Not enough to justify the
complexity — CDP `Runtime.evaluate` and `Page.captureScreenshot` are
both serialized through the same devtools session so real overlap is
limited. **Skipped integrating it.**

### Parallel tabs

Tried `Target.createTarget` to get N independent page sessions and
render in parallel via `Promise.all`. **Hung silently** at N=2 tabs —
likely a race around the fresh tab's websocket handshake vs the
previous tab's close. Not debugging further for now; single-tab is
already fast enough that multi-tab parallelism is marginal.

### Renderer-level cleanups (committed in Tier 1)

Three additional wins that stack with the flag change:

1. **Kill the per-capture `Runtime.evaluate` for timestamp.** The
   renderer was reading `window.__virtualTime.now()` after every
   capture just to populate `Frame.timestamp`. Since `advance()` is the
   only thing that moves the clock, the locally-tracked `_elapsedMs`
   is always identical. Saves ~2ms/frame and one CDP round-trip.
2. **Move `advance()` from `page.evaluate` to raw `cdp.send(
   'Runtime.evaluate')`.** Playwright/Puppeteer's `page.evaluate`
   serializes args and installs a temporary binding per call. Raw CDP
   with a templated `(()=>{...})()` expression is ~3–4x cheaper. Now
   `advance()` p50 is **0.30ms** (vs ~2ms previously).
3. **Pre-build the expression.** `RAF_STEP_MS` is a compile-time
   constant so we bake the inner loop right into the expression
   instead of passing it as an argument.

### Tier 1 result

End-to-end bench on the Canary `test-animation.html` (html-in-canvas,
`step=500ms`, 60 frames + 10 warmup, 800×600 JPEG q80):

```
before (v0.3.0):    ~20x   (old flags, page.evaluate, timestamp roundtrip)
after  (Tier 1):     90x   (adv p50 0.39ms, cap p50 5.11ms)
```

That's a **4.5x** improvement over the prior ceiling, and Tier 1
applies universally — every macOS user benefits with zero API changes.

Frame diff sanity check (`bench-verify.mjs`): 5/5 unique captures on
the html-in-canvas workload — compositor really is re-drawing each
frame, not returning cached pixels.

Surprise finding: **Canary's captureScreenshot is ~3x faster than
stock Playwright Chromium's** on macOS with the same flags — 5ms p50
vs 16ms p50. Probably because Playwright launches stock Chromium with
`--headless` (old headless mode) by default while I was passing
`--headless=new` explicitly in the raw-CDP benches. Didn't chase the
exact cause but it means the Canary path is faster than expected out
of the box.

---

## 2026-04-09 — Tier 2: in-page canvas capture backend

Hypothesis: for workloads that render into a single `<canvas>`, we
can skip `Page.captureScreenshot` entirely and read pixels via
`canvas.toDataURL()` inside the page. This bypasses the compositor
and its VSync pacing, reading the canvas backing store directly.

### In-page capture bench (`bench-inpage.mjs`)

On Canary html-in-canvas test page, `step=500ms`, 60 frames, raw CDP:

| Path | cap p50 | speedup |
|---|---|---|
| A) `Page.captureScreenshot` | 16.0ms | 44x |
| B) `canvas.toDataURL()` per frame | 4.2ms | **113x** |
| C) combined `advance+toDataURL` eval | 3.7ms | 91x (noisy p95) |
| D) batched in-page loop (batch=10) | 2.1ms | **237x** |
| D) batched in-page loop (batch=40) | 2.1ms | **244x** |
| E) `advance`-only floor (no capture) | 1.8ms | 283x |

The batched path comes within **93% of the theoretical paint-only
floor** (283x). Practically speaking, the JPEG encode costs ~0.3ms
per frame at 800×600 q80.

### ❌ DEAD END: canvas backend doesn't work for html-in-canvas

When I wired `setCanvasTarget('#c')` into the real `Renderer` and
ran the `test-animation.html` fixture through it, the test failed:
**only 2–3 unique mid-buffer hashes out of 5 captures**. The frames
were stale.

**Root cause:** the test fixtures use the `paint` event pattern —
the `draw()` function is registered as `canvas.addEventListener(
'paint', draw)`. Paint events are dispatched by the compositor with
*fresh element snapshots* ready to use. Outside of a real compositor
paint, `ctx.drawElementImage(element)` either does nothing or uses
a cached snapshot. The `canvas.toDataURL()` call reads whatever was
last drawn — which is whatever the *last real* `captureScreenshot`
happened to leave behind.

In effect, my earlier 113x / 244x benchmark numbers on the
html-in-canvas workload were **reading cached pixels from the
warmup captures** and reporting the same image over and over. The
"speedup" was an illusion.

### ❌ DEAD END: synthetic paint event dispatch

I tried `c.dispatchEvent(new Event('paint'))` right before the
`toDataURL()` read, hoping the user's `draw()` callback would run on
fresh state. It *does* call the user's handler, but
`drawElementImage(element)` still sees stale element snapshots —
those are populated by the real compositor paint, not by a JS
`dispatchEvent`. Test still failed (3/5 unique hashes).

Removed the `dispatchEvent` from the implementation — it's a
no-op for both the paint-event pattern (doesn't help) and the RAF
pattern (already handled by advance() flushing RAF).

### ✓ What the canvas backend DOES work for

Pure RAF-driven canvas workloads — the user draws to the canvas
inside a `requestAnimationFrame` callback, no `paint` event, no
`layoutsubtree`, no `drawElementImage`. Three.js, PixiJS, D3
canvas, hand-rolled 2D, etc.

Because overcrank's `advance()` flushes RAF synchronously, by the
time we call `toDataURL()` the backing store already contains the
user's latest draw. No compositor round-trip needed, no stale pixels.

### Tier 2 result on a pure RAF workload

Created `test/fixtures/canvas-raf.html` — a 400×240 canvas with a
moving circle, hue cycle, and frame index text, all drawn inside an
RAF callback. Stock Playwright Chromium, `step=500ms`, 80 frames:

```
captureScreenshot    adv p50 0.59 min 0.41 | cap p50 16.06 min 15.16 |  30.02×
canvas target        adv p50 0.28 min 0.22 | cap p50  0.91 min  0.83 | 401.78×
canvas target #2     adv p50 0.25 min 0.22 | cap p50  0.89 min  0.60 | 417.27×
```

**417x speedup** — capture p50 drops from 16ms to **0.89ms** (an
~18x improvement at the per-frame level), advance is 0.25ms, total
per-frame wall time is ~1.2ms. The canvas backend is within a hair
of the advance-only floor (283x from bench-inpage.mjs, though viewport
and workload differ).

Ship it as an opt-in backend via `renderer.setCanvasTarget(selector)`,
with docs explicitly warning away from html-in-canvas use.

### Incidental finding: Canary captureScreenshot path

Also worth noting: stock Chromium `captureScreenshot` sits at
**16.06ms p50** (one VSync period, despite `--disable-frame-rate-limit`
— Playwright seems to not apply our BROWSER_ARGS consistently or
uses `--headless` not `--headless=new`). Canary running through
Playwright with the same launch options gave **5.11ms p50** in
earlier Tier 1 benches. So the Canary binary's captureScreenshot is
meaningfully faster on macOS. Unclear whether this is because of
build flags, headless mode defaults, or a different compositor path.
Worth chasing if we need to push the default (non-canvas-backend)
path further.

---

## Working ceiling estimates (macOS, 800×600, JPEG q80)

Given these findings, what's the peak speedup for various workloads?

| Workload | Backend | cap p50 | step=500 | step=33 (30fps) |
|---|---|---|---|---|
| HTML/DOM (no canvas) | captureScreenshot | ~16ms | ~30x | ~2x |
| Canary DOM/html-in-canvas | captureScreenshot | ~5ms | ~90x | ~6x |
| RAF-drawn canvas | canvas target | ~0.9ms | ~400x | ~30x |
| RAF canvas + batched (hypothetical) | binding events | ~0.5ms (est) | ~800x | ~50x |

Next thing worth trying for further speedup: **Runtime.addBinding**
+ `bindingCalled` events to stream frames out of the page without a
CDP round-trip per frame. This is the batched in-page path from the
bench — proven to work for pure RAF-canvas workloads.
