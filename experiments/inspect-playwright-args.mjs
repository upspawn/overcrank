/**
 * Print the actual command line Playwright uses to launch Chromium.
 * We want to know if --headless=new is in use, and whether our
 * BROWSER_ARGS land on the command line unchanged.
 */
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const OUR_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--disable-software-rasterizer',
  '--force-device-scale-factor=1',
  '--disable-frame-rate-limit',
];

const browser = await chromium.launch({
  headless: true,
  args: OUR_ARGS,
});

// Give chromium a moment to start, then find the process via ps.
// Playwright doesn't expose the child pid so we grep for our unique flag.
await new Promise((r) => setTimeout(r, 200));

try {
  // --force-device-scale-factor=1 is distinctive enough — find it
  const out = execSync(
    `ps -ax -o pid=,command= | grep -v grep | grep 'force-device-scale-factor=1' | grep -v 'Renderer' | grep -v 'GPU' | grep -v 'Utility' | head -1`,
    { encoding: 'utf8' },
  );
  // Chromium-like binaries get long command lines; split on space and print one arg per line.
  const args = out.trim().split(/\s+/);
  console.log(`\nArg count: ${args.length}`);
  console.log(`Binary: ${args[0]}\n`);

  // Highlight the ones we care about
  const wanted = [
    '--headless',
    '--headless=new',
    '--headless=old',
    '--disable-frame-rate-limit',
    '--disable-gpu',
    '--no-sandbox',
    '--use-gl',
    '--use-angle',
    '--disable-features',
    '--enable-features',
    '--user-data-dir',
    '--remote-debugging-',
  ];
  console.log('--- Flags of interest ---');
  for (const a of args.slice(1)) {
    if (wanted.some((w) => a.startsWith(w))) console.log('  ' + a);
  }
  console.log('\n--- All flags (first 40) ---');
  for (const a of args.slice(1, 41)) console.log('  ' + a);
  if (args.length > 41) console.log(`  ... (${args.length - 41} more)`);
} catch (e) {
  console.error('ps failed:', e.message);
}

await browser.close();
