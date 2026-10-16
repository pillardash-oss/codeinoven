import { rename, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { probeVideo } from './video-inspection'
import { videoProcess } from './video-process'

/** What the composition says the exported file must be. */
export interface VideoExportExpectation {
  width: number
  height: number
  fps: number
  /** Seconds the composition runs. */
  duration: number
  /** `required` when the composition declares sound, `silent` when it declares none. */
  audio: 'required' | 'silent'
  /** Earliest second a declared track is heard, where the audibility window starts. */
  audioFrom: number
}

/** What the exported file turned out to be. */
export interface VideoExportCheck {
  bytes: number
  width: number
  height: number
  duration: number
  audio: 'audible' | 'silent'
  /** Peak level of the measured window in dB, null when nothing was measured. */
  peakDb: number | null
}

/**
 * A stream below this peak is digital silence rather than quiet sound. ffmpeg
 * reports an empty 16-bit track at -91 dB, and a real mix cleared through
 * `alimiter` never lands anywhere near it.
 */
const SILENCE_PEAK_DB = -70

/** Longest slice of sound measured for audibility. */
const AUDIO_WINDOW_SECONDS = 20

/** Seconds of slack allowed between the manifest's length and the file's. */
const DURATION_SLACK_SECONDS = 0.5

/**
 * What a damaged stream says while it is decoded. A truncated MP4 keeps its index
 * and still reports the manifest's length, and ffmpeg exits zero for it while
 * writing one of these lines to its report, so the report is the evidence that the
 * file is whole.
 */
const DAMAGE_PATTERNS = [
  /partial file/iu,
  /corrupt/iu,
  /invalid data/iu,
  /error while decoding/iu,
  /moov atom not found/iu,
  /truncating|truncated/iu
]

function damageIn(report: string, file: string): string | null {
  const line = report
    .split('\n')
    // Lines that name the file describe which input was opened, not damage in it.
    .filter((entry) => !entry.includes(file) && !entry.startsWith('Input #'))
    .find((entry) => DAMAGE_PATTERNS.some((pattern) => pattern.test(entry)))
  // ffmpeg prefixes a diagnostic with its component and an address, which is noise
  // in a sentence a user reads.
  return line ? line.trim().replace(/^\[[^\]]*\]\s*/u, '') : null
}

function display(root: string, file: string): string {
  return relative(root, file).replaceAll('\\', '/')
}

/**
 * Check one exported file against the composition it came from.
 *
 * An export is a claim that a playable file exists, and the claim is worth
 * checking rather than assuming: the renderer can finish with a container that has
 * no video stream, a frame size that drifted from the manifest, a tail that was cut
 * off, or a soundtrack that never reached the mix. Every one of those is invisible
 * in the exit code. The composition source is never touched, so a failure costs a
 * re-render rather than the work.
 *
 * The tail is what proves the file is whole, so the decode sample is taken from the
 * end: a stream that was cut short still decodes happily at the start. A successful
 * exit code is not proof on its own, because ffmpeg exits zero for a truncated MP4
 * whose index survived, so the report is read for damage as well.
 */
export async function checkVideoExport(
  root: string,
  file: string,
  expected: VideoExportExpectation,
  signal: AbortSignal
): Promise<VideoExportCheck> {
  const stats = await stat(file).catch(() => null)
  if (!stats?.isFile() || stats.size === 0)
    throw new Error(`The export produced no file at ${display(root, file)}.`)
  const info = await probeVideo(root, display(root, file), signal)
  if (info.width === null || info.height === null)
    throw new Error('The exported file has no video stream, so it cannot play.')
  if (info.width !== expected.width || info.height !== expected.height)
    throw new Error(
      `The exported file is ${info.width}x${info.height} while the composition declares ${expected.width}x${expected.height}.`
    )
  if (info.duration === null)
    throw new Error('The exported file reports no duration, so its timeline cannot be trusted.')
  const slack = Math.max(DURATION_SLACK_SECONDS, 3 / expected.fps)
  if (Math.abs(info.duration - expected.duration) > slack)
    throw new Error(
      `The exported file runs ${info.duration.toFixed(2)}s while the composition declares ${expected.duration}s.`
    )
  const tail = await videoProcess(
    ['-sseof', '-0.2', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'],
    root,
    signal
  )
  const damage = damageIn(tail, file)
  if (damage)
    throw new Error(
      `The exported file is not whole: ffmpeg reported "${damage}" while reading its last frame.`
    )
  const peak = info.hasAudio
    ? await measurePeak(root, file, expected.audioFrom, expected.duration, signal)
    : null
  const audible = peak !== null && peak > SILENCE_PEAK_DB
  if (expected.audio === 'required' && !info.hasAudio)
    throw new Error('The composition declares sound, but the exported file has no audio stream.')
  if (expected.audio === 'required' && !audible)
    throw new Error(
      `The composition declares sound, but the exported audio holds no level${peak === null ? '' : ` above ${peak.toFixed(1)} dB`}.`
    )
  if (expected.audio === 'silent' && audible)
    throw new Error(
      'The composition declares no sound, but the exported file contains audible audio.'
    )
  return {
    bytes: stats.size,
    width: info.width,
    height: info.height,
    duration: info.duration,
    audio: audible ? 'audible' : 'silent',
    peakDb: peak
  }
}

/**
 * Move a failed export aside so nothing downstream reads it as a deliverable.
 *
 * The file is the evidence for the failure, so it is renamed rather than deleted,
 * and the caller reports where it went. A cancelled job returns null and keeps the
 * render where it is, because the failure there is the cancellation.
 */
export async function keepFailedExport(
  root: string,
  file: string,
  target: string,
  signal: AbortSignal
): Promise<string | null> {
  if (signal.aborted) return null
  try {
    await rename(file, target)
    return display(root, target)
  } catch {
    return null
  }
}

/** Peak level of the declared sound, measured where the first track is heard. */
async function measurePeak(
  root: string,
  file: string,
  from: number,
  duration: number,
  signal: AbortSignal
): Promise<number | null> {
  const start = Math.max(0, Math.min(from, Math.max(0, duration - 0.1)))
  const length = Math.max(0.5, Math.min(AUDIO_WINDOW_SECONDS, duration - start))
  const report = await videoProcess(
    [
      '-ss',
      String(start),
      '-t',
      String(length),
      '-i',
      file,
      '-vn',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-'
    ],
    root,
    signal
  )
  const peak = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/u.exec(report)
  return peak ? Number(peak[1]) : null
}
