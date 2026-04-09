/**
 * renderMany — batched rendering with a bounded worker pool.
 * Verifies basic concurrency, error isolation, ordering, and that each
 * MP4 is independently produced.
 */
import { describe, test, expect } from 'bun:test'
import { renderMany } from '../src/index'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FIXTURE = `file://${join(import.meta.dir, 'fixtures', 'canvas-raf.html')}`
const BAD_FIXTURE = `file://${join(import.meta.dir, 'fixtures', 'does-not-exist.html')}`

describe('renderMany', () => {
  test('renders N independent jobs and returns ordered results', async () => {
    const out = join(tmpdir(), `rm-${Date.now()}`)
    await mkdir(out, { recursive: true })
    try {
      const jobs = [
        { url: FIXTURE, output: join(out, 'a.mp4'), options: { duration: 0.3, fps: 15, width: 160, height: 120 } },
        { url: FIXTURE, output: join(out, 'b.mp4'), options: { duration: 0.3, fps: 15, width: 160, height: 120 } },
        { url: FIXTURE, output: join(out, 'c.mp4'), options: { duration: 0.3, fps: 15, width: 160, height: 120 } },
      ]

      const results = await renderMany(jobs, { concurrency: 2 })
      expect(results).toHaveLength(3)

      for (let i = 0; i < 3; i++) {
        expect(results[i].index).toBe(i)
        expect(results[i].job.output).toBe(jobs[i].output)
        expect(results[i].ok).toBe(true)
        if (results[i].ok) {
          // @ts-expect-error — narrowed by ok check
          expect(results[i].stats.frames).toBeGreaterThan(0)
        }
        const s = await stat(jobs[i].output)
        expect(s.size).toBeGreaterThan(500)
      }
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  }, 120_000)

  test('isolates errors — one failing job does not break the batch', async () => {
    const out = join(tmpdir(), `rm-err-${Date.now()}`)
    await mkdir(out, { recursive: true })
    try {
      const jobs = [
        { url: FIXTURE, output: join(out, 'good.mp4'), options: { duration: 0.3, fps: 15, width: 160, height: 120 } },
        { url: BAD_FIXTURE, output: join(out, 'bad.mp4'), options: { duration: 0.3, fps: 15, width: 160, height: 120 } },
        { url: FIXTURE, output: join(out, 'good2.mp4'), options: { duration: 0.3, fps: 15, width: 160, height: 120 } },
      ]

      const results = await renderMany(jobs, { concurrency: 2 })
      expect(results).toHaveLength(3)
      expect(results[0].ok).toBe(true)
      expect(results[1].ok).toBe(false)
      expect(results[2].ok).toBe(true)
      if (!results[1].ok) {
        expect(results[1].error).toBeInstanceOf(Error)
      }
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  }, 120_000)

  test('onJobComplete fires once per job', async () => {
    const out = join(tmpdir(), `rm-cb-${Date.now()}`)
    await mkdir(out, { recursive: true })
    try {
      const jobs = [
        { url: FIXTURE, output: join(out, 'x.mp4'), options: { duration: 0.3, fps: 15, width: 160, height: 120 } },
        { url: FIXTURE, output: join(out, 'y.mp4'), options: { duration: 0.3, fps: 15, width: 160, height: 120 } },
      ]

      const seen: number[] = []
      await renderMany(jobs, {
        concurrency: 2,
        onJobComplete: (r) => { seen.push(r.index) },
      })
      expect(seen).toHaveLength(2)
      expect(seen.sort()).toEqual([0, 1])
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  }, 120_000)

  test('empty jobs array returns []', async () => {
    const results = await renderMany([])
    expect(results).toEqual([])
  })

  test('concurrency < 1 throws', async () => {
    await expect(renderMany([{ url: FIXTURE, output: '/tmp/x.mp4' }], { concurrency: 0 }))
      .rejects.toThrow('concurrency must be >= 1')
  })
})
