import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SpeechHistoryPage,
  SpeechRecordingAttempt,
  SpeechPlaybackAudio,
  SpeechScope
} from '../../lib/speech/types'
import { DEFAULT_SPEECH_HISTORY_LIMIT, MAX_SPEECH_CHUNK_BYTES } from '../../lib/speech/types'
import { atomicWrite, getConfigRoot } from '../../lib/utils'
import { Logger } from '../system/logger'
import {
  CAPTURE_OWNER_SUFFIX,
  claimCaptureOwner,
  isCaptureOwnerAlive,
  readCaptureOwner,
  releaseCaptureOwner
} from './capture-ownership'
import { RecordingPlaybackAudio } from './playback-audio'

/**
 * How many deleted attempt ids the index remembers, so a sibling that still
 * holds an older copy of the history cannot resurrect a recording the user
 * deleted. Deletions are user actions, so this covers far more than a session.
 */
const MAX_REMOVED_ATTEMPT_IDS = 512

interface SpeechStorageIndex {
  version: 1
  attempts: SpeechRecordingAttempt[]
  /**
   * Attempt ids some instance deleted. Carried in the file itself because every
   * instance rewrites the whole index: without the tombstone, the next write
   * from a sibling that had not seen the deletion would restore the row.
   */
  removedIds?: string[]
}

interface CaptureSession {
  id: string
  attemptId: string
  stagingPath: string
  handle: FileHandle | null
  byteSize: number
  startedAt: number
  lastDiskCheckBytes: number
}

export interface SpeechCaptureStart {
  sessionId: string
  attempt: SpeechRecordingAttempt
}

export interface NativeSpeechCaptureStart extends SpeechCaptureStart {
  stagingPath: string
}

/** App-owned streamed storage. Only opaque ids cross IPC; paths remain private. */
export class SpeechStorage {
  private readonly root: string
  private readonly recordingsDir: string
  private readonly stagingDir: string
  private readonly modelsDir: string
  private readonly indexPath: string
  private readonly playback: RecordingPlaybackAudio
  private index: SpeechStorageIndex = { version: 1, attempts: [] }
  private readonly sessions = new Map<string, CaptureSession>()
  private writeChain: Promise<void> = Promise.resolve()

