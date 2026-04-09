/**
 * Tier 3: batched in-page capture on a valid RAF workload.
 *
 * Hypothesis: after Tier 2, the biggest remaining per-frame cost is
 * the CDP round-trip pair (one Runtime.evaluate for advance, one for
 * toDataURL). If we drive the entire advance+capture loop inside a
 * single Runtime.evaluate, a single CDP round-trip can carry N frames.
 *
 * Compare on canvas-raf.html (pure RAF workload, 400×240):
 *   A) Frame-by-frame via Renderer — baseline (Tier 2 ceiling)
 *   B) Combined advance + toDataURL in 1 Runtime.evaluate per frame
 *   C) Batched return-array loop (N frames → 1 CDP call → array of data URLs)
 *   D) Batched with addBinding streaming (N frames → 1 CDP call → N events)
 *   E) Advance-only floor (no capture, no toDataURL — paint work only)
 */
import { chromium } from 'playwright';
import { Renderer, VIRTUAL_CLOCK_SCRIPT } from '../src/index.ts';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const DIR = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURE = `file://${resolve(DIR, '../test/fixtures/canvas-raf.html')}`;

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    min: s[0],
  };
}
const fmt = (n) => n.toFixed(2).padStart(6);

const STEP = 500;
const FRAMES = 80;
const WARMUP = 10;

async function withPage(fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT);
    await page.goto(FIXTURE);
    await page.waitForFunction(() => window.__READY === true);
    const cdp = await page.context().newCDPSession(page);
    // Prime 1 RAF tick so the canvas has initial content
    await cdp.send('Runtime.evaluate', {
      expression: '(()=>{let r=16;while(r>0){const c=r<16?r:16;window.__virtualTime.advance(c);r-=c;}})()',
    });
    return { browser, page, cdp, fn: async () => fn({ browser, page, cdp }) };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

// A) Baseline — current Renderer frame-by-frame path
async function benchA() {
  const ctx = await withPage(async () => {});
  const { browser, page } = ctx;
  try {
    const renderer = await Renderer.create(page);
    renderer.setQuality(80).setFormat('jpeg').setCanvasTarget('#scene');
    for (let i = 0; i < WARMUP; i++) {
      await renderer.advance(STEP);
      await renderer.capture();
    }
    const advs = [], caps = [];
    const wallStart = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      const t0 = performance.now();
      await renderer.advance(STEP);
      const t1 = performance.now();
      await renderer.capture();
      advs.push(t1 - t0);
      caps.push(performance.now() - t1);
    }
    const wall = performance.now() - wallStart;
    await renderer.close();
    return { label: 'A baseline renderer', advs, caps, wall, frames: FRAMES };
  } finally {
    await browser.close();
  }
}

// B) Combined: advance + toDataURL in 1 Runtime.evaluate
async function benchB() {
  const ctx = await withPage(async () => {});
  const { browser, cdp } = ctx;
  try {
    const expr = `(()=>{
      let r=${STEP};
      while(r>0){const c=r<16?r:16;window.__virtualTime.advance(c);r-=c;}
      return document.querySelector('#scene').toDataURL('image/jpeg',0.8);
    })()`;
    for (let i = 0; i < WARMUP; i++) {
      await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    }
    const caps = [];
    const wallStart = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      const t1 = performance.now();
      const res = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      // Parse to simulate real work
      const dataUrl = res.result.value;
      const comma = dataUrl.indexOf(',');
      Buffer.from(dataUrl.slice(comma + 1), 'base64');
      caps.push(performance.now() - t1);
    }
    const wall = performance.now() - wallStart;
    return { label: 'B combined eval   ', advs: null, caps, wall, frames: FRAMES };
  } finally {
    await browser.close();
  }
}

