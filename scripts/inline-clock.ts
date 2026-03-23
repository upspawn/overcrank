/**
 * Reads virtual-clock.iife.js and inlines it into virtual-clock.ts as a string export.
 * Run after editing virtual-clock.iife.js: bun scripts/inline-clock.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const dir = join(dirname(new URL(import.meta.url).pathname), '..', 'src')
const js = readFileSync(join(dir, 'virtual-clock.iife.js'), 'utf-8')

// Strip the JSDoc header comment (everything before the IIFE)
const iife = js.slice(js.indexOf('(function'))

const ts = `/**
 * Virtual clock — injected into the browser page before any other scripts.
 *
 * The source of truth is virtual-clock.iife.js (lintable, syntax-checkable).
 * This file inlines it as a string for reliable module resolution
 * across Node, Bun, and npm package consumers.
 *
 * To update: edit virtual-clock.iife.js, then run \`bun scripts/inline-clock.ts\`
 */

/* eslint-disable max-len */
export const VIRTUAL_CLOCK_SCRIPT = \`${iife.trimEnd()}\`
`

writeFileSync(join(dir, 'virtual-clock.ts'), ts)
console.log('Inlined virtual-clock.iife.js → virtual-clock.ts')
