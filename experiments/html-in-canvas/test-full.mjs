/**
 * Full integration test: html-in-canvas + virtual clock + beginFrame
 *
 * Steps:
 * 1. Launch headless Canary with CanvasDrawElement + beginFrame support
 * 2. Inject overcrank's virtual clock via Page.addScriptToEvaluateOnNewDocument
 * 3. Load test-animation.html
 * 4. Advance virtual time in 16ms steps
 * 5. Capture frames via beginFrame
 * 6. Verify: (a) beginFrame works, (b) HTML captures update per frame,
 *           (c) paint event fires, (d) CSS animations respect virtual clock
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const CANARY = '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary';
const DIR = resolve(fileURLToPath(import.meta.url), '..');
const TEST_PAGE = join(DIR, 'test-animation.html');
const OUT_DIR = join(DIR, 'frames');
const VCLOCK_PATH = resolve(DIR, '../../src/virtual-clock.iife.js');

const REMOTE_PORT = 9334;
const userDataDir = mkdtempSync(join(tmpdir(), 'canary-full-'));

try { mkdirSync(OUT_DIR, { recursive: true }); } catch {}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== HTML-in-Canvas + Virtual Clock + beginFrame ===\n');

  const virtualClockSrc = readFileSync(VCLOCK_PATH, 'utf8');

  console.log('Launching headless Canary...');
  const proc = Bun.spawn([
    CANARY,
    '--headless=new',
    '--enable-features=CanvasDrawElement',
    '--disable-gpu',
    '--deterministic-mode',
    '--run-all-compositor-stages-before-draw',
    '--disable-new-content-rendering-timeout',
    '--disable-threaded-animation',
    '--disable-threaded-scrolling',
    '--disable-checker-imaging',
    '--disable-image-animation-resync',
    `--remote-debugging-port=${REMOTE_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdout: 'pipe', stderr: 'pipe' });

  await sleep(2500);

  try {
    // Get the browser websocket
    const versionRes = await fetch(`http://127.0.0.1:${REMOTE_PORT}/json/version`);
    const version = await versionRes.json();
    console.log(`  Browser: ${version.Browser}`);
    const browserWs = version.webSocketDebuggerUrl;

    const listRes = await fetch(`http://127.0.0.1:${REMOTE_PORT}/json`);
    const targets = await listRes.json();
    const page = targets.find(t => t.type === 'page');
    const pageWs = page.webSocketDebuggerUrl;

    const ws = new WebSocket(pageWs);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 1;
    function cdp(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        const handler = (event) => {
          const data = JSON.parse(event.data);
          if (data.id === id) {
            ws.removeEventListener('message', handler);
            if (data.error) reject(new Error(`${method}: ${JSON.stringify(data.error)}`));
            else resolve(data.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await cdp('Page.enable');
    await cdp('Runtime.enable');

    // Test beginFrame availability
    console.log('\n[1] Testing beginFrame availability on macOS headless...');
    let frameTimeTicks = Date.now() * 1000;
    let beginFrameWorks = false;
    try {
      await cdp('HeadlessExperimental.beginFrame', { frameTimeTicks });
      beginFrameWorks = true;
      console.log('  beginFrame works on headless Canary macOS');
    } catch (e) {
      console.log(`  beginFrame failed: ${e.message}`);
    }

    // Inject virtual clock BEFORE navigating
    console.log('\n[2] Injecting virtual clock...');
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: virtualClockSrc,
    });

    // Navigate to test page
    console.log('[3] Loading test page...');
    await cdp('Page.navigate', { url: `file://${TEST_PAGE}` });

    // Wait for page ready
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      try {
        const r = await cdp('Runtime.evaluate', {
          expression: 'window.__HTML_IN_CANVAS_READY === true',
        });
        if (r.result.value === true) break;
      } catch {}
    }
    console.log('  Page ready');

    // Verify APIs present
    const apiCheck = await cdp('Runtime.evaluate', {
      expression: `(() => {
        const c = document.getElementById('c');
        return {
          hasLayoutSubtree: c.hasAttribute('layoutsubtree'),
          hasDrawElementImage: typeof c.getContext('2d').drawElementImage === 'function',
          hasVirtualTime: typeof window.__virtualTime === 'object',
          virtualNow: window.__virtualTime ? window.__virtualTime.now() : null,
          pendingRAFs: window.__virtualTime ? window.__virtualTime.pendingRAFs() : null,
        };
      })()`,
      returnByValue: true,
    });
    console.log('  API check:', JSON.stringify(apiCheck.result.value));

    // Give the browser one frame to record the initial snapshot of children
    // (drawElementImage needs an initial snapshot before it can draw)
    if (beginFrameWorks) {
      console.log('\n[4] Priming initial frame snapshot with beginFrame...');
      frameTimeTicks += 16000;
      await cdp('HeadlessExperimental.beginFrame', { frameTimeTicks });
    } else {
      console.log('\n[4] Priming initial frame snapshot (no beginFrame)...');
      await sleep(200); // let natural rendering kick in
    }

    // Now advance virtual time and capture frames
    console.log('\n[5] Advancing virtual time + capturing frames...');
    const NUM_FRAMES = 12;
    const STEP_MS = 83; // ~12fps to see clear motion in CSS pulse animation
    const timings = [];
    const stats = [];

    for (let i = 0; i < NUM_FRAMES; i++) {
      const start = performance.now();

      // Advance virtual clock (flushes RAF callbacks, which call drawElementImage)
      await cdp('Runtime.evaluate', {
        expression: `(() => {
          let remaining = ${STEP_MS};
          while (remaining > 0) {
            const chunk = Math.min(remaining, 16);
            window.__virtualTime.advance(chunk);
            remaining -= chunk;
          }
          return window.__virtualTime.now();
        })()`,
      });

      // Capture frame
      let screenshotData;
      let captureMethod = 'captureScreenshot';
      if (beginFrameWorks) {
        frameTimeTicks += STEP_MS * 1000;
        try {
          const result = await cdp('HeadlessExperimental.beginFrame', {
            frameTimeTicks,
            screenshot: { format: 'png' },
          });
          if (result.screenshotData) {
            screenshotData = result.screenshotData;
            captureMethod = 'beginFrame';
          }
        } catch (e) {
          // fall through to captureScreenshot
        }
      }
      if (!screenshotData) {
        const result = await cdp('Page.captureScreenshot', { format: 'png' });
        screenshotData = result.data;
      }

      const elapsed = performance.now() - start;
      timings.push(elapsed);

      // Save frame
      const buf = Buffer.from(screenshotData, 'base64');
      const framePath = join(OUT_DIR, `frame-${String(i).padStart(3, '0')}.png`);
      writeFileSync(framePath, buf);

      // Get stats
      const s = await cdp('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__getStats())',
      });
      const stat = JSON.parse(s.result.value);
      stats.push(stat);

      console.log(`  frame ${i}: ${elapsed.toFixed(1)}ms [${captureMethod}] anim=${stat.animFrameCount} paint=${stat.paintEventCount} size=${buf.length}B text="${stat.cardText}"`);
    }

    // Summary
    console.log('\n[6] Summary:');
    const avgTime = timings.reduce((a, b) => a + b, 0) / timings.length;
    console.log(`  avg frame time: ${avgTime.toFixed(1)}ms`);
    console.log(`  capture method: ${beginFrameWorks ? 'beginFrame' : 'captureScreenshot'}`);
    console.log(`  total animFrames: ${stats[stats.length - 1].animFrameCount}`);
    console.log(`  total paintEvents: ${stats[stats.length - 1].paintEventCount}`);
    console.log(`  final card text: "${stats[stats.length - 1].cardText}"`);
    console.log(`  final pulser transform: ${stats[stats.length - 1].pulserTransform}`);
    console.log(`  log tail:`);
    for (const line of stats[stats.length - 1].logTail) {
      console.log(`    ${line}`);
    }

    // Pass/fail
    console.log('\n[7] Verdict:');
    const txtChanged = stats[0].cardText !== stats[stats.length - 1].cardText;
    const hasFrames = stats[stats.length - 1].animFrameCount > 1;
    const paintFired = stats[stats.length - 1].paintEventCount > 0;
    const pulseTransformVaries = new Set(stats.map(s => s.pulserTransform)).size > 1;

    console.log(`  HTML animation captured (card text changes): ${txtChanged ? 'YES' : 'NO'}`);
    console.log(`  RAF callbacks driven by virtual clock: ${hasFrames ? 'YES' : 'NO'}`);
    console.log(`  paint event fires: ${paintFired ? 'YES' : 'NO'}`);
    console.log(`  CSS animation respects virtual clock: ${pulseTransformVaries ? 'YES' : 'NO'}`);
    console.log(`  beginFrame backend: ${beginFrameWorks ? 'YES' : 'NO'}`);

    ws.close();
  } catch (err) {
    console.error('\nERROR:', err.stack || err.message);
  } finally {
    proc.kill();
    await sleep(300);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

main();
