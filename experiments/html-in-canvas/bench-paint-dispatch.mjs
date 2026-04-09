/**
 * Investigate: can we force a `paint` event from JS so canvas.toDataURL()
 * picks up fresh pixels in html-in-canvas workloads?
 *
 * Three shapes:
 *   A) bare toDataURL (presumed stale — will return cached pixels)
 *   B) dispatchEvent(new Event('paint')) + toDataURL
 *   C) captureScreenshot (trigger real paint) + toDataURL (throwaway)
 */
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const CANARY = '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary';
const DIR = resolve(fileURLToPath(import.meta.url), '..');
const TEST_PAGE = join(DIR, 'test-animation.html');
const VCLOCK_PATH = resolve(DIR, '../../src/virtual-clock.iife.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const virtualClockSrc = readFileSync(VCLOCK_PATH, 'utf8');

async function launch(port, userDataDir) {
  const proc = Bun.spawn([
    CANARY,
    '--headless=new',
    '--enable-features=CanvasDrawElement',
    '--disable-gpu',
    '--disable-frame-rate-limit',
    '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdout: 'pipe', stderr: 'pipe' });
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch {}
  }
  return proc;
}

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 1;
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = id++;
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === mid) {
        ws.removeEventListener('message', h);
        if (d.error) reject(new Error(`${method}: ${JSON.stringify(d.error)}`));
        else resolve(d.result);
      }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, cdp };
}

const userDataDir = mkdtempSync(join(tmpdir(), 'canary-paint-'));
const port = 9700 + Math.floor(Math.random() * 100);
const proc = await launch(port, userDataDir);

try {
  const { ws, cdp } = await connect(port);
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: virtualClockSrc });
  await cdp('Page.navigate', { url: `file://${TEST_PAGE}` });

  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const r = await cdp('Runtime.evaluate', { expression: 'window.__HTML_IN_CANVAS_READY === true' });
    if (r.result.value === true) break;
  }
  await sleep(200);

  // Prime the compositor once via captureScreenshot — this populates canvas with initial pixels
  await cdp('Runtime.evaluate', { expression: `(()=>{let r=16;while(r>0){const c=Math.min(r,16);window.__virtualTime.advance(c);r-=c;}})()` });
  await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true });

  // Hash helper — mid of JPEG
  async function midHashBare() {
    const { result } = await cdp('Runtime.evaluate', {
      expression: `document.getElementById('c').toDataURL('image/jpeg', 0.8)`,
      returnByValue: true,
    });
    const dataUrl = result.value;
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const buf = Buffer.from(base64, 'base64');
    const mid = Math.floor(buf.length / 2);
    let h = 0;
    for (let k = 0; k < 256; k++) h = ((h * 31 + buf[mid + k]) >>> 0);
    return h;
  }
  async function midHashPaintDispatch() {
    const { result } = await cdp('Runtime.evaluate', {
      expression: `
        (() => {
          const c = document.getElementById('c');
          c.dispatchEvent(new Event('paint'));
          return c.toDataURL('image/jpeg', 0.8);
        })()
      `,
      returnByValue: true,
    });
    const dataUrl = result.value;
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const buf = Buffer.from(base64, 'base64');
    const mid = Math.floor(buf.length / 2);
    let h = 0;
    for (let k = 0; k < 256; k++) h = ((h * 31 + buf[mid + k]) >>> 0);
    return h;
  }
  async function midHashCapture() {
    const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true });
    const buf = Buffer.from(data, 'base64');
    const mid = Math.floor(buf.length / 2);
    let h = 0;
    for (let k = 0; k < 256; k++) h = ((h * 31 + buf[mid + k]) >>> 0);
    return h;
  }

  const advance = (n) => cdp('Runtime.evaluate', { expression: `(()=>{let r=${n};while(r>0){const c=Math.min(r,16);window.__virtualTime.advance(c);r-=c;}})()` });

  console.log('\n=== Unique-frame check (paint-event workload) ===\n');

  // A) bare toDataURL after advance
  {
    const set = new Set();
    for (let i = 0; i < 5; i++) {
      await advance(500);
      set.add(await midHashBare());
    }
    console.log(`A) bare toDataURL          : ${set.size}/5 unique ${set.size > 1 ? '' : '← STALE'}`);
  }
  // B) dispatch Event('paint') + toDataURL after advance
  {
    const set = new Set();
    for (let i = 0; i < 5; i++) {
      await advance(500);
      set.add(await midHashPaintDispatch());
    }
    console.log(`B) dispatch paint + toDataU: ${set.size}/5 unique ${set.size > 1 ? '' : '← STALE'}`);
  }
  // C) captureScreenshot (baseline)
  {
    const set = new Set();
    for (let i = 0; i < 5; i++) {
      await advance(500);
      set.add(await midHashCapture());
    }
    console.log(`C) captureScreenshot       : ${set.size}/5 unique ${set.size > 1 ? '' : '← STALE'}`);
  }

  ws.close();
} finally {
  proc.kill();
  await sleep(200);
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}
