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

---

## 2026-04-09 — Tier 3 investigation + LAUNCH_ARGS footgun discovery

### Batched streaming doesn't justify a new API (`bench-tier3.mjs`)

Tested batched in-page capture on `canvas-raf.html` (400×240, step=500ms,
80 frames) to see if collapsing N frames into one CDP round-trip could
beat the current Tier 2 ceiling.

| Path | cap p50 | speedup |
|---|---|---|
| A) baseline Renderer (frame-by-frame) | 0.89ms | 409× |
| B) combined `advance + toDataURL` in 1 eval | 1.12ms | 433× |
| C batch=5 — array return | 0.99ms | 503× |
| C batch=10 — array return | 0.98ms | 514× |
| C batch=40 — array return | 0.96ms | 523× |
| D batch=5 — addBinding stream | 0.99ms | 503× |
| D batch=40 — addBinding stream | 0.95ms | 529× |
| E advance-only floor (no capture) | 0.61ms | 778× |

Key finding: **batching only gets us from 409× → 528× (29% improvement).**
The per-frame cost is dominated by `canvas.toDataURL()` JPEG encode inside
the page (~0.35ms), not CDP round-trips. Advance-only floor is 0.61ms;
capture adds ~0.34ms on top. `Runtime.addBinding` streaming gives ~1%
improvement over returning an array — both are in-page cost bound.

**Decision: ship nothing.** A new `captureBatch` API would complicate the
surface for a 20% win on an already 400× baseline. Not worth it.

### ❗ LAUNCH_ARGS footgun (the real Tier 3 win)

**Investigation started here:** the prior FINDINGS entry claimed Canary
`captureScreenshot` at 5ms p50 vs stock Playwright Chromium at 16ms p50 on
macOS — and I suspected a Playwright launch-args mismatch.

**Inspected Playwright's actual child process** with `ps`:
- Playwright on macOS already uses `chrome-headless-shell` (the same binary
  we only detected on Linux for `beginFrame`). Path:
  `~/Library/Caches/ms-playwright/chromium_headless_shell-*/...`
- Our `BROWSER_ARGS` (when passed) DO land on the command line intact,
  including `--disable-frame-rate-limit`.
- Using `--headless` (legacy), which is expected for chrome-headless-shell.

**Attempted `HeadlessExperimental.beginFrame` on macOS chrome-headless-shell:**
- `--enable-begin-frame-control` alone: accepted, but `beginFrame` still fails
  at runtime. `usesBeginFrame` stays false.
- Full `BEGIN_FRAME_ARGS` (adds `--run-all-compositor-stages-before-draw`,
  `--disable-threaded-animation`, etc): **crashes the page** with
  `Target page, context or browser has been closed`. This flag combination
  hangs or kills chrome-headless-shell on macOS.
- Conclusion: **beginFrame is Linux-only** even though the binary is the
  same. Some compositor code path is Linux-specific.

### Viewport sweep (`bench-viewport-sizes.mjs`)

With all the right flags, re-measured captureScreenshot on `canvas-raf.html`
across viewport sizes. This is what the **normal user on macOS** sees:

| Viewport | Pixels | captureScreenshot p50 | canvas-target p50 | Canvas advantage |
|---|---|---|---|---|
| 400×240   | 96K    | 0.89ms | 0.62ms | 1.4× |
| 800×600   | 480K   | 1.90ms | 0.68ms | 2.8× |
| 1280×720  | 921K   | 3.12ms | 0.63ms | 5.0× |
| 1920×1080 | 2073K  | 6.01ms | 0.63ms | 9.5× |

**captureScreenshot scales linearly with pixel count** (~3ns/pixel on M-series).
canvas-target is bound by the canvas size (400×240 here), so its cost is
**constant regardless of viewport** — making it dominant for small-canvas-in-
big-viewport scenes (dashboards, hero animations).

### ❌ The 16ms bench result in Tier 2 was a benchmarker bug

Rerun of the exact same `bench-canvas-backend.mjs` shows 16ms for captureScreenshot
at 400×240 — reproducible. But the new `bench-viewport-sizes.mjs` shows 0.89ms
for the same operation with the same viewport. The difference?

**`bench-canvas-backend.mjs` launched with `chromium.launch({ headless: true })`
— no `args` array. So `--disable-frame-rate-limit` was NEVER applied.**

This was a bench-only issue. But it reveals a real user-facing problem:
**users of the `Renderer.create(page)` low-level API are responsible for
launching the browser themselves, and if they forget the flags, they silently
hit the VSync floor.** No warning, no indication — just 10–20× slower than
they could be.

### Fix: export `LAUNCH_ARGS` + runtime probe warning

