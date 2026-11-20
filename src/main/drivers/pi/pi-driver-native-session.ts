import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'path'
import type { AgentMessage } from '../../../lib/types'
import { Logger } from '../../system/logger'
import type { StorageEngine } from '../../storage/storage-engine'
import type { PersistentCliSession } from '../persistent-cli-driver'
import type { PiSessionClient } from './pi-client'
import {
  findNativePiTranscriptName,
  loadNativeSubagentMessages,
  localPiNativeTranscriptSource,
  parseNativePiTranscriptText,
  prefillTranscriptEntries,
  type PiNativeTranscriptSource
} from './pi-native-session'
import { trimPiTranscript } from './pi-transcript-trim'
import { record, stringValue } from './pi-values'

/** One native transcript edit: what pi must reload, and what the edit did. */
export interface PiNativeTrimOutcome {
  /** The path this session's own pi process opens to reload the edited file. */
  file: string
  /** `context_edit` records appended to the transcript. */
  edited: number
  /** Removed user turns the transcript does not carry. */
  missing: number
}

/** Everything the native transcript binding needs from the driver. */
export interface PiNativeSessionsHost {
  readonly agentDirectory: string | undefined
  /**
   * Where the sessions' pi processes keep their own transcripts.
   *
   * Absent, every transcript is read from this machine, exactly as it always
   * has. A driver whose sessions run on an Oven carries a source that reads the
   * Oven's copy instead: pi writes its session file beside its own process, so
   * resuming one has to open the path that process would open.
   */
  readonly nativeTranscripts?: PiNativeTranscriptSource
  readonly storage: StorageEngine
  hasClient(sessionId: string): boolean
  rpcClient(sessionId: string): PiSessionClient | undefined
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
  /** The local source, built once for the agent directory this driver serves. */
  private localSource: PiNativeTranscriptSource | null = null

  constructor(private readonly host: PiNativeSessionsHost) {}

  /** Where the bound sessions' pi processes keep their own transcripts. */
  private get transcripts(): PiNativeTranscriptSource {
    return (
      this.host.nativeTranscripts ??
      (this.localSource ??= localPiNativeTranscriptSource(this.host.agentDirectory))
    )
  }

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
    client: PiSessionClient
  ): Promise<void> {
    try {
      const session = await this.host.session(projectPath, sessionId)
      const nativeId = session.nativeSessionId
      if (!nativeId) return
      const source = this.transcripts
      const name = await findNativePiTranscriptName(source, projectPath, nativeId)
      if (!name) return
      // The path has to be the one the peer's own pi would open: on an Oven that
      // is the Oven's copy of the session file, never this machine's.
      await client.switchSession(source.resolve(projectPath, name))
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
      const source = this.transcripts
      const name = await findNativePiTranscriptName(source, projectPath, nativeSessionId)
      if (!name) return
      await source.remove(projectPath, name)
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
    const name = await findNativePiTranscriptName(this.transcripts, projectPath, nativeId)
    return name !== null
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
      if (!(await findNativePiTranscriptName(this.transcripts, projectPath, nativeId))) return false
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
   * instead of replaying the remaining mirror as a history recap, which weak
   * models read as injected fiction and stall on, the next RPC spawn resumes
   * this synthetic transcript natively, exactly as if the conversation had
   * happened in pi itself.
   *
   * The file is written through the transcript source, so an edited session
   * whose pi runs on an Oven is seeded in that machine's session directory and
   * the bound native id names a file the Oven's own pi will list.
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
      const nativeId = randomUUID()
      await this.transcripts.write(
        projectPath,
        `${new Date().toISOString().replace(/[:.]/gu, '-')}_${nativeId}.jsonl`,
        `${entries.join('\n')}\n`
      )
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
   * Remove the given messages from a session's native transcript.
   *
   * Pi's own history editing appends `context_edit` records to the transcript,
   * whether the user edited a thread on this machine or on an Oven, so the
   * records are computed by the same rule and written through the transcript
   * source. Null means there is no transcript to edit, which is what the caller
   * needs to fall back to discarding the session.
   */
  async trimTranscript(
    projectPath: string,
    nativeSessionId: string,
    removed: readonly AgentMessage[]
  ): Promise<PiNativeTrimOutcome | null> {
    const source = this.transcripts
    const name = await findNativePiTranscriptName(source, projectPath, nativeSessionId)
    if (!name) return null
    const text = await source.read(projectPath, name)
    if (text === null) return null
    // The edit rule is a file-in, append-out operation, and the transcript it
    // must edit can live on an Oven. The text is therefore trimmed through a
    // scratch file this process owns and the records it appends are written back
    // through the source: the Oven's transcript receives exactly the records a
    // local one would, and this machine keeps no copy of it.
    const scratch = await mkdtemp(join(tmpdir(), 'codeinoven-pi-trim-'))
    try {
      // The scratch file carries the transcript's own name so the edit rule sees
      // nothing about where the transcript really lives.
      const staged = join(scratch, basename(name))
      await writeFile(staged, text, 'utf8')
      const result = await trimPiTranscript(staged, removed)
      const appended = (await readFile(staged, 'utf8')).slice(text.length)
      if (appended.length > 0) await source.write(projectPath, name, text + appended)
      return { file: source.resolve(projectPath, name), ...result }
    } finally {
      await rm(scratch, { recursive: true, force: true })
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
      if (!(await findNativePiTranscriptName(this.transcripts, projectPath, nativeId))) return false
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
      const native = await loadNativeSubagentMessages(projectPath, sessionId, {
        waitForFlush,
        ...(this.host.agentDirectory ? { agentDirectory: this.host.agentDirectory } : {}),
        source: this.transcripts
      })
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
    const source = this.transcripts
    const name = await findNativePiTranscriptName(source, projectPath, nativeId)
    if (!name) return null
    try {
      const text = await source.read(projectPath, name)
      if (text === null) return null
      const messages = await parseNativePiTranscriptText(text, sessionId)
      return messages.length > 0 ? messages : null
    } catch (error) {
      Logger.dev('Pi native transcript parse failed during resume check:', error)
      return null
    }
  }
}
