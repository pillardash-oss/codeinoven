import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Logger } from '../system/logger'
import { resolveFfmpegPath } from './ffmpeg-path'

/**
 * Playback-safe audio for the Speech history.
 *
 * A stored recording is exactly what the capture path produced. The macOS
 * native worker writes Core Audio Format (32-bit float PCM), and Chromium
 * cannot demux CAF   handing those bytes to an `<audio>` element fails with
 * "Failed to load because no supported source was found". Transcription never
 * noticed because the sherpa worker decodes through the bundled ffmpeg, which
 * reads CAF fine.
 *
 * This module resolves what a recording should be played *as*: containers
 * Chromium demuxes natively (WAV, WebM, Ogg, FLAC, MP3, MP4) are served as they
 * are, everything else is converted once to 16-bit PCM WAV through the same
 * bundled ffmpeg and cached next to the recordings, so the first play pays the
 * conversion and every replay is a plain file read.
 */

/** Enough leading bytes to identify every container this app can record. */
const HEADER_BYTES = 64

/** Only cached conversions are ever written, so the media type is fixed. */
export const PLAYBACK_WAV_MIME = 'audio/wav'
export const PLAYBACK_WAV_EXTENSION = '.wav'

/** A conversion that never reports back would otherwise strand a play request. */
const CONVERSION_TIMEOUT_MS = 120_000

/** Interrupted conversions leave a scratch file behind; sweep the old ones. */
const STALE_SCRATCH_MS = 60 * 60 * 1000

/** The media type and file extension a recording can be served with. */
export interface PlaybackAudioFormat {
  mimeType: string
  extension: string
}

/** A recording resolved to something a renderer media element can play. */
export interface ResolvedPlaybackAudio extends PlaybackAudioFormat {
  path: string
  /** True when the file is a cached conversion rather than the recording. */
  converted: boolean
}

function ascii(header: Uint8Array, offset: number, length: number): string | null {
  if (header.length < offset + length) return null
  let text = ''
  for (let index = offset; index < offset + length; index += 1) {
    text += String.fromCharCode(header[index] ?? 0)
  }
  return text
}

/**
 * Identify the container from its leading bytes.
 *
 * Deliberately conservative: only containers Chromium demuxes natively are
 * recognized, so anything unrecognized (CAF included, and any future capture
 * format) is converted instead of being served as bytes the player chokes on.
 */
export function sniffPlaybackFormat(header: Uint8Array): PlaybackAudioFormat | null {
  if (ascii(header, 0, 4) === 'RIFF' && ascii(header, 8, 4) === 'WAVE') {
    return { mimeType: 'audio/wav', extension: '.wav' }
  }
  if (ascii(header, 0, 4) === 'OggS') return { mimeType: 'audio/ogg', extension: '.ogg' }
  if (ascii(header, 0, 4) === 'fLaC') return { mimeType: 'audio/flac', extension: '.flac' }
  if (ascii(header, 0, 3) === 'ID3') return { mimeType: 'audio/mpeg', extension: '.mp3' }
  // Matroska/WebM EBML header, what MediaRecorder produces in this app.
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
    return { mimeType: 'audio/webm', extension: '.webm' }
  }
  // ISO base media container: an `ftyp` box directly after the size field.
  if (ascii(header, 4, 4) === 'ftyp') return { mimeType: 'audio/mp4', extension: '.m4a' }
  return null
}

