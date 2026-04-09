/**
 * Chrome Canary + html-in-canvas (WICG) support — experimental.
 *
 * Chrome Canary ships an experimental API (`drawElementImage`) that rasterizes
 * HTML elements directly into a `<canvas>` buffer. Combined with overcrank's
 * virtual clock, this lets you compose HTML + WebGL + canvas 2D into a single
 * captured frame, faster than real-time.
 *
 * Status: experimental. Only Chrome Canary, gated behind `--enable-features=CanvasDrawElement`.
 * The API can change or be removed at any time. See:
 * https://github.com/WICG/html-in-canvas
 *
 * Usage:
 *
 * ```ts
 * import { chromium } from 'playwright'
 * import { Renderer, VIRTUAL_CLOCK_SCRIPT, findChromeCanary, CANARY_DRAW_ELEMENT_ARGS } from 'overcrank'
 *
 * const canaryPath = findChromeCanary()
 * if (!canaryPath) throw new Error('Chrome Canary not found')
 *
 * const browser = await chromium.launch({
 *   executablePath: canaryPath,
 *   args: CANARY_DRAW_ELEMENT_ARGS,
 * })
 * // ... same Renderer flow as usual
 * ```
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

/**
 * Chromium command-line args required to enable the experimental
 * `drawElementImage` / `layoutsubtree` / canvas `paint` event APIs.
 *
 * The `CanvasDrawElement` feature flag is the PascalCase equivalent of the
 * `chrome://flags/#canvas-draw-element` flag. Must be passed to Chrome Canary.
 */
export const CANARY_DRAW_ELEMENT_ARGS: readonly string[] = [
  '--enable-features=CanvasDrawElement',
  '--no-first-run',
  '--no-default-browser-check',
]

/**
 * Well-known Chrome Canary install paths for each supported platform.
 * Checked in order.
 */
const CANARY_PATHS: Record<NodeJS.Platform, string[]> = {
  darwin: [
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  linux: [
    '/opt/google/chrome-canary/chrome',
    '/usr/bin/google-chrome-canary',
  ],
  win32: [
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome SxS\\Application\\chrome.exe`,
  ],
  aix: [], android: [], freebsd: [], haiku: [], openbsd: [],
  sunos: [], cygwin: [], netbsd: [],
}

/**
 * Find the Chrome Canary binary on the current platform.
 * Returns the absolute path if found, `null` otherwise.
 */
export function findChromeCanary(): string | null {
  const candidates = CANARY_PATHS[process.platform] ?? []
  for (const path of candidates) {
    if (path && existsSync(path)) return path
  }

  // Fallback: shell lookup on Linux
  if (process.platform === 'linux') {
    try {
      const which = execSync('command -v google-chrome-canary 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 2000,
      }).trim()
      if (which && existsSync(which)) return which
    } catch {}
  }

  return null
}

/**
 * Check if Chrome Canary with the html-in-canvas feature is available on this
 * machine. Does not probe the actual feature — presence of the binary is enough.
 */
export function hasHtmlInCanvasSupport(): boolean {
  return findChromeCanary() !== null
}
