import { describe, test, expect } from 'bun:test'
import { checkFfmpeg, encodeFrames } from '../src/encoder'
import { writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'

describe('encoder', () => {
  test('checkFfmpeg returns true when installed', async () => {
    const result = await checkFfmpeg()
    expect(result).toBe(true)
  })

  test('encodeFrames produces a valid MP4 from dummy frames', async () => {
    const tmp = join(tmpdir(), `overcrank-enc-test-${Date.now()}`)
    await mkdir(tmp, { recursive: true })
    const output = join(tmp, 'test.mp4')

    // Create 5 dummy JPEG frames (solid color, minimal valid JPEG via ffmpeg)
    const frames = []
    for (let i = 0; i < 5; i++) {
      const path = join(tmp, `frame-${i}.jpg`)
      execSync(`ffmpeg -y -f lavfi -i color=c=red:s=64x64:d=0.04 -frames:v 1 "${path}"`, { stdio: 'pipe' })
      frames.push({ path, durationS: 0.1 })
    }

    await encodeFrames(frames, output, { x264Preset: 'ultrafast', crf: 28, fps: 10 })

    const st = await stat(output)
    expect(st.size).toBeGreaterThan(100)

    await rm(tmp, { recursive: true, force: true })
  }, 15_000)
})
