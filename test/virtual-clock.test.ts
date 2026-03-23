import { describe, test, expect } from 'bun:test'
import { chromium } from 'playwright'
import { VIRTUAL_CLOCK_SCRIPT } from '../src/virtual-clock'

describe('virtual-clock', () => {
  test('exports a non-empty script string', () => {
    expect(typeof VIRTUAL_CLOCK_SCRIPT).toBe('string')
    expect(VIRTUAL_CLOCK_SCRIPT.length).toBeGreaterThan(100)
  })

  test('script contains expected API surface', () => {
    expect(VIRTUAL_CLOCK_SCRIPT).toContain('__virtualTime')
    expect(VIRTUAL_CLOCK_SCRIPT).toContain('advance')
    expect(VIRTUAL_CLOCK_SCRIPT).toContain('requestAnimationFrame')
    expect(VIRTUAL_CLOCK_SCRIPT).toContain('performance.now')
    expect(VIRTUAL_CLOCK_SCRIPT).toContain('setTimeout')
    expect(VIRTUAL_CLOCK_SCRIPT).toContain('setInterval')
    expect(VIRTUAL_CLOCK_SCRIPT).toContain('Date')
  })
})

describe('virtual-clock in browser', () => {
  test('advances time and fires RAF', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
    await page.goto('about:blank')

    await page.evaluate(() => (window as any).__virtualTime.advance(1000))

    const now = await page.evaluate(() => performance.now())
    expect(now).toBe(1000)

    const dateNow = await page.evaluate(() => {
      const start = Date.now()
      ;(window as any).__virtualTime.advance(500)
      return Date.now() - start
    })
    expect(dateNow).toBe(500)

    await browser.close()
  })

  test('fires setTimeout at correct virtual time', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.addInitScript(VIRTUAL_CLOCK_SCRIPT)
    await page.goto('about:blank')

    const result = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        let fired = false
        setTimeout(() => { fired = true }, 500)

        ;(window as any).__virtualTime.advance(400)
        if (fired) { resolve(false); return }

        ;(window as any).__virtualTime.advance(200)
        resolve(fired)
      })
    })

    expect(result).toBe(true)
    await browser.close()
  })
})
