# Emulation.setVirtualTimePolicy — Research Notes

Research question: can CDP's virtual time replace overcrank's in-page JS clock patching, specifically to defeat the 16ms compositor cap on CSS `@keyframes`?

**TL;DR — Verdict: NO, don't use it as the primary clock.** It solves a slightly different problem (deterministic JS/timer execution during navigation), not "advance compositor time for frame capture". It is experimental, unmaintained, missing from Puppeteer/Playwright public APIs on purpose, and has known hang bugs. Playwright explicitly ships `page.clock` (in-page JS patching, same approach as overcrank) as its answer to the same question. That said, it **does** stop compositor ticking when paused, so there is a narrow experiment worth running — see "When it might help" below.

---

## 1. CDP API surface (authoritative)

Source: `https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setVirtualTimePolicy` + `browser_protocol.json`. Marked **experimental**.

### Method: `Emulation.setVirtualTimePolicy`

> "Turns on virtual time for all frames (replacing real-time with a synthetic time source) and sets the current virtual time policy. Note this supersedes any previous time budget."

Parameters:
| name | type | required | meaning |
|---|---|---|---|
| `policy` | `VirtualTimePolicy` enum | yes | `advance` \| `pause` \| `pauseIfNetworkFetchesPending` |
| `budget` | number (ms) | no | after this many virtual ms, time auto-pauses and `virtualTimeBudgetExpired` fires |
| `maxVirtualTimeTaskStarvationCount` | integer | no | max tasks to run before forcing time forward (deadlock guard) |
| `initialVirtualTime` | `Network.TimeSinceEpoch` | no | overrides `base::Time::Now()` to return this value initially |

Returns:
| name | type | meaning |
|---|---|---|
| `virtualTimeTicksBase` | number | absolute timestamp (ms uptime) at which virtual time was first enabled |

### Policy semantics (from the CDP schema, verbatim-ish)

- **`advance`** — "If the scheduler runs out of immediate work, the virtual time base may fast forward to allow the next delayed task (if any) to run."
- **`pause`** — "The virtual time base may not advance."
- **`pauseIfNetworkFetchesPending`** — "The virtual time base may not advance if there are any pending resource fetches."

### Event: `Emulation.virtualTimeBudgetExpired`

> "Notification sent after the virtual time budget for the current VirtualTimePolicy has run out."

No parameters. Only fires when a `budget` was set and elapsed.

### Related (also experimental)

- `Emulation.setVirtualTimeOffset` — adjust offset
- Notable absence: there is **no** "step by N ms" command. To advance by N ms you must call `setVirtualTimePolicy({policy:'advance', budget:N})` and await `virtualTimeBudgetExpired`. Each "step" is a full round trip + policy replacement.

---

## 2. What it actually does to the browser clock

### Implementation path in Chromium
- CDP handler → `blink::scheduler::ThreadSchedulerBase::SetVirtualTimePolicy` (interface: `VirtualTimeController`).
- Backed by `AutoAdvancingVirtualTimeDomain` (Blink), which is a `base::sequence_manager::TimeDomain` that overrides `base::Time::Now` / `base::TimeTicks::Now` for the whole renderer.
- When enabled, `MainThreadSchedulerImpl::OnVirtualTimeEnabled` creates a control task queue; `OnVirtualTimePaused/Resumed` inserts/removes **queue fences** on task queues whose `CanRunWhenVirtualTimePaused() == false`.

Header comment from `auto_advancing_virtual_time_domain.h`:
> "A time domain that runs tasks sequentially in time order but doesn't sleep between delayed tasks. Because AutoAdvancingVirtualTimeDomain may override Time/TimeTicks in a multi-threaded context, it must outlive any thread that may call Time::Now(). In practice, this means AutoAdvancingVirtualTimeDomain can never be destroyed in production and acts as a one-way switch."

**That last sentence is a big deal.** Once you turn virtual time on for a renderer, you can't cleanly turn it off. (Disable exists only `ForTesting`.)

