/**
 * Reads the virtual clock script from the companion .js file.
 * The script is a standalone browser IIFE — it lives in a real .js file
 * so it gets syntax checking, linting, and can be tested independently.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const VIRTUAL_CLOCK_SCRIPT: string = readFileSync(
  join(__dirname, 'virtual-clock.js'),
  'utf-8',
)
