/**
 * Test: Does html-in-canvas (drawElementImage) work in headless Chrome Canary?
 *
 * Launches Canary headless with the CanvasDrawElement flag,
 * loads a page with layoutsubtree + drawElementImage, takes a screenshot.
 */
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const CANARY = '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary';
const TEST_PAGE = resolve(fileURLToPath(import.meta.url), '../test.html');
const SCREENSHOT_PATH = resolve(fileURLToPath(import.meta.url), '../screenshot.png');

// Use CDP via fetch to control headless Canary
const REMOTE_PORT = 9333;
const userDataDir = mkdtempSync(join(tmpdir(), 'canary-test-'));

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== HTML-in-Canvas Headless Experiment ===\n');

  // 1. Launch headless Canary with the flag
  console.log('Launching Chrome Canary headless with CanvasDrawElement flag...');
  const proc = Bun.spawn([
    CANARY,
    '--headless=new',
    '--enable-features=CanvasDrawElement',
    '--disable-gpu',
    `--remote-debugging-port=${REMOTE_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `file://${TEST_PAGE}`,
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Give it a moment to start
  await sleep(3000);

  try {
    // 2. Connect via CDP
    console.log('Connecting via CDP...');
    const res = await fetch(`http://127.0.0.1:${REMOTE_PORT}/json`);
    const targets = await res.json();
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('No page target found');

    const wsUrl = page.webSocketDebuggerUrl;
    console.log(`Connected to: ${page.url}\n`);

    // 3. Use WebSocket CDP to evaluate and screenshot
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    function cdp(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        const handler = (event) => {
          const data = JSON.parse(event.data);
          if (data.id === id) {
            ws.removeEventListener('message', handler);
            if (data.error) reject(new Error(JSON.stringify(data.error)));
            else resolve(data.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    // Enable Runtime
    await cdp('Runtime.enable');

    // Check if the page loaded and the API exists
    console.log('Checking API availability...');
    const readyCheck = await cdp('Runtime.evaluate', {
      expression: 'window.__HTML_IN_CANVAS_READY === true',
    });
    console.log(`  Page ready signal: ${readyCheck.result.value}`);

    const apiCheck = await cdp('Runtime.evaluate', {
      expression: `(() => {
        const c = document.getElementById('c');
        const ctx = c.getContext('2d');
        return {
          hasLayoutSubtree: c.hasAttribute('layoutsubtree'),
          hasDrawElementImage: typeof ctx.drawElementImage === 'function',
          canvasWidth: c.width,
          canvasHeight: c.height,
          childCount: c.children.length,
        };
      })()`,
      returnByValue: true,
    });
    console.log('  API check:', JSON.stringify(apiCheck.result.value, null, 2));

    // Try calling drawElementImage manually
    console.log('\nAttempting drawElementImage call...');
    const drawResult = await cdp('Runtime.evaluate', {
      expression: `(() => {
        try {
          const c = document.getElementById('c');
          const ctx = c.getContext('2d');
          const label = document.getElementById('label');
          ctx.clearRect(0, 0, 800, 400);
          ctx.fillStyle = '#1a1a2e';
          ctx.fillRect(0, 0, 800, 400);
          const result = ctx.drawElementImage(label, 50, 50);
          return { success: true, result: String(result) };
        } catch (e) {
          return { success: false, error: e.message, name: e.name };
        }
      })()`,
      returnByValue: true,
    });
    console.log('  drawElementImage result:', JSON.stringify(drawResult.result.value, null, 2));

    // 4. Take a screenshot
    console.log('\nTaking screenshot...');
    const screenshot = await cdp('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 800, height: 400, scale: 1 },
    });

    const imgBuffer = Buffer.from(screenshot.data, 'base64');
    writeFileSync(SCREENSHOT_PATH, imgBuffer);
    console.log(`Screenshot saved to: ${SCREENSHOT_PATH} (${imgBuffer.length} bytes)`);

    // Check if the screenshot has non-trivial content (not all white/black)
    // Simple heuristic: check file size - a blank 800x400 PNG is ~2-5KB, real content is larger
    console.log(`  File size suggests ${imgBuffer.length > 5000 ? 'REAL CONTENT rendered' : 'possibly blank/minimal content'}`);

    ws.close();

    console.log('\n=== Experiment Complete ===');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    // Cleanup
    proc.kill();
    await sleep(500);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

main();