### What it covers

Because `Time::Now` / `TimeTicks::Now` are overridden at the platform base, virtual time transparently drives:

- `Date.now()`, `Date` constructor — yes
- `performance.now()` — yes (uses `TimeTicks::Now`)
- `setTimeout` / `setInterval` — yes (delayed tasks run in virtual-time order; when paused, they don't run due to queue fences)
- `requestAnimationFrame` — yes, driven by the page scheduler's task queues which obey virtual time
- **CSS animations / transitions (Web Animations API) — yes**, because blink's animation clock derives from `TimeTicks::Now`, and `PageSchedulerImpl::OnVirtualTimeEnabled/Paused` routes through the main thread scheduler that gates composited animation frames.
- **Compositor frame production — paused when virtual time paused**, because the queue fences stop BeginMainFrame generation on the main thread. (This is the key potential win over in-page patching.)
- Video playback `<video>` — unclear / probably still uses wall clock. No confirmation found.
- WebGL / canvas — drawing itself doesn't depend on time; any animation inside RAF is virtual-time driven.
- Iframes — "all frames" per the spec; it's per-renderer / per-browsing-context-group.

### What it does NOT cover
- Wall-clock on the browser process (network stack, base::Time outside the renderer). Network latency is still real. That's why `pauseIfNetworkFetchesPending` exists.
- `DOMHighResTimeStamp` coming from the compositor thread when in a pipeline that bypasses main-thread scheduling — for a pause-and-capture workflow this is fine.

---

## 3. Interaction with `Page.captureScreenshot`

**This is the crux for overcrank.** There's no explicit documentation on it. What we can infer:

- When virtual time is `pause`, the main thread cannot produce new BeginMainFrames beyond the paused virtual time (queue fences). So the compositor's last-committed frame is what gets captured.
- `captureScreenshot` in headless mode triggers a frame commit / BeginFrame under the hood (via Viz). With virtual time paused, the compositor should emit exactly one frame reflecting the current virtual-time state, then return.
- The 16ms wall-clock pacing you're seeing in overcrank today is because RAF / composited animations are driven by the real compositor BeginFrame cadence (vsync-ish). If virtual time is truly paused, that cadence is irrelevant — the capture happens on demand.

**Caveat:** Even with virtual time, on non-headless and on `chrome-headless-shell` with a real viz frame sink, `captureScreenshot` may still wait for a presentation ack from the GPU process. That's orthogonal to virtual time. This is why `Page.captureScreenshot` with `fromSurface:false` (or with begin-frame-control) is sometimes used in combination.

Overcrank already has a `--begin-frame` fast backend; virtual time would stack with that, not replace it. The combination `setVirtualTimePolicy({policy:'pause'})` + `HeadlessExperimental.beginFrame + screenshot` is the known-fastest pattern in Chromium web tests.

---

## 4. Typical usage pattern

### 4a. The only real-world JS example found — `chrome-headless-render-pdf`

This is the canonical public example. Note it uses `pauseIfNetworkFetchesPending`, not frame stepping.

```js
// from Szpadel/chrome-headless-render-pdf lib (simplified)
const { Page, Emulation, LayerTree } = client;
await Page.enable();
await LayerTree.enable();

const loaded = this.cbToPromise(Page.loadEventFired);
const jsDone = this.cbToPromise(Emulation.virtualTimeBudgetExpired);

await Page.navigate({ url });
await Emulation.setVirtualTimePolicy({
  policy: 'pauseIfNetworkFetchesPending',
  budget: this.options.jsTimeBudget, // e.g. 5000ms virtual
});

await loaded;   // wait for load event
await jsDone;   // wait for budget to expire = JS idle
// now print / screenshot
```

Purpose: make JS timers and RAF run until "JS is done" (budget expired), then capture a deterministic snapshot. It's "give JS N virtual seconds to settle, then stop", not "step N times capturing each frame".

### 4b. Frame-stepping pattern (theoretical, for overcrank's use case)

No public JS library does this in prod. The idiom would be:

```js
await Emulation.setVirtualTimePolicy({ policy: 'pause' });
// virtual time now frozen at t=0

for (let i = 0; i < totalFrames; i++) {
  // advance by 1/fps ms of virtual time
  const stepP = new Promise(r => cdp.once('Emulation.virtualTimeBudgetExpired', r));
  await cdp.send('Emulation.setVirtualTimePolicy', {
    policy: 'advance',
    budget: 1000 / fps,
    maxVirtualTimeTaskStarvationCount: 1000, // deadlock guard
  });
  await stepP;
  // Re-enter pause (supersedes prior policy per spec)
  await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFrame(data);
}
```

Every step is 2x CDP round-trips plus an event plus the screenshot. For 60fps output that's ~240 CDP ops/sec minimum. This is the same shape as overcrank's current loop, just with CDP instead of in-page JS stepping — the question is whether freezing the compositor via fences saves more time than the CDP overhead costs.

### 4c. Chromium web-test usage
The Chromium `content/web_test` layer uses `SetVirtualTimePolicy` directly via the internal `VirtualTimeController` (not CDP) to run layout tests deterministically. That's the original motivation for the API — it's a **layout-test infrastructure primitive** that was exposed via CDP almost as an afterthought. No intent to be a general-purpose "film a web page" API.

---

## 5. Gotchas & limitations

1. **Experimental** — flagged in the protocol. Can change without notice. Has changed multiple times (VirtualTimeBudget was a separate event once).
2. **One-way switch in production renderers.** `AutoAdvancingVirtualTimeDomain` "can never be destroyed in production" per the header comment. You can't gracefully return the page to wall clock; must close the renderer.
3. **Known hang bug: "virtual time budget never expiring"** — Szpadel/chrome-headless-render-pdf#29. With `pauseIfNetworkFetchesPending`, intermittent hangs on even trivial pages on headless Chromium 65+. Workaround was to call `setVirtualTimePolicy` only **after** `Page.loadEventFired`, not before navigate. Closed as "works around it" not "fixed in Chromium".
4. **`maxVirtualTimeTaskStarvationCount` is mandatory for safety.** If you omit it, a busy RAF loop or `setTimeout(fn, 0)` chain can starve the delayed task queue and virtual time will never advance past t=0, hanging `budget` forever. Chromium's own advice is "a reasonable value in practice is around 1000 tasks".
5. **Applies to every frame / every execution context in the browsing context group.** No fine-grained control per subframe. Cross-origin iframes are included (they share the browsing context).
6. **`initialVirtualTime` can't go backward.** Virtual time is monotonic. If you want to restart capture you must open a fresh page.
7. **Network requests don't use virtual time.** Only `pauseIfNetworkFetchesPending` gates time on them. Real HTTP round-trips still burn real seconds.
8. **Animated media elements (`<video>`, MSE, WebRTC) — behavior undocumented.** Reports from Chromium bug tracker over the years say `<video>` currentTime often ignores virtual time (media pipeline runs on its own clock). For overcrank's use case (CSS / RAF / canvas) this is probably fine, but any page containing real video will not be filmable frame-accurate.
9. **`chrome-headless-shell` (old headless, which Playwright ships as the default Chromium) — should work.** The emulation handler lives in `content/browser/devtools/protocol/emulation_handler.cc`, which is used by both new and old headless. No macOS-specific exclusions found in the source or issue tracker. However, old headless is being deprecated; long-term this API lives with new headless where the CDP plumbing is known-good.
10. **Pairs badly with `beginFrame` if you're not careful.** In pure virtual-time mode with `pause`, the compositor won't tick on its own — you must drive it via `HeadlessExperimental.beginFrame` to get a frame. Some Chromium builds of `chrome-headless-shell` on macOS don't support `beginFrame` at all (which is why overcrank has a platform check). Virtual time without beginFrame may leave you with a stale last-committed frame for captureScreenshot.

---

## 6. Puppeteer & Playwright exposure

**Neither exposes it.** Confirmed via GitHub code search on both repos — zero hits for `setVirtualTimePolicy` in Puppeteer or Playwright source, tests, or docs.

- **Puppeteer:** no wrapper. You can call it via `page.createCDPSession()` → `send('Emulation.setVirtualTimePolicy', ...)` manually. No helper. No deliberate decision record found, but the absence across 7+ years of issues indicates the team doesn't want to own it.
- **Playwright:** explicitly ships [`page.clock`](https://playwright.dev/docs/clock) (since v1.45) as its answer. `clock.install()` fakes **`Date`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `requestAnimationFrame`, `cancelAnimationFrame`, `requestIdleCallback`** via an in-page init script (`globalThis.__pwClock.controller`). `clock.fastForward(ms)`, `clock.pauseAt(time)`, `clock.install(time)`. **This is exactly overcrank's approach.** Microsoft looked at virtual time, decided against it, and built an in-page shim instead. Their init script lives at `packages/playwright-core/src/server/clock.ts` + `generated/clockSource`.

That's the strongest signal in this whole research dump: the two mainstream browser-automation teams independently decided virtual time via CDP is not worth the complexity.

---

## 7. When it might still help overcrank

Despite all the above, the one thing virtual time gives you that in-page patching cannot:

> **Freeze the Blink compositor thread + main thread tightly enough that composited CSS `@keyframes` stop ticking between captures.**

Overcrank's current pain is that CSS animations (which run on the compositor with their own clock baseline derived from `TimeTicks::Now`) ignore the JS clock shim. `setVirtualTimePolicy({policy:'pause'})` does override `TimeTicks::Now` at the base platform layer, so composited animations should be frozen too.

**Experiment worth running before committing:**

1. Build a fixture page with a pure-CSS keyframe animation (no JS driver).
2. In one Chromium instance, load it, call `setVirtualTimePolicy({policy:'pause'})`, then loop `{setVirtualTimePolicy advance budget:16ms, wait budgetExpired, setVirtualTimePolicy pause, captureScreenshot}`.
3. Measure: (a) do the resulting frames show the CSS animation progressing smoothly? (b) what's the per-frame wall-clock cost vs overcrank's current `--begin-frame` path?

If (a) is yes and (b) is ≤ current, it's a win specifically for CSS-animation-heavy pages. **Keep the in-page JS patching as the default** and add virtual time as an opt-in `--cdp-virtual-time` mode for pages where JS patching doesn't cover the visible animation.

**Don't** try to use virtual time as a total replacement for the IIFE clock. The IIFE clock is simpler, reversible, works everywhere, and matches what Playwright chose.

---

## 8. Key source files (for deeper dives later)

- `https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setVirtualTimePolicy` — authoritative API
- `https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json` — machine-readable
- `third_party/blink/renderer/platform/scheduler/common/thread_scheduler_base.h` — `SetVirtualTimePolicy` impl interface
- `third_party/blink/renderer/platform/scheduler/common/auto_advancing_virtual_time_domain.h` — the time domain itself; good header comment about one-way switch
- `third_party/blink/renderer/platform/scheduler/main_thread/main_thread_scheduler_impl.cc` — `OnVirtualTimePaused/Resumed` queue-fence logic
- `third_party/blink/renderer/platform/scheduler/main_thread/page_scheduler_impl.cc` — `PageSchedulerImpl::OnVirtualTimeEnabled`
- `content/browser/devtools/protocol/emulation_handler.cc` — CDP → Blink wiring
- `https://github.com/Szpadel/chrome-headless-render-pdf/blob/master/index.js#L124-L135` — only clean public JS example
- `https://github.com/Szpadel/chrome-headless-render-pdf/issues/29` — hang bug + workaround
- `https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/clock.ts` — Playwright's "we don't use virtual time" answer
- `https://playwright.dev/docs/clock` — Clock API docs
