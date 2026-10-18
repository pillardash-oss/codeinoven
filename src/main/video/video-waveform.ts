import { mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { videoFolder } from './video-paths'
import { videoProcess } from './video-process'
import { probeVideo } from './video-inspection'

/** Where regenerable waveform pictures live inside a project. */
const WAVEFORM_CACHE = '.cio/tmp/video-waveforms'
/** A picture larger than this is not a waveform, and is not moved across IPC. */
const MAX_PICTURE_BYTES = 2 * 1024 * 1024
/** How many pictures one process keeps. Each holds a base64 PNG, so this is the
 *  only thing standing between a long session and an unbounded map. */
const MAX_CACHED_PICTURES = 48

/**
 * Waveform pictures already drawn, keyed by file and range.
 *
 * A timeline asks for its lanes' pictures every time it mounts, and a board is
 * remounted by an agent edit, so the answer is held instead of being drawn
 * again. One request per key is in flight at a time.
 */
const drawn = new Map<string, Promise<string | null>>()

/**
 * Draw a waveform for one audio source's used range, as a data URL.
 *
 * A lane needs a picture of the sound rather than its samples, and the app
 * cannot decode the file itself: the loopback preview origin sends no CORS
 * header, so a renderer-side `decodeAudioData` would read an opaque response.
 * ffmpeg can draw the picture without samples ever reaching the renderer, and it
 * draws a fixed 1200x240 mono image, so the lane is an image and the cost is one
 * bounded audio pass. A source with no audio stream answers null rather than
 * failing, because a lane is still a lane without a picture.
 *
 * `file` is an absolute path the caller has already checked against the project
 * root, the same form `videoFile` returns.
 */
export async function videoWaveformDataUrl(
  root: string,
  file: string,
  from: number,
  length: number,
  signal: AbortSignal
): Promise<string | null> {
  const source = relative(root, file).replaceAll('\\', '/')
  const key = `${root}|${source}|${from}|${length}`
  const cached = drawn.get(key)
  if (cached) return cached
  const task = draw(root, file, source, from, length, signal)
  // Oldest entry first: every edit to a track's trim or duration mints a new key,
  // so a session that keeps adjusting one lane would otherwise retain all of them.
  while (drawn.size >= MAX_CACHED_PICTURES) {
    const oldest = drawn.keys().next().value
    if (oldest === undefined) break
    drawn.delete(oldest)
  }
  drawn.set(key, task)
  task.catch(() => drawn.delete(key))
  return task
}

async function draw(
  root: string,
  file: string,
  source: string,
  from: number,
  length: number,
  signal: AbortSignal
): Promise<string | null> {
  const info = await probeVideo(root, source, signal)
  if (!info.hasAudio) return null
  // Regenerable scratch, so it lives in the swept `.cio/tmp` rather than beside the
  // composition: the app treats a cached picture as disposable.
  const folder = await videoFolder(root, WAVEFORM_CACHE).catch(async () => {
    await mkdir(join(root, WAVEFORM_CACHE), { recursive: true })
    return videoFolder(root, WAVEFORM_CACHE)
  })
  const output = join(
    folder,
    `${createHash('sha256').update(`${source}|${from}|${length}`).digest('hex').slice(0, 32)}.png`
  )
  await videoProcess(
    [
      '-ss',
      String(from),
      '-t',
      String(length),
      '-i',
      file,
      '-filter_complex',
      'aresample=8000,aformat=channel_layouts=mono,showwavespic=s=1200x240',
      '-frames:v',
      '1',
      '-y',
      output
    ],
    root,
    signal
  )
  const png = await readFile(output)
  if (png.length === 0 || png.length > MAX_PICTURE_BYTES) return null
  return `data:image/png;base64,${png.toString('base64')}`
}