1. **Exported `LAUNCH_ARGS`** from `src/index.ts` as a named readonly constant.
   Users doing manual launch can `chromium.launch({ args: [...LAUNCH_ARGS] })`.
2. **Runtime detection** in `Renderer._cdpScreenshot()`: sample the first
   5 `captureScreenshot` durations, and if the **min** is ≥ 12ms, the
   browser is almost certainly missing `--disable-frame-rate-limit`. Warn
   once per process with a copy-pasteable fix.
   - Use `min` (not median or mean) to avoid false positives from cold-start
     warmup, which commonly takes ~10–20ms on the first frame regardless.
3. **Documented in README**: launch args section with a warning callout,
   updated performance table with real viewport-sweep numbers.

### ❗ Compositor-paced ceiling on CSS keyframe pages (`bench-animation-fixture.mjs`)

Discovered while testing the probe: `test/fixtures/animation.html` (which
uses CSS `@keyframes animation: slide 2s linear infinite`) captures at
**17ms/frame regardless of flags**, even with full LAUNCH_ARGS. On the
same viewport (640×480), canvas-raf.html captures at 1.44ms — a 12× gap.

Flags tried, none moved the needle:
- `--disable-threaded-animation`
- `--disable-threaded-scrolling`
- `--disable-background-timer-throttling`
- `--disable-renderer-backgrounding`
- `--disable-backgrounding-occluded-windows`
- `--disable-checker-imaging`
- `--blink-settings=acceleratedAnimationEnabled=false`

**Hypothesis:** when a CSS animation is running, the compositor thread is
independently ticking and `Page.captureScreenshot` waits for the next
commit — coupled to the real display refresh rate, not our virtual clock.
Our RAF-based virtual clock correctly flushes JavaScript-driven animations
(that's why canvas-raf renders each frame's state correctly), but CSS
threaded animations run on a separate compositor clock that we can't
patch from the page.

**Correctness is NOT preserved** (retracted from earlier draft — see section
"2026-04-09 — CSS cap is a correctness bug" below). The CSS animation in the
output video plays at **wall-clock speed**, not virtual-clock speed, because
Blink does **not** drive composited CSS animations from our patched JS clock.

**Potential fix (not yet implemented):** switch to Chromium's native
`Emulation.setVirtualTimePolicy` with `pauseIfNetworkFetchesPending` policy.
This integrates at the Chromium scheduler level — it pauses CSS animations,
RAF, setTimeout, setInterval, and the compositor tick all together. Advance
via `Emulation.setVirtualTimePolicy(policy='advance', budget=Nms)`. Would
likely give us the ~1ms floor on CSS-animation pages. Deferred for investigation.

### Tier 3 conclusion

**Ship:**
- `LAUNCH_ARGS` export + runtime probe warning (closes a silent 10–20x
  footgun for low-level API users)
- Updated README with real performance numbers and launch-args documentation
- Updated viewport-sweep benchmarks

**Don't ship:**
- Batched in-page capture API (29% win, new surface area — not worth it)

**Next investigation:**
- `Emulation.setVirtualTimePolicy` as a replacement / complement to the
  RAF virtual clock, specifically to fix the CSS-animation capture ceiling.
  If it works, we could drop ~15ms per frame on DOM-heavy pages.

---

## 2026-04-09 — CSS cap is a correctness bug, not just a perf issue

### Visual verification triggered a reframe

Wrote `experiments/verify-output.mjs` to end-to-end-render the two canonical
fixtures through `render()` and actually *look* at the resulting MP4s (not just
measure capture cost). Previous findings focused on wall-clock per-frame time
and took "animation frames reflect virtual time" on faith. They shouldn't
have.

**CSS @keyframes fixture (`animation.html`)** — 1280×720, 4s duration,
30fps. Fixture: 100×100 red box, `animation: slide 2s linear infinite`, plus
a RAF-driven text label showing the virtual timer.

Extracted 4 frames at 1s intervals:

| Output timestamp | Text label (JS) | Box position | Expected (2s period) |
|---|---|---|---|
| frame-01 (~0.43s) | `0.433s` | ~12% across | ~22% (21% into loop 1) |
| frame-02 (~1.43s) | `1.433s` | ~37% across | ~72% (72% into loop 1) |
| frame-03 (~2.43s) | `2.433s` | ~65% across | ~22% (21% into loop 2) |
| frame-04 (~3.43s) | `3.433s` | ~90% across | ~72% (72% into loop 2) |

The box sweeps **monotonically left-to-right across the full 4-second
video** — a single slow sweep, not two full loops. The JS timer label (driven
through patched RAF) progresses correctly. The compositor-driven box does
not. **Text and box are reading different clocks.**