// C) Batched return array
async function benchC(batch) {
  const ctx = await withPage(async () => {});
  const { browser, cdp } = ctx;
  try {
    const expr = `(()=>{
      const out=[];
      for(let f=0;f<${batch};f++){
        let r=${STEP};
        while(r>0){const c=r<16?r:16;window.__virtualTime.advance(c);r-=c;}
        out.push(document.querySelector('#scene').toDataURL('image/jpeg',0.8));
      }
      return out;
    })()`;
    // Warmup with small batch
    for (let i = 0; i < 2; i++) {
      await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    }
    const caps = [];
    const batches = Math.ceil(FRAMES / batch);
    const wallStart = performance.now();
    let captured = 0;
    for (let b = 0; b < batches && captured < FRAMES; b++) {
      const t1 = performance.now();
      const res = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      const arr = res.result.value;
      for (const dataUrl of arr) {
        const comma = dataUrl.indexOf(',');
        Buffer.from(dataUrl.slice(comma + 1), 'base64');
      }
      const per = (performance.now() - t1) / batch;
      for (let k = 0; k < batch; k++) caps.push(per);
      captured += batch;
    }
    const wall = performance.now() - wallStart;
    return { label: `C batch=${String(batch).padStart(2)} array`, advs: null, caps, wall, frames: batches * batch };
  } finally {
    await browser.close();
  }
}

// D) Batched streaming via Runtime.addBinding + Runtime.bindingCalled events
async function benchD(batch) {
  const ctx = await withPage(async () => {});
  const { browser, cdp } = ctx;
  try {
    await cdp.send('Runtime.addBinding', { name: '__overcrankFrame' });
    const frames = [];
    const onBinding = (params) => {
      if (params.name === '__overcrankFrame') {
        const dataUrl = params.payload;
        const comma = dataUrl.indexOf(',');
        frames.push(Buffer.from(dataUrl.slice(comma + 1), 'base64'));
      }
    };
    cdp.on('Runtime.bindingCalled', onBinding);

    const expr = `(()=>{
      for(let f=0;f<${batch};f++){
        let r=${STEP};
        while(r>0){const c=r<16?r:16;window.__virtualTime.advance(c);r-=c;}
        window.__overcrankFrame(document.querySelector('#scene').toDataURL('image/jpeg',0.8));
      }
    })()`;
    // Warmup
    for (let i = 0; i < 2; i++) {
      await cdp.send('Runtime.evaluate', { expression: expr });
    }
    frames.length = 0;

    const caps = [];
    const batches = Math.ceil(FRAMES / batch);
    const wallStart = performance.now();
    let captured = 0;
    for (let b = 0; b < batches && captured < FRAMES; b++) {
      const t1 = performance.now();
      const before = frames.length;
      await cdp.send('Runtime.evaluate', { expression: expr });
      // Wait until all binding events have flushed (they arrive interleaved)
      const deadline = performance.now() + 1000;
      while (frames.length < before + batch && performance.now() < deadline) {
        await new Promise((r) => setImmediate(r));
      }
      const per = (performance.now() - t1) / batch;
      for (let k = 0; k < batch; k++) caps.push(per);
      captured += batch;
    }
    const wall = performance.now() - wallStart;
    cdp.off('Runtime.bindingCalled', onBinding);
    return { label: `D batch=${String(batch).padStart(2)} bind `, advs: null, caps, wall, frames: batches * batch };
  } finally {
    await browser.close();
  }
}

// E) Advance-only floor (no capture)
async function benchE() {
  const ctx = await withPage(async () => {});
  const { browser, cdp } = ctx;
  try {
    const expr = `(()=>{let r=${STEP};while(r>0){const c=r<16?r:16;window.__virtualTime.advance(c);r-=c;}return 0;})()`;
    for (let i = 0; i < WARMUP; i++) {
      await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    }
    const caps = [];
    const wallStart = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      const t1 = performance.now();
      await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      caps.push(performance.now() - t1);
    }
    const wall = performance.now() - wallStart;
    return { label: 'E advance only   ', advs: null, caps, wall, frames: FRAMES };
  } finally {
    await browser.close();
  }
}

function report({ label, advs, caps, wall, frames }) {
  const c = stats(caps);
  const speedup = (frames * STEP) / wall;
  const advStr = advs ? `adv p50 ${fmt(stats(advs).p50)} | ` : '';
  console.log(
    `  ${label.padEnd(20)} ${advStr}cap p50 ${fmt(c.p50)} min ${fmt(c.min)} | ${speedup.toFixed(2).padStart(8)}×`
  );
}

console.log('=== Tier 3: batched in-page capture on RAF workload ===');
console.log(`step=${STEP}ms, ${FRAMES} frames + ${WARMUP} warmup, 400×240 JPEG q80\n`);

report(await benchA());
report(await benchB());
for (const b of [5, 10, 20, 40]) report(await benchC(b));
for (const b of [5, 10, 20, 40]) report(await benchD(b));
report(await benchE());
