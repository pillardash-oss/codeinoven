import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpeechHistoryPage, SpeechRecordingAttempt, SpeechScope } from '../../lib/speech/types'
import { DEFAULT_SPEECH_HISTORY_LIMIT, MAX_SPEECH_CHUNK_BYTES } from '../../lib/speech/types'
import { atomicWrite, getConfigRoot } from '../../lib/utils'

interface SpeechStorageIndex {
  version: 1
  attempts: SpeechRecordingAttempt[]
}

interface CaptureSession {
  id: string
  attemptId: string
  stagingPath: string
  handle: FileHandle
  byteSize: number
  startedAt: number
}

export interface SpeechCaptureStart {
  sessionId: string
  attempt: SpeechRecordingAttempt
}

/** App-owned streamed storage. Only opaque ids cross IPC; paths remain private. */
export class SpeechStorage {
  private readonly root: string
  private readonly recordingsDir: string
  private readonly stagingDir: string
  private readonly modelsDir: string
  private readonly indexPath: string
  private index: SpeechStorageIndex = { version: 1, attempts: [] }
  private readonly sessions = new Map<string, CaptureSession>()
  private writeChain: Promise<void> = Promise.resolve()

  constructor(root = join(getConfigRoot(), 'speech')) {
    this.root = root
    this.recordingsDir = join(root, 'recordings')
    this.stagingDir = join(root, 'staging')
    this.modelsDir = join(root, 'models')
    this.indexPath = join(root, 'history.json')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.recordingsDir, { recursive: true }),
      mkdir(this.stagingDir, { recursive: true }),
      mkdir(this.modelsDir, { recursive: true })
    ])
    try {
      const parsed: unknown = JSON.parse(await readFile(this.indexPath, 'utf8'))
      if (this.isStorageIndex(parsed)) this.index = parsed
    } catch (cause) {
      const code = cause instanceof Error && 'code' in cause ? String(cause.code) : ''
      if (code !== 'ENOENT') throw cause
    }
    await this.recoverInterruptedCaptures()
  }

  async beginCapture(scope: SpeechScope, mimeType: string): Promise<SpeechCaptureStart> {
    const id = randomUUID()
    const sessionId = randomUUID()
    const now = Date.now()
    const stagingPath = join(this.stagingDir, `${id}.${sessionId}.part`)
    const handle = await open(stagingPath, 'wx', 0o600)
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
      startedAt: now
    })
    this.index.attempts.push(attempt)
    await this.persistIndex()
    return { sessionId, attempt: structuredClone(attempt) }
  }

  async appendCapture(sessionId: string, chunk: Uint8Array): Promise<number> {
    if (chunk.byteLength === 0 || chunk.byteLength > MAX_SPEECH_CHUNK_BYTES) {
      throw new RangeError(`Audio chunks must contain 1-${MAX_SPEECH_CHUNK_BYTES} bytes.`)
    }
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Capture session is stale or unknown.')
    await session.handle.write(chunk)
    session.byteSize += chunk.byteLength
    return session.byteSize
  }

  async finalizeCapture(sessionId: string, durationMs: number): Promise<SpeechRecordingAttempt> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Capture session is stale or unknown.')
    this.sessions.delete(sessionId)
    await session.handle.sync()
    await session.handle.close()
    const audioId = randomUUID()
    const finalPath = this.audioPath(audioId)
    await rename(session.stagingPath, finalPath)
    const attempt = this.requireAttempt(session.attemptId)
    attempt.audioId = audioId
    attempt.audioAvailable = true
    attempt.byteSize = session.byteSize
    attempt.durationMs = Math.max(0, Math.round(durationMs))
    attempt.stage = 'stopping'
    attempt.updatedAt = Date.now()
    await this.persistIndex()
    return structuredClone(attempt)
  }

  async failCapture(sessionId: string, message: string): Promise<SpeechRecordingAttempt> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Capture session is stale or unknown.')
    this.sessions.delete(sessionId)
    await session.handle.close().catch(() => undefined)
    const attempt = this.requireAttempt(session.attemptId)
    if (session.byteSize > 0) {
      const audioId = randomUUID()
      await rename(session.stagingPath, this.audioPath(audioId))
      attempt.audioId = audioId
      attempt.audioAvailable = true
    } else {
      await rm(session.stagingPath, { force: true })
    }
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
    await this.persistIndex()
    await Promise.all(
      evicted.map((attempt) =>
        attempt.audioId ? rm(this.audioPath(attempt.audioId), { force: true }) : Promise.resolve()
      )
    )
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    for (const session of sessions) {
      await session.handle.close().catch(() => undefined)
      const attempt = this.requireAttempt(session.attemptId)
      if (session.byteSize > 0) {
        const audioId = randomUUID()
        await rename(session.stagingPath, this.audioPath(audioId)).catch(() => undefined)
        attempt.audioId = audioId
        attempt.audioAvailable = true
      } else {
        await rm(session.stagingPath, { force: true })
      }
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

  private async persistIndex(): Promise<void> {
    const payload = `${JSON.stringify(this.index, null, 2)}\n`
    this.writeChain = this.writeChain.then(() => atomicWrite(this.indexPath, payload))
    await this.writeChain
  }

  private isStorageIndex(value: unknown): value is SpeechStorageIndex {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Record<string, unknown>
    return candidate['version'] === 1 && Array.isArray(candidate['attempts'])
  }

  private async recoverInterruptedCaptures(): Promise<void> {
    const entries = await readdir(this.stagingDir, { withFileTypes: true })
    let changed = false
    for (const entry of entries) {
      const match = /^([a-f0-9-]{36})\.[a-f0-9-]{36}\.part$/u.exec(entry.name)
      if (!entry.isFile() || !match) continue
      const attempt = this.index.attempts.find((item) => item.id === match[1])
      const stagingPath = join(this.stagingDir, entry.name)
      if (!attempt) {
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
    if (changed) await this.persistIndex()
  }
}