  constructor(root = join(getConfigRoot(), 'speech')) {
    this.root = root
    this.recordingsDir = join(root, 'recordings')
    this.stagingDir = join(root, 'staging')
    this.modelsDir = join(root, 'models')
    this.indexPath = join(root, 'history.json')
    // Prepared playback copies live outside `recordings/` so that directory
    // only ever holds exactly one file per recording.
    this.playback = new RecordingPlaybackAudio(join(root, 'playback'))
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.recordingsDir, { recursive: true }),
      mkdir(this.stagingDir, { recursive: true }),
      mkdir(this.modelsDir, { recursive: true })
    ])
    try {
      this.index = (await this.readIndexFromDisk()) ?? this.index
    } catch (cause) {
      // Only an unreadable-but-present history is fatal to speech startup: a
      // missing one is a fresh install.
      Logger.error('Speech history could not be read:', cause)
      throw cause
    }
    await this.recoverAbandonedCaptures()
    await this.playback.prune(
      new Set(
        this.index.attempts
          .map((attempt) => attempt.audioId)
          .filter((audioId): audioId is string => Boolean(audioId))
      )
    )
  }

  async beginCapture(scope: SpeechScope, mimeType: string): Promise<SpeechCaptureStart> {
    const id = randomUUID()
    const sessionId = randomUUID()
    const now = Date.now()
    const stagingPath = join(this.stagingDir, `${id}.${sessionId}.part`)
    // Ownership is claimed before the file exists: a sibling instance scanning
    // the staging directory must never find a capture that names no owner.
    await claimCaptureOwner(stagingPath)
    const handle = await open(stagingPath, 'wx', 0o600).catch(async (cause: unknown) => {
      await releaseCaptureOwner(stagingPath)
      throw cause
    })
    const attempt: SpeechRecordingAttempt = {
      id,
      createdAt: now,
      updatedAt: now,
      stage: 'recording',
      scope,
      audioAvailable: false,
      byteSize: 0,
      mimeType,
      retries: [],
      errors: []
    }
    this.sessions.set(sessionId, {
      id: sessionId,
      attemptId: id,
      stagingPath,
      handle,
      byteSize: 0,
      startedAt: now,
      lastDiskCheckBytes: 0
    })
    this.index.attempts.push(attempt)
    await this.persistIndex()
    await this.enforceHistoryLimit()
    return { sessionId, attempt: structuredClone(attempt) }
  }

  async beginNativeCapture(scope: SpeechScope): Promise<NativeSpeechCaptureStart> {
    const id = randomUUID()
    const sessionId = randomUUID()
    const now = Date.now()
    const stagingPath = join(this.stagingDir, `${id}.${sessionId}.part`)
    await claimCaptureOwner(stagingPath)
    const handle = await open(stagingPath, 'wx', 0o600).catch(async (cause: unknown) => {
      await releaseCaptureOwner(stagingPath)
      throw cause
    })
    await handle.close()
    const attempt: SpeechRecordingAttempt = {
      id,
      createdAt: now,
      updatedAt: now,
      stage: 'recording',
      scope,
      audioAvailable: false,
      byteSize: 0,
      // The native worker writes Core Audio Format LPCM (AVFoundation falls
      // back to CAF for the extension-less staging path), not WAV.
      mimeType: 'audio/x-caf',
      retries: [],
      errors: []
    }
    this.sessions.set(sessionId, {
      id: sessionId,
      attemptId: id,
      stagingPath,
      handle: null,
      byteSize: 0,
      startedAt: now,
      lastDiskCheckBytes: 0
    })
    this.index.attempts.push(attempt)
    await this.persistIndex()
    await this.enforceHistoryLimit()
    return { sessionId, attempt: structuredClone(attempt), stagingPath }
  }

  async recordPermissionFailure(
    scope: SpeechScope,
    message: string
  ): Promise<SpeechRecordingAttempt> {
    const now = Date.now()
    const attempt: SpeechRecordingAttempt = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      stage: 'failed',
      scope,
      audioAvailable: false,
      byteSize: 0,
      retries: [],
      errors: [
        {
          stage: 'permission',
          occurredAt: now,
          error: { code: 'permission-denied', message, retryable: true }
        }
      ]
    }
    this.index.attempts.push(attempt)
    await this.persistIndex()
    await this.enforceHistoryLimit()
    return structuredClone(attempt)
  }

  async appendCapture(sessionId: string, chunk: Uint8Array): Promise<number> {
    if (chunk.byteLength === 0 || chunk.byteLength > MAX_SPEECH_CHUNK_BYTES) {
      throw new RangeError(`Audio chunks must contain 1-${MAX_SPEECH_CHUNK_BYTES} bytes.`)
    }
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Capture session is stale or unknown.')
    if (!session.handle) throw new Error('This capture is owned by the native recorder.')
    if (session.byteSize - session.lastDiskCheckBytes >= 8 * 1024 * 1024) {
      const filesystem = await statfs(this.root)
      const availableBytes = filesystem.bavail * filesystem.bsize
      if (availableBytes < 64 * 1024 * 1024) {
        throw new Error('Insufficient disk space to continue recording.')
      }
      session.lastDiskCheckBytes = session.byteSize
    }
    await session.handle.write(chunk)
    session.byteSize += chunk.byteLength
    return session.byteSize
  }

  async finalizeCapture(sessionId: string, durationMs: number): Promise<SpeechRecordingAttempt> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Capture session is stale or unknown.')
    this.sessions.delete(sessionId)
    if (session.handle) {
      await session.handle.sync()
      await session.handle.close()
    } else {
      session.byteSize = (await stat(session.stagingPath)).size
    }
    const audioId = randomUUID()
    const finalPath = this.audioPath(audioId)
    const stored = await rename(session.stagingPath, finalPath).then(
      () => true,
      async (cause: unknown) => {
        if (!isMissingFile(cause)) throw cause
        return false
      }
    )
    await releaseCaptureOwner(session.stagingPath)
    const attempt = this.requireAttempt(session.attemptId)
    if (stored) {
      attempt.audioId = audioId
    } else {
      // The staging file is gone from under this capture: another instance
      // settled it while this one was still recording. The bytes are still
      // whole, because a rename carries the open handle with it, so the audio
      // that other instance pointed at is this recording and finishing is
      // preferable to throwing away a transcript the user just spoke.
      const settled = await this.foreignAudioFor(session.attemptId)
      if (!settled) throw new Error('The recording audio could not be finalized.')
      attempt.audioId = settled
    }
    attempt.audioAvailable = true
    attempt.byteSize = session.byteSize
    attempt.durationMs = Math.max(0, Math.round(durationMs))
    attempt.stage = 'stopping'
    attempt.updatedAt = Date.now()
    await this.persistIndex()
    return structuredClone(attempt)
  }

  /**
   * The audio another instance stored for an attempt it settled on its own, so a
   * capture interrupted mid-flight can still reach a transcript.
   */
  private async foreignAudioFor(attemptId: string): Promise<string | null> {
    const onDisk = await this.readIndexFromDisk().catch(() => null)
    const attempt = onDisk?.attempts.find((item) => item.id === attemptId)
    if (!attempt?.audioId || !attempt.audioAvailable) return null
    const exists = await stat(this.audioPath(attempt.audioId)).then(
      () => true,
      () => false
    )
    return exists ? attempt.audioId : null
  }

  async failCapture(sessionId: string, message: string): Promise<SpeechRecordingAttempt> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Capture session is stale or unknown.')
    this.sessions.delete(sessionId)
    if (session.handle) await session.handle.close().catch(() => undefined)
    const attempt = this.requireAttempt(session.attemptId)
    if (session.byteSize > 0) {
      const audioId = randomUUID()
      await rename(session.stagingPath, this.audioPath(audioId))
      attempt.audioId = audioId
      attempt.audioAvailable = true
    } else {
      await rm(session.stagingPath, { force: true })
    }
    await releaseCaptureOwner(session.stagingPath)
    attempt.stage = 'failed'
    attempt.byteSize = session.byteSize
    attempt.updatedAt = Date.now()
    attempt.errors.push({
      stage: 'recording',
      occurredAt: attempt.updatedAt,
      error: { code: 'capture-device-lost', message, retryable: true }
    })
    await this.persistIndex()
    return structuredClone(attempt)
  }

  async updateAttempt(
    attemptId: string,
    update: (attempt: SpeechRecordingAttempt) => void
  ): Promise<SpeechRecordingAttempt> {
    const attempt = this.requireAttempt(attemptId)
    update(attempt)
    attempt.updatedAt = Date.now()
    await this.persistIndex()
    return structuredClone(attempt)
  }

  getAttempt(attemptId: string): SpeechRecordingAttempt | undefined {
    const attempt = this.index.attempts.find((item) => item.id === attemptId)
    return attempt ? structuredClone(attempt) : undefined
  }

  getAudioPath(attemptId: string): string {
    const attempt = this.requireAttempt(attemptId)
    if (!attempt.audioAvailable || !attempt.audioId)
      throw new Error('Recording audio is unavailable.')
    return this.audioPath(attempt.audioId)
  }

  modelDirectory(artifactId: string): string {
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(artifactId)) throw new Error('Invalid artifact id.')
    return join(this.modelsDir, artifactId)
  }

  stagingFile(name: string): string {
    if (!/^[a-z0-9][a-z0-9._-]{2,180}$/u.test(name)) throw new Error('Invalid staging name.')
    return join(this.stagingDir, name)
  }

  async listHistory(cursor?: string, limit = 30): Promise<SpeechHistoryPage> {
    const bounded = Math.min(100, Math.max(1, Math.round(limit)))
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history cursor.')
    // Recordings the other instances made since this one started belong in the
    // list the user is looking at, so the page is served from the merged copy.
    await this.refreshFromDisk()
    const ordered = [...this.index.attempts].sort((a, b) => b.createdAt - a.createdAt)
    const items = ordered.slice(offset, offset + bounded).map((item) => structuredClone(item))
    const nextOffset = offset + items.length
    return {
      items,
      total: ordered.length,
      ...(nextOffset < ordered.length ? { nextCursor: String(nextOffset) } : {})
    }
  }

  async enforceHistoryLimit(limit = DEFAULT_SPEECH_HISTORY_LIMIT): Promise<void> {
    if (this.index.attempts.length <= limit) return
    const ordered = [...this.index.attempts].sort((a, b) => a.createdAt - b.createdAt)
    const evicted = ordered.slice(0, this.index.attempts.length - limit)
    const evictedIds = new Set(evicted.map((attempt) => attempt.id))
    this.index.attempts = this.index.attempts.filter((attempt) => !evictedIds.has(attempt.id))
    this.recordRemovals(evictedIds)
    await this.persistIndex()
    await Promise.all(evicted.map((attempt) => this.removeRecordedAudio(attempt.audioId)))
  }

  async deleteAttempt(attemptId: string, deleteAudio: boolean): Promise<void> {
    // A delete can name a recording a sibling made, so it is resolved against the
    // merged history rather than only what this process happens to remember.
    await this.refreshFromDisk()
    const attempt = this.requireAttempt(attemptId)
    this.index.attempts = this.index.attempts.filter((item) => item.id !== attemptId)
    this.recordRemovals(new Set([attemptId]))
    await this.persistIndex()
    if (deleteAudio) await this.removeRecordedAudio(attempt.audioId)
  }

  async deleteAllAttempts(): Promise<void> {
    await this.refreshFromDisk()
    const attempts = this.index.attempts
    this.index.attempts = []
    this.recordRemovals(new Set(attempts.map((attempt) => attempt.id)))
    await this.persistIndex()
    await Promise.all(attempts.map((attempt) => this.removeRecordedAudio(attempt.audioId)))
  }

  async readAudio(attemptId: string): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = await readFile(this.getAudioPath(attemptId))
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  }

  /**
   * Read a recording as something the renderer can actually play, together
   * with its true media type and extension: a container Chromium demuxes
   * natively is served as stored, anything else (the macOS CAF recordings) is
   * converted once through the bundled ffmpeg.
   */
  async readPlaybackAudio(attemptId: string): Promise<SpeechPlaybackAudio> {
    const attempt = this.requireAttempt(attemptId)
    if (!attempt.audioAvailable || !attempt.audioId) {
      throw new Error('Recording audio is unavailable.')
    }
    const resolved = await this.playback.resolve(this.audioPath(attempt.audioId), attempt.audioId)
    const bytes = await readFile(resolved.path)
    return {
      bytes: new Uint8Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      ),
      mimeType: resolved.mimeType,
      extension: resolved.extension
    }
  }

  /** Removes a recording's own bytes and any prepared playback copy of them. */
  private async removeRecordedAudio(audioId: string | undefined): Promise<void> {
    if (!audioId) return
    await Promise.all([
      rm(this.audioPath(audioId), { force: true }).catch(() => undefined),
      this.playback.remove(audioId)
    ])
  }

  async dispose(): Promise<void> {
    this.playback.dispose()
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    for (const session of sessions) {
      if (session.handle) await session.handle.close().catch(() => undefined)
      const attempt = this.requireAttempt(session.attemptId)
      if (session.byteSize > 0) {
        const audioId = randomUUID()
        await rename(session.stagingPath, this.audioPath(audioId)).catch(() => undefined)
        attempt.audioId = audioId
        attempt.audioAvailable = true
      } else {
        await rm(session.stagingPath, { force: true })
      }
      await releaseCaptureOwner(session.stagingPath)
      attempt.byteSize = session.byteSize
      attempt.stage = 'failed'
      attempt.updatedAt = Date.now()
      attempt.errors.push({
        stage: 'recording',
        occurredAt: attempt.updatedAt,
        error: {
          code: 'cancelled',
          message: 'Recording stopped because the application shut down.',
          retryable: attempt.audioAvailable
        }
      })
    }
    if (sessions.length > 0) await this.persistIndex()
    await this.writeChain
  }

  async audioSize(attemptId: string): Promise<number> {
    return (await stat(this.getAudioPath(attemptId))).size
  }

  private audioPath(audioId: string): string {
    return join(this.recordingsDir, `${audioId}.audio`)
  }

  private requireAttempt(attemptId: string): SpeechRecordingAttempt {
    const attempt = this.index.attempts.find((item) => item.id === attemptId)
    if (!attempt) throw new Error('Recording attempt was not found.')
    return attempt
  }

  /**
   * Write this process's history merged with whatever the other instances wrote.
   *
   * Two live instances share this one file and each rewrites it whole, so a
   * plain write from either of them silently drops every recording the other
   * made since it started. The merge keeps both sides: an attempt this process
   * has never seen is adopted, the copy with the later `updatedAt` wins for the
   * ones it does know, and an id any instance deleted stays deleted through the
   * tombstones the file itself carries.
   */
  private async persistIndex(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.writeMergedIndex())
    await this.writeChain
  }

  private async writeMergedIndex(): Promise<void> {
    await this.refreshFromDisk()
    await atomicWrite(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`)
  }

  /**
   * Fold the on-disk history into this process's copy.
   *
   * Every instance shares that one file, so what a sibling wrote is part of the
   * truth this instance has to answer from   for the history list as much as for
   * its own next write.
   */
  private async refreshFromDisk(): Promise<void> {
    try {
      const onDisk = await this.readIndexFromDisk()
      if (onDisk) this.mergeIndex(onDisk)
    } catch (error) {
      // An unreadable or corrupt copy must never cost this process its own
      // history: recovering that file is the next launch's job, not dictation's.
      Logger.error('Speech history could not be merged with the copies on disk:', error)
    }
  }

  private async readIndexFromDisk(): Promise<SpeechStorageIndex | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.indexPath, 'utf8'))
      return this.isStorageIndex(parsed) ? parsed : null
    } catch (cause) {
      const code = cause instanceof Error && 'code' in cause ? String(cause.code) : ''
      if (code === 'ENOENT') return null
      throw cause
    }
  }

  /** Fold the on-disk history into this process's copy, newest wins per attempt. */
  private mergeIndex(onDisk: SpeechStorageIndex): void {
    const removed = new Set([...(this.index.removedIds ?? []), ...(onDisk.removedIds ?? [])])
    this.index.removedIds = [...removed].slice(-MAX_REMOVED_ATTEMPT_IDS)
    if (removed.size > 0) {
      this.index.attempts = this.index.attempts.filter((attempt) => !removed.has(attempt.id))
    }
    for (const attempt of onDisk.attempts) {
      if (removed.has(attempt.id)) continue
      const known = this.index.attempts.find((item) => item.id === attempt.id)
      if (!known) {
        this.index.attempts.push(attempt)
        continue
      }
      if (attempt.updatedAt > known.updatedAt) Object.assign(known, attempt)
    }
  }

  /** Remember deleted ids so a sibling's stale copy cannot bring them back. */
  private recordRemovals(attemptIds: Set<string>): void {
    if (attemptIds.size === 0) return
    const removed = new Set([...(this.index.removedIds ?? []), ...attemptIds])
    this.index.removedIds = [...removed].slice(-MAX_REMOVED_ATTEMPT_IDS)
  }

  private isStorageIndex(value: unknown): value is SpeechStorageIndex {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Record<string, unknown>
    return candidate['version'] === 1 && Array.isArray(candidate['attempts'])
  }

  /**
   * Whether another live instance is recording right now.
   *
   * A process that is about to open the microphone for a warm-up must not do it
   * while a sibling is capturing: the input device can only take so many clients
   * before it renegotiates, and a renegotiation under a live capture is exactly
   * the interruption this storage is built to avoid.
   */
  async anotherInstanceIsRecording(): Promise<boolean> {
    const entries = await readdir(this.stagingDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !isCaptureStagingFile(entry.name)) continue
      const owner = await readCaptureOwner(join(this.stagingDir, entry.name))
      if (!owner || owner.pid === process.pid) continue
      if (isCaptureOwnerAlive(owner)) return true
    }
    return false
  }

  /**
   * Settle the staging files no live process is recording into any more.
   *
   * A staging file is ambiguous on its own, because another instance sharing this
   * config root writes its recordings into the same directory: it is either what
   * a process that died left behind, or a sibling's live capture. Every capture
   * names its owner, so this pass only reclaims what nobody holds: renaming a
   * live sibling's file away from under its open handle is what used to fail an
   * interrupted recording and strand its transcript.
   */
  private async recoverAbandonedCaptures(): Promise<void> {
    const entries = await readdir(this.stagingDir, { withFileTypes: true })
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))
    let changed = false
    for (const name of files) {
      const match = captureStagingAttemptId(name)
      if (!match) continue
      const stagingPath = join(this.stagingDir, name)
      const owner = await readCaptureOwner(stagingPath)
      if (owner && isCaptureOwnerAlive(owner)) {
        // A sibling instance is recording right now. Its attempt, its staging
        // file and its ownership record are all its own to settle.
        Logger.dev('Speech capture is owned by another live instance; leaving it alone', {
          pid: owner.pid
        })
        continue
      }
      const attempt = this.index.attempts.find((item) => item.id === match)
      if (!attempt) {
        await releaseCaptureOwner(stagingPath)
        await rm(stagingPath, { force: true })
        continue
      }
      if (attempt.stage !== 'recording') {
        // The attempt was settled by the process that owned it, so this file is
        // only what that settle could not finish removing.
        await releaseCaptureOwner(stagingPath)
        await rm(stagingPath, { force: true })
        continue
      }
      const byteSize = (await stat(stagingPath)).size
      if (byteSize > 0) {
        const audioId = randomUUID()
        await rename(stagingPath, this.audioPath(audioId))
        attempt.audioId = audioId
        attempt.audioAvailable = true
      } else {
        await rm(stagingPath, { force: true })
      }
      await releaseCaptureOwner(stagingPath)
      attempt.byteSize = byteSize
      attempt.stage = 'failed'
      attempt.updatedAt = Date.now()
      attempt.errors.push({
        stage: 'recording',
        occurredAt: attempt.updatedAt,
        error: {
          code: 'cancelled',
          message: 'Recording was interrupted by the previous application shutdown.',
          retryable: attempt.audioAvailable
        }
      })
      changed = true
    }
    // An ownership record with no capture left is what a process that died
    // between claiming and opening its file leaves behind.
    for (const name of files) {
      if (!name.endsWith(CAPTURE_OWNER_SUFFIX)) continue
      const partName = name.slice(0, -CAPTURE_OWNER_SUFFIX.length)
      if (files.has(partName)) continue
      const stagingPath = join(this.stagingDir, partName)
      const owner = await readCaptureOwner(stagingPath)
      if (owner && isCaptureOwnerAlive(owner)) continue
      await releaseCaptureOwner(stagingPath)
    }
    if (changed) await this.persistIndex()
  }
}

/** Whether a filesystem failure means the path is simply not there any more. */
function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
}

/** The attempt id a staging file belongs to, or `null` for anything else. */
function captureStagingAttemptId(name: string): string | null {
  return /^([a-f0-9-]{36})\.[a-f0-9-]{36}\.part$/u.exec(name)?.[1] ?? null
}

function isCaptureStagingFile(name: string): boolean {
  return captureStagingAttemptId(name) !== null
}
