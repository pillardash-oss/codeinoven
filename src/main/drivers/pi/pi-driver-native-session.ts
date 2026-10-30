import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'path'
import type { AgentMessage } from '../../../lib/types'
import { Logger } from '../../system/logger'
import type { StorageEngine } from '../../storage/storage-engine'
import type { PersistentCliSession } from '../persistent-cli-driver'
import type { PiRpcClient } from '../pi-rpc-client'
import {
  findNativePiSessionFile,
  loadNativeSubagentMessages,
  nativePiSessionDir,
  parseNativePiSession,
  prefillTranscriptEntries
} from './pi-native-session'
import { record, stringValue } from './pi-values'

/** Everything the native transcript binding needs from the driver. */
export interface PiNativeSessionsHost {
  readonly agentDirectory: string | undefined
  readonly storage: StorageEngine
  hasClient(sessionId: string): boolean
  rpcClient(sessionId: string): PiRpcClient | undefined
  session(projectPath: string, sessionId: string): Promise<PersistentCliSession>
  persistSession(session: PersistentCliSession): Promise<void>
  sessionRecordPath(sessionId: string): string
  loadMirroredMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]>
  findLatestThreadSession(
    projectPath: string,
    threadId: string
  ): Promise<PersistentCliSession | null>
  markNativeSessionResumed(sessionId: string): void
  /** Retained live child transcript, when one is still in memory. */
  childSnapshot(sessionId: string): AgentMessage[] | undefined
  watchChildSession(sessionId: string): void
}

/**
 * Pi's own session transcript on disk: resuming it in a fresh RPC process,
 * reading it for a cold session, and binding a thread's session record to it.
 *
 * Without this, every driver-side process replacement (app restart, idle
 * dispose, crash) made the next turn a cold session: the engine's history recap
 * was the only context carrier, and models that see their prior work restated
 * without tool evidence treat it as fabricated and refuse to continue.
 */
export class PiNativeSessions {
  constructor(private readonly host: PiNativeSessionsHost) {}

  /**
   * Continue a previously persisted native pi session in the freshly spawned
   * RPC process by loading pi's own transcript file.
   *
   * Best-effort: any failure leaves the fresh session in place and the
   * engine's recap replay covers the gap.
   */
  async resumeNativePiSession(
    projectPath: string,
    sessionId: string,
    client: PiRpcClient
  ): Promise<void> {
    try {
      const session = await this.host.session(projectPath, sessionId)
      const nativeId = session.nativeSessionId
      if (!nativeId) return
      if (!existsSync(nativePiSessionDir(projectPath, this.host.agentDirectory))) return
      const file = await findNativePiSessionFile(projectPath, nativeId, this.host.agentDirectory)
      if (!file) return
      await client.switchSession(file)
      this.host.markNativeSessionResumed(sessionId)
      Logger.info('Resumed native Pi session transcript', { sessionId, nativeSessionId: nativeId })
    } catch (error) {
      Logger.dev('Native Pi session resume unavailable; continuing fresh:', error)
    }
  }

  /**
   * Remove pi's own transcript for a discarded session.
   *
   * An edited or deleted turn discards its session and keeps the surviving
   * mirror rows. The native transcript of that discarded session is what lets
   * its removed turns be re-read and re-persisted into the thread afterwards,
   * so it is deleted with the session record instead of being left on disk as
   * a resumable copy of history the user just cleared.
   */
  async deleteNativeTranscript(
    projectPath: string,
    nativeSessionId: string | undefined
  ): Promise<void> {
    if (!nativeSessionId) return
    try {
      const file = await findNativePiSessionFile(
        projectPath,
        nativeSessionId,
        this.host.agentDirectory
      )
      if (!file) return
      await rm(file, { force: true })
      Logger.info('Removed the discarded native Pi transcript', { nativeSessionId })
    } catch (error) {
      Logger.dev('Native Pi transcript removal skipped:', error)
    }
  }

