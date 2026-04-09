/**
 * Fast-forward test: step virtual time FAR faster than real time.
 * Advance 10s of virtual time in as tight a loop as possible, and verify
 * (a) HTML text/color updates correctly per frame
 * (b) no corruption, lost frames, or stale snapshots
 * (c) CSS animations — track if they respect virtual time or stay on wall clock
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const CANARY = '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary';
const DIR = resolve(fileURLToPath(import.meta.url), '..');
const TEST_PAGE = join(DIR, 'test-animation.html');
const OUT_DIR = join(DIR, 'frames-ff');
const VCLOCK_PATH = resolve(DIR, '../../src/virtual-clock.iife.js');
const REMOTE_PORT = 9338;
const userDataDir = mkdtempSync(join(tmpdir(), 'canary-ff-'));
try { mkdirSync(OUT_DIR, { recursive: true }); } catch {}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== Fast-Forward Test ===\n');

  const virtualClockSrc = readFileSync(VCLOCK_PATH, 'utf8');

  const proc = Bun.spawn([
    CANARY, '--headless=new', '--enable-features=CanvasDrawElement',
    '--disable-gpu', '--deterministic-mode',
    '--run-all-compositor-stages-before-draw',
    '--disable-new-content-rendering-timeout',
    '--disable-threaded-animation', '--disable-threaded-scrolling',
    `--remote-debugging-port=${REMOTE_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdout: 'pipe', stderr: 'pipe' });

  await sleep(2500);

  try {
    const r = await fetch(`http://127.0.0.1:${REMOTE_PORT}/json`);
    const targets = await r.json();
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
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
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: virtualClockSrc });
    await cdp('Page.navigate', { url: `file://${TEST_PAGE}` });
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const r = await cdp('Runtime.evaluate', { expression: 'window.__HTML_IN_CANVAS_READY === true' });
      if (r.result.value === true) break;
    }
    await sleep(300);

    // Fast-forward: 10 seconds of virtual time in 100 frames (100ms virtual per frame)
    console.log('Fast-forwarding: 10s virtual time in 100 frames...\n');
    const wallStart = performance.now();
    const timings = [];
    const samples = [];
    const NUM = 100;
    const STEP = 100;

    for (let i = 0; i < NUM; i++) {
      const t0 = performance.now();

      await cdp('Runtime.evaluate', {
        expression: `(() => {
          let r = ${STEP};
          while (r > 0) { const c = Math.min(r, 16); window.__virtualTime.advance(c); r -= c; }
          return window.__virtualTime.now();
        })()`,
      });

      const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
      const buf = Buffer.from(shot.data, 'base64');
      const framePath = join(OUT_DIR, `frame-${String(i).padStart(3, '0')}.jpg`);
      writeFileSync(framePath, buf);

      // Sample a few frames for stats
      if (i % 20 === 0 || i === NUM - 1) {
        const s = await cdp('Runtime.evaluate', { expression: 'JSON.stringify(window.__getStats())' });
        samples.push({ i, ...JSON.parse(s.result.value) });
      }

      timings.push(performance.now() - t0);
    }

    const wallElapsed = performance.now() - wallStart;
    const virtualElapsed = NUM * STEP;
    const speedup = virtualElapsed / wallElapsed;
    const avgFrame = timings.reduce((a, b) => a + b, 0) / timings.length;

    console.log(`Wall time:     ${(wallElapsed/1000).toFixed(2)}s`);
    console.log(`Virtual time:  ${(virtualElapsed/1000).toFixed(2)}s`);
    console.log(`Speedup ratio: ${speedup.toFixed(2)}x real-time`);
    console.log(`Avg frame:     ${avgFrame.toFixed(1)}ms (${(1000/avgFrame).toFixed(1)} fps)`);
    console.log(`Frames saved:  ${NUM}`);

    console.log('\nSampled states over virtual time:');
    for (const s of samples) {
      console.log(`  frame ${s.i}: anim=${s.animFrameCount} paint=${s.paintEventCount} "${s.cardText}" pulser=${s.pulserTransform}`);
    }

    // CSS animation verdict: pulse is 1s period. At virtual t=10000ms, we should
    // have gone through 10 cycles. If pulser transform varies wildly across
    // samples at 2s intervals, virtual time drives CSS. If it's nearly constant,
    // CSS is on wall clock.
    const pulserValues = samples.map(s => {
      const m = s.pulserTransform.match(/matrix\(([^,]+)/);
      return m ? parseFloat(m[1]) : null;
    }).filter(v => v !== null);
    const min = Math.min(...pulserValues);
    const max = Math.max(...pulserValues);
    console.log(`\nPulser scale range across samples: ${min.toFixed(3)} .. ${max.toFixed(3)}`);
    console.log(`CSS animation: ${max - min > 0.05 ? 'varies (some response to time)' : 'nearly frozen'}`);

    ws.close();
  } finally {
    proc.kill();
    await sleep(300);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(e => { console.error(e); process.exit(1); });