### Why this is worse than "slow"

The Tier 3 notes claimed "correctness is preserved, capture is paced." That
was wrong. Composited CSS animations and transitions run on the compositor
thread, which reads its own `base::TimeTicks::Now()` derived from real wall
clock. Our virtual clock patches:

- `Date.now`, `performance.now` — **JavaScript only**
- `requestAnimationFrame` — **flushes callbacks on advance(), but the
  underlying compositor tick for composited props (transform, opacity,
  filter, clip-path, `@keyframes` with hardware-accelerated properties) is
  not rescheduled**

So when overcrank calls `renderer.advance(33)` and then `renderer.capture()`,
the captured frame contains:
- **JS-updated DOM state** at virtual time `t + 33ms` (correct)
- **Compositor-layer visuals** at wall-clock time `≈ t_wall` (wrong —
  independent of virtual time)

For a 4s-long render that took 3.35s wall clock, the box only completes
~1 (instead of 2) loops of the `2s linear infinite` animation. The speed
distortion is ~50%. For pages that render slower than real-time (big viewports),
CSS animations would appear *faster* than they should.

### What this means for overcrank users

This isn't a latent edge case — it's the advertised "render CSS animations
to video" use case, and it's broken. If your page's visual timeline depends
on composited CSS animations, **overcrank currently produces wrong output**.
The README overstated supported workloads.

### Affected workloads

Pages whose visual state depends on **any of these** are affected:
- `@keyframes` on transform / opacity / filter / clip-path (composited props)
- CSS `transition` triggered by JS class changes
- `animation-delay` driving staggered motion
- SVG SMIL (maybe — not tested)

Pages **not affected** (correct output):
- Canvas 2D / WebGL content drawn from RAF (canvas-raf fixture verified:
  frame indices advance cleanly F39 → F129 → F219 → F309 at 90 RAF ticks per
  playback second, circle position and color update every frame)
- GSAP / anime.js / framer-motion / any library that manipulates styles via
  JS every frame (because those libraries call `setProperty` in a RAF loop,
  which *is* driven by our virtual clock)
- Lottie in JS playback mode

### Actions taken

1. **README reframed.** Added a prominent "Supported workloads" section
   before Performance that explicitly calls out the CSS `@keyframes` limitation
   as "known-incorrect output, not just slower". Removed "CSS/Lottie animations
   → video" from the use-case list; replaced with "JS-driven animations → video".
2. **`examples/css-animation.ts`** annotated as the reference reproduction
   of the bug rather than an advertised example.
3. **Retracted** the earlier "correctness is preserved" claim in the Tier 3
   CSS compositor cap note above.

### What we now know the fix *must* do

Any real fix needs to reach the compositor clock, not just the JS clock.
Options in decreasing order of likely feasibility:
1. **`Emulation.setVirtualTimePolicy`** — overrides `TimeTicks::Now` at the
   platform base, which is what Blink's animation clock reads. The research
   in `notes-virtualtimepolicy.md` confirms this should freeze composited
   CSS animations. The initial benchmark attempt hung on `animation.html`'s
   RAF loop; needs retry with lower `maxVirtualTimeTaskStarvationCount` and
   a JS-free pure-CSS fixture. **Most promising.**
2. **`--blink-settings=acceleratedAnimationEnabled=false`** — forces all
   animations off the compositor onto the main thread. Tried in
   `bench-animation-fixture.mjs` and did **not** break the 17ms cap — the
   main thread is apparently also paced when the compositor still has the
   BeginMainFrame loop running. Dead end on its own.
3. **Combine #1 + `HeadlessExperimental.beginFrame`** — Linux only. With
   virtual time paused and manual frame production, this is the
   Chromium-web-tests pattern and should give the 1ms floor. Not useful on
   macOS.
4. **Document as unsupported** — worst outcome; ships a correctness bug as a
   feature.

### Recommended path forward (2026-04-09)

1. Ship 0.4.0 with honest docs (canvas + JS workloads, known CSS limitation).
2. Post-release, retry `setVirtualTimePolicy` with:
   - Pure-CSS fixture (zero JS, zero RAF) — removes the known hang cause
   - `maxVirtualTimeTaskStarvationCount: 10` (1000 was too permissive)
   - Correctness verification: re-run `verify-output.mjs` on the fixture
   - If it works, add opt-in `renderer.useCdpVirtualTime()` mode for
     CSS-animation pages, keeping the IIFE clock as the default for everything
     else (Playwright's precedent — `page.clock` for the common case).
3. If `setVirtualTimePolicy` can't be made reliable, document the limitation
   permanently and recommend JS-driven animation libraries.
