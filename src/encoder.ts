/**
 * FFmpeg integration — frame encoding and segment stitching.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

/** Check if ffmpeg is installed and reachable. */
export async function checkFfmpeg(): Promise<boolean> {
  return new Promise((res) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'pipe' })
    proc.on('close', (code) => res(code === 0))
    proc.on('error', () => res(false))
  })
}

/** A frame entry for the concat demuxer. */
export interface FrameEntry {
  /** Absolute path to the frame image file */
  path: string
  /** Duration this frame is displayed, in seconds */
  durationS: number
}

/**
 * Encode a sequence of frame images into an MP4 video using ffmpeg concat demuxer.
 * Supports variable frame durations.
 */
export async function encodeFrames(
  frames: FrameEntry[],
  outputPath: string,
  options: {
    x264Preset?: string
    crf?: number
    fps?: number
  } = {},
): Promise<void> {
  const { x264Preset = 'veryfast', crf = 23, fps = 30 } = options

  const lines: string[] = []
  for (const frame of frames) {
    lines.push(`file '${resolve(frame.path)}'`)
    lines.push(`duration ${frame.durationS.toFixed(6)}`)
  }
  // Repeat last file to prevent ffmpeg from dropping the final frame
  if (frames.length > 0) {
    lines.push(`file '${resolve(frames[frames.length - 1].path)}'`)
  }

  const concatDir = resolve(outputPath, '..')
  const concatPath = join(concatDir, `overcrank-concat-${Date.now()}.txt`)
  await writeFile(concatPath, lines.join('\n') + '\n')

  try {
    await spawnFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      '-c:v', 'libx264',
      '-preset', x264Preset,
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-vsync', 'cfr',
      '-r', String(fps),
      resolve(outputPath),
    ])
  } finally {
    await rm(concatPath, { force: true })
  }
}

/**
 * Stitch multiple MP4 segments into a single output.
 * Copy-only — no re-encoding.
 */
export async function stitchSegments(
  segmentFiles: string[],
  outputPath: string,
  tmpDir: string,
): Promise<void> {
  const concatPath = join(tmpDir, 'concat-final.txt')
  const lines = segmentFiles.map((f) => `file '${resolve(f)}'`).join('\n')
  await writeFile(concatPath, lines)

  await spawnFfmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatPath,
    '-c', 'copy',
    resolve(outputPath),
  ])
}

/** Spawn ffmpeg and wait for completion. Throws on non-zero exit. */
function spawnFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) resolveP()
      else rejectP(new Error(`ffmpeg failed (exit ${code})\n${stderr.slice(-500)}`))
    })
    proc.on('error', rejectP)
  })
}

/**
 * Streaming encoder for fixed-FPS workflows — pipes frames directly to
 * ffmpeg's stdin instead of routing through tmp files + concat demuxer.
 *
 * Benefits vs `encodeFrames`:
 *   - No tmpdir (no disk I/O, no cleanup)
 *   - Capture and encoding overlap (ffmpeg starts encoding as soon as the
 *     first frame arrives; the browser can keep capturing in parallel)
 *   - Lower peak memory (frames don't pile up waiting for a final encode)
 *
 * Constraint: fixed frame rate only. For variable timestamps, use
 * `encodeFrames` with its concat-demuxer path (which supports variable
 * per-frame durations).
 */
export class StreamEncoder {
  private proc: ChildProcessWithoutNullStreams
  private stderr = ''
  private closed = false
  private exitPromise: Promise<void>

  constructor(
    outputPath: string,
    options: {
      fps: number
      format?: 'jpeg' | 'png'
      x264Preset?: string
      crf?: number
    },
  ) {
    const { fps, format = 'jpeg', x264Preset = 'veryfast', crf = 23 } = options

    // Use explicit pipe demuxers per format — more reliable than
    // auto-detect via `-f image2pipe`.
    const inputFormat = format === 'png' ? 'png_pipe' : 'jpeg_pipe'

    this.proc = spawn(
      'ffmpeg',
      [
        '-y',
        '-f', inputFormat,
        '-framerate', String(fps),
        '-i', '-',
        '-c:v', 'libx264',
        '-preset', x264Preset,
        '-crf', String(crf),
        '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-vsync', 'cfr',
        '-r', String(fps),
        resolve(outputPath),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams

    this.proc.stderr.on('data', (d: Buffer) => {
      this.stderr += d.toString()
      // Keep the tail only — ffmpeg prints per-frame progress lines and
      // we don't want to retain the whole log in memory on long renders.
      if (this.stderr.length > 4096) this.stderr = this.stderr.slice(-2048)
    })

    // Swallow stdin EPIPE before finish() attaches its handler — otherwise
    // an ffmpeg crash would surface as an unhandled 'error' event.
    this.proc.stdin.on('error', () => { /* reported via exitPromise */ })

    this.exitPromise = new Promise<void>((res, rej) => {
      this.proc.once('close', (code) => {
        if (code === 0) res()
        else rej(new Error(`ffmpeg failed (exit ${code})\n${this.stderr.slice(-500)}`))
      })
      this.proc.once('error', rej)
    })
  }

  /**
   * Write one encoded frame (JPEG or PNG bytes) to ffmpeg stdin.
   * Awaits the stream `drain` event under backpressure so callers
   * don't pile up buffers in memory on slower pipes.
   */
  writeFrame(data: Uint8Array | Buffer): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('StreamEncoder: writeFrame called after finish()'))
    }
    const stdin = this.proc.stdin
    if (stdin.destroyed || stdin.writableEnded) {
      return Promise.reject(
        new Error(`StreamEncoder: ffmpeg stdin closed unexpectedly\n${this.stderr.slice(-500)}`),
      )
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (stdin.write(buf)) return Promise.resolve()
    return new Promise<void>((res, rej) => {
      const onDrain = (): void => {
        stdin.off('error', onError)
        res()
      }
      const onError = (err: Error): void => {
        stdin.off('drain', onDrain)
        rej(err)
      }
      stdin.once('drain', onDrain)
      stdin.once('error', onError)
    })
  }

  /**
   * Close stdin and await ffmpeg exit. Throws on non-zero exit.
   * Idempotent — safe to call from error handlers.
   */
  async finish(): Promise<void> {
    if (this.closed) return this.exitPromise
    this.closed = true
    if (!this.proc.stdin.writableEnded) this.proc.stdin.end()
    return this.exitPromise
  }

  /** Kill ffmpeg without waiting. Use on error paths. */
  kill(): void {
    if (this.closed) return
    this.closed = true
    try { this.proc.kill('SIGKILL') } catch { /* already dead */ }
  }
}