  /**
   * Load messages for an app-managed session, or   for sub-agent worker
   * threads   the native pi session transcript persisted on disk by the
   * in-process sub-agent session.
   *
   * The native transcript is authoritative whenever it exists and the live RPC
   * process is not already holding the conversation in memory: the engine's
   * resume decision treats a non-empty `loadMessages` result as "this harness
   * session natively holds the conversation" and skips the history-recap
   * replay. Returning the mirror there would make a fresh (unresumable) pi
   * session look resumable and silently drop all context.
   */
  async loadMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]> {
    return this.loadMessagesInternal(projectPath, sessionId, true)
  }

  /** Flush-aware transcript load for delegated child sessions: a settled
   *  child must not block the caller on a directory watch for a transcript
   *  file that can never appear (reopening a finished sub-agent otherwise
   *  waits seconds on every open). */
  loadSubagentMessages(
    projectPath: string,
    sessionId: string,
    options?: { waitForFlush?: boolean }
  ): Promise<AgentMessage[]> {
    // The extension streams a child session's transcript while it works, so
    // the trace so far is already in memory: return it instead of waiting for
    // pi to flush the child's session file (which it defers until the child's
    // first assistant message completes). Reopening a settled child keeps
    // working the same way until the entry is evicted, after which the session
    // file and the engine's mirror take over as before.
    const live = this.host.childSnapshot(sessionId)
    if (live) {
      // Whoever asked for this child's transcript is looking at it, so the
      // extension may forward its token deltas again.
      this.host.watchChildSession(sessionId)
      return Promise.resolve(live)
    }
    return this.loadMessagesInternal(projectPath, sessionId, options?.waitForFlush ?? true)
  }

  async holdsNativeHistory(projectPath: string, sessionId: string): Promise<boolean> {
    if (this.host.hasClient(sessionId)) return true
    const record = await this.readSessionRecord(projectPath, sessionId)
    const nativeId = record?.nativeSessionId
    if (!nativeId) return false
    const file = await findNativePiSessionFile(projectPath, nativeId, this.host.agentDirectory)
    return file !== null
  }

  /**
   * Restore this session's native pi transcript binding from the most recent
   * resumable session record for the thread. Called when a thread returns to
   * pi after a harness switch: the thread's session slot now belongs to the
   * other harness, but pi still holds the real transcript on disk   without
   * this the returning turn cold-starts on the engine's history recap, which
   * weaker models read as injected fiction and freeze on.
   */
  async restoreNativeBinding(
    projectPath: string,
    sessionId: string,
    threadId: string
  ): Promise<boolean> {
    try {
      const replacement = await this.host.session(projectPath, sessionId)
      if (replacement.nativeSessionId) return true
      const previous = await this.host.findLatestThreadSession(projectPath, threadId)
      if (!previous || previous.id === sessionId) return false
      const nativeId = previous.nativeSessionId
      if (!nativeId) return false
      if (!existsSync(nativePiSessionDir(projectPath, this.host.agentDirectory))) return false
      if (!(await findNativePiSessionFile(projectPath, nativeId, this.host.agentDirectory)))
        return false
      replacement.nativeSessionId = nativeId
      Logger.info('Restored native Pi transcript binding after harness switch', {
        sessionId,
        threadId,
        fromSessionId: previous.id,
        nativeSessionId: nativeId
      })
      return true
    } catch (error) {
      Logger.dev('Native Pi binding restore skipped:', error)
      return false
    }
  }

  /**
   * Seed a fresh session with the thread's edited history as a native pi
   * transcript. Used after the user edits a session (delete/truncate/collapse):
   * instead of replaying the remaining mirror as a history recap   which weak
   * models read as injected fiction and stall on   the next RPC spawn resumes
   * this synthetic transcript natively, exactly as if the conversation had
   * happened in pi itself.
   */
  async prefillNativeSession(
    projectPath: string,
    sessionId: string,
    messages: readonly AgentMessage[]
  ): Promise<boolean> {
    try {
      const session = await this.host.session(projectPath, sessionId)
      if (session.nativeSessionId) return true
      const entries = prefillTranscriptEntries(projectPath, messages)
      if (entries.length === 0) return false
      const dir = nativePiSessionDir(projectPath, this.host.agentDirectory)
      await mkdir(dir, { recursive: true })
      const nativeId = randomUUID()
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/gu, '-')}_${nativeId}.jsonl`)
      await writeFile(file, `${entries.join('\n')}\n`, 'utf8')
      session.nativeSessionId = nativeId
      await this.host.persistSession(session)
      Logger.info('Seeded a native Pi transcript from the edited mirror', {
        sessionId,
        nativeSessionId: nativeId,
        entries: entries.length
      })
      return true
    } catch (error) {
      Logger.dev('Native Pi transcript prefill skipped:', error)
      return false
    }
  }

  /**
   * Carry a replaced session's native pi transcript binding over to the
   * replacement record. When the engine mints a replacement app session (the
   * stored session became unreachable), the fresh record starts without a
   * nativeSessionId   without this transfer the thread's real native
   * transcript is orphaned and every later turn degrades to the engine's
   * history recap, which models can misread as fabricated context.
   */
  async inheritNativeSession(
    projectPath: string,
    fromSessionId: string,
    toSessionId: string
  ): Promise<boolean> {
    try {
      const previous = await this.readSessionRecord(projectPath, fromSessionId)
      const nativeId = previous?.nativeSessionId
      if (!nativeId) return false
      if (!existsSync(nativePiSessionDir(projectPath, this.host.agentDirectory))) return false
      if (!(await findNativePiSessionFile(projectPath, nativeId, this.host.agentDirectory)))
        return false
      const replacement = await this.host.session(projectPath, toSessionId)
      if (replacement.nativeSessionId) return true
      replacement.nativeSessionId = nativeId
      Logger.info('Inherited native Pi session transcript onto a replacement session', {
        fromSessionId,
        toSessionId,
        nativeSessionId: nativeId
      })
      return true
    } catch (error) {
      Logger.dev('Native Pi session inheritance skipped:', error)
      return false
    }
  }

  /** Mirror the native pi session id so driver records stay addressable. */
  async syncNativeSessionId(projectPath: string, sessionId: string): Promise<void> {
    const client = this.host.rpcClient(sessionId)
    if (!client) return
    const state = record(await client.getState())
    const nativeId = stringValue(state?.['sessionId'])
    if (!nativeId) return
    const session = await this.host.session(projectPath, sessionId)
    session.nativeSessionId = nativeId
  }

  private async loadMessagesInternal(
    projectPath: string,
    sessionId: string,
    waitForFlush: boolean
  ): Promise<AgentMessage[]> {
    if (!this.host.hasClient(sessionId)) {
      const sessionRecord = await this.readSessionRecord(projectPath, sessionId)
      if (sessionRecord) {
        const native = await this.loadResumableNativeMessages(projectPath, sessionId, sessionRecord)
        if (native) return native
        if (sessionRecord.nativeSessionId) {
          // The session was bound to a native pi session whose transcript is
          // gone   the next turn starts a fresh session, so report no native
          // history and let the engine replay the durable mirror instead.
          return []
        }
      }
    }
    try {
      return await this.host.loadMirroredMessages(projectPath, sessionId)
    } catch (error) {
      const native = await loadNativeSubagentMessages(
        projectPath,
        sessionId,
        waitForFlush,
        this.host.agentDirectory
      )
      if (native) return native
      // Throwing stays correct whenever a record genuinely exists   including
      // a hash-mismatched one (moved project), where the engine must retire
      // the dead session and create a replacement. Only a truly absent record
      // takes the child-session fallback: pi child sessions (cio_spawn_agent)
      // are never persisted as CLI session records, so "CLI session is
      // unavailable" is their normal state, not a failure   and pi never
      // flushes their transcripts to disk either (the nested SessionManager
      // inherits the parent cwd). Throwing there only spams the renderer with
      // repeated load errors while the sub-agent card's own activity already
      // carries the transcript preview; an empty result tells the engine to
      // keep using that preview.
      if (await this.readSessionRecordIgnoringPath(sessionId)) throw error
      return []
    }
  }

  /** The persisted session record, or null when the session is unknown. */
  private async readSessionRecord(
    projectPath: string,
    sessionId: string
  ): Promise<PersistentCliSession | null> {
    try {
      return await this.host.session(projectPath, sessionId)
    } catch {
      return null
    }
  }

  /** Like `readSessionRecord`, but matches even a hash-mismatched record. */
  private async readSessionRecordIgnoringPath(
    sessionId: string
  ): Promise<PersistentCliSession | null> {
    return (
      (await this.host.storage
        .read<PersistentCliSession>(this.host.sessionRecordPath(sessionId))
        .catch(() => null)) ?? null
    )
  }

  /**
   * Parse pi's own transcript for a cold (no live RPC process) session whose
   * native session file still exists on disk. Returns null when the session is
   * not natively resumable so the caller falls back to the mirror.
   */
  private async loadResumableNativeMessages(
    projectPath: string,
    sessionId: string,
    sessionRecord: PersistentCliSession
  ): Promise<AgentMessage[] | null> {
    const nativeId = sessionRecord.nativeSessionId
    if (!nativeId) return null
    if (!existsSync(nativePiSessionDir(projectPath, this.host.agentDirectory))) return null
    const file = await findNativePiSessionFile(projectPath, nativeId, this.host.agentDirectory)
    if (!file) return null
    try {
      const messages = await parseNativePiSession(file, sessionId)
      return messages.length > 0 ? messages : null
    } catch (error) {
      Logger.dev('Pi native transcript parse failed during resume check:', error)
      return null
    }
  }
}
