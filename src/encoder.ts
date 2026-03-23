/**
 * FFmpeg integration — frame encoding and segment stitching.
 */

import { spawn } from 'node:child_process'
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