async function readHeader(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = new Uint8Array(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function isUsableFile(path: string): Promise<boolean> {
  const details = await stat(path).catch(() => null)
  return details?.isFile() === true && details.size > 0
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owns the conversion cache for one recordings directory. Immutable recording
 * ids make the cache keys, so a cached conversion is never invalidated until
 * its recording is deleted.
 */
export class RecordingPlaybackAudio {
  private readonly cacheDirectory: string
  private readonly conversions = new Map<string, Promise<string>>()
  private readonly children = new Set<ChildProcess>()

  constructor(cacheDirectory: string) {
    this.cacheDirectory = cacheDirectory
  }

  /**
   * Resolve a stored recording to bytes a renderer media element can play.
   * Conversion happens once per recording and at most once at a time, so two
   * simultaneous plays of the same recording share one decoder process.
   */
  async resolve(sourcePath: string, audioId: string): Promise<ResolvedPlaybackAudio> {
    const direct = sniffPlaybackFormat(await readHeader(sourcePath))
    if (direct) return { ...direct, path: sourcePath, converted: false }

    const cachedPath = join(this.cacheDirectory, `${audioId}${PLAYBACK_WAV_EXTENSION}`)
    if (await isUsableFile(cachedPath)) {
      return {
        mimeType: PLAYBACK_WAV_MIME,
        extension: PLAYBACK_WAV_EXTENSION,
        path: cachedPath,
        converted: true
      }
    }

    const pending = this.conversions.get(audioId)
    const conversion = pending ?? this.startConversion(sourcePath, cachedPath, audioId)
    try {
      const path = await conversion
      return {
        mimeType: PLAYBACK_WAV_MIME,
        extension: PLAYBACK_WAV_EXTENSION,
        path,
        converted: true
      }
    } finally {
      if (!pending) this.conversions.delete(audioId)
    }
  }

  /** Called wherever a recording's own bytes are removed. */
  async remove(audioId: string): Promise<void> {
    const cachedPath = join(this.cacheDirectory, `${audioId}${PLAYBACK_WAV_EXTENSION}`)
    await rm(cachedPath, { force: true }).catch(() => undefined)
  }

  /**
   * Drop cache entries whose recording no longer exists, plus scratch files
   * left by an interrupted conversion. Bounded by the number of recordings.
   */
  async prune(knownAudioIds: ReadonlySet<string>): Promise<void> {
    const entries = await readdir(this.cacheDirectory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const path = join(this.cacheDirectory, entry.name)
      if (entry.name.endsWith(PLAYBACK_WAV_EXTENSION)) {
        const audioId = entry.name.slice(0, -PLAYBACK_WAV_EXTENSION.length)
        if (!knownAudioIds.has(audioId)) await rm(path, { force: true }).catch(() => undefined)
        continue
      }
      if (!entry.name.endsWith('.part')) continue
      const details = await stat(path).catch(() => null)
      if (details && Date.now() - details.mtimeMs > STALE_SCRATCH_MS) {
        await rm(path, { force: true }).catch(() => undefined)
      }
    }
  }

  /** Stop in-flight conversions when the app shuts down. */
  dispose(): void {
    for (const child of this.children) child.kill()
    this.children.clear()
    this.conversions.clear()
  }

  private startConversion(
    sourcePath: string,
    cachedPath: string,
    audioId: string
  ): Promise<string> {
    const conversion = this.convert(sourcePath, cachedPath)
      .then((path) => {
        Logger.dev(`[speech] prepared a recording for playback (${audioId.slice(0, 8)}).`)
        return path
      })
      .catch((error: unknown) => {
        throw new Error(
          `The stored recording could not be prepared for playback: ${describeError(error)}`
        )
      })
    this.conversions.set(audioId, conversion)
    // The stored map entry must never hold a rejection before a caller awaits it.
    void conversion.catch(() => undefined)
    return conversion
  }

  /**
   * Convert through the bundled ffmpeg into a scratch file, then publish it by
   * rename so a concurrent reader never sees a half-written WAV.
   */
  private async convert(sourcePath: string, cachedPath: string): Promise<string> {
    const decoderPath = await resolveFfmpegPath()
    await mkdir(this.cacheDirectory, { recursive: true })
    const scratchPath = `${cachedPath}.${randomUUID().slice(0, 12)}.part`
    try {
      await this.runDecoder(decoderPath, sourcePath, scratchPath)
      await rename(scratchPath, cachedPath)
      return cachedPath
    } catch (error) {
      await rm(scratchPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private runDecoder(decoderPath: string, sourcePath: string, outputPath: string): Promise<void> {
    const children = this.children
    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        decoderPath,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          sourcePath,
          '-vn',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          outputPath
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      children.add(child)
      let failure = ''
      let settled = false
      const timer = setTimeout(() => {
        child.kill()
        settle(new Error('Audio decoding timed out.'))
      }, CONVERSION_TIMEOUT_MS)
      function settle(error: Error | null): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        children.delete(child)
        if (error) reject(error)
        else resolve()
      }
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (failure.length < 2_000) failure += chunk
      })
      child.once('error', (error) => settle(error))
      child.once('close', () => settle(null))
      child.once('exit', (code: number | null) => {
        settle(
          code === 0
            ? null
            : new Error(failure.trim() || `Audio decoding exited with code ${code ?? 'unknown'}.`)
        )
      })
    })
  }
}
