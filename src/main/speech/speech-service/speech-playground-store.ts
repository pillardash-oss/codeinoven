import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { normalizePastedPath } from '../../../lib/speech/model-path-validation'
import type { SpeechAudioBytes } from '../../../lib/speech/types'

/** Audio file extensions accepted by the Sound Playground importer. */
const PLAYGROUND_AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'ogg',
  'oga',
  'm4a',
  'flac',
  'webm',
  'aac',
  'opus',
  'wma',
  'aif',
  'aiff'
])

/** Hard cap for a single playground audio source. */
const MAX_PLAYGROUND_AUDIO_BYTES = 200 * 1024 * 1024

export interface StagedPlaygroundAudio {
  path: string
  byteSize: number
  mimeType: string
}

/**
 * Ephemeral staging area for the Sound Playground. Copies live only in a
 * process-lifetime temp directory tracked in memory; nothing here is written
 * to speech history storage.
 */
export class SpeechPlaygroundStore {
  private readonly audio = new Map<string, StagedPlaygroundAudio>()

  private directory(): string {
    return join(tmpdir(), 'codeinoven-speech-playground')
  }

  /**
   * Stage renderer-recorded audio bytes for the ephemeral Sound Playground.
   * The copy lives only in a temp directory tracked in memory; it is never
   * written to speech history storage.
   */
  async stage(audio: Uint8Array, mimeType: string): Promise<{ token: string; byteSize: number }> {
    if (!(audio instanceof Uint8Array) || audio.byteLength === 0) {
      throw new RangeError('Audio is empty or invalid.')
    }
    if (audio.byteLength > MAX_PLAYGROUND_AUDIO_BYTES) {
      throw new RangeError('Audio is too large (limit 200 MB).')
    }
    const type = mimeType === '' ? 'audio/webm' : mimeType.slice(0, 128)
    await mkdir(this.directory(), { recursive: true })
    const token = randomUUID()
    const target = join(this.directory(), `playground-${token}.webm`)
    await writeFile(target, audio)
    this.audio.set(token, { path: target, byteSize: audio.byteLength, mimeType: type })
    return { token, byteSize: audio.byteLength }
  }

  /**
   * Import a user-picked audio file into the ephemeral Sound Playground. The
   * file is copied to the playground temp directory so nothing references the
   * original after the session ends.
   */
  async importFromPath(
    rawPath: string
  ): Promise<{ token: string; byteSize: number; fileName: string }> {
    const normalizedPath = normalizePastedPath(rawPath)
    if (!normalizedPath.normalized) throw new RangeError('The audio path is not allowed.')
    const extension = extname(normalizedPath.normalized).toLowerCase()
    if (!PLAYGROUND_AUDIO_EXTENSIONS.has(extension.replace(/^\./u, ''))) {
      throw new RangeError(`Unsupported audio file type "${extension || '(none)'}".`)
    }
    const original = await readFile(normalizedPath.normalized)
    if (original.byteLength === 0) throw new RangeError('The audio file is empty.')
    if (original.byteLength > MAX_PLAYGROUND_AUDIO_BYTES) {
      throw new RangeError('Audio is too large (limit 200 MB).')
    }
    await mkdir(this.directory(), { recursive: true })
    const token = randomUUID()
    const target = join(this.directory(), `playground-${token}.${extension}`)
    await writeFile(target, original)
    this.audio.set(token, {
      path: target,
      byteSize: original.byteLength,
      mimeType: `audio/${extension === '.mp3' ? 'mpeg' : extension.replace(/^\./u, '')}`
    })
    return { token, byteSize: original.byteLength, fileName: basename(normalizedPath.normalized) }
  }

  /** Read staged playground audio so the renderer can build a playback URL. */
  async read(token: string): Promise<SpeechAudioBytes> {
    const staged = this.resolve(token)
    return { bytes: new Uint8Array(await readFile(staged.path)), mimeType: staged.mimeType }
  }

  /** Resolve a staged entry, failing with the shared "no longer available" error. */
  resolve(token: string): StagedPlaygroundAudio {
    const staged = this.audio.get(token)
    if (!staged) {
      throw new Error('The playground audio is no longer available. Record or import it again.')
    }
    return staged
  }

  /** Delete a staged playground audio copy. Ephemeral by contract. */
  async discard(token: string): Promise<void> {
    const staged = this.audio.get(token)
    if (!staged) return
    this.audio.delete(token)
    await rm(staged.path, { force: true }).catch(() => undefined)
  }

  /** Remove every staged copy on shutdown. */
  async dispose(): Promise<void> {
    for (const staged of this.audio.values()) {
      await rm(staged.path, { force: true }).catch(() => undefined)
    }
    this.audio.clear()
  }
}
