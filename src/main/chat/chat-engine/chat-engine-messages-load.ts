import { resolve } from 'path'
import { Logger } from '../../system/logger'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { validateEntityId } from '../../ipc/ipc-validation'
import type {
  AgentMessage,
  Thread,
  TurnStreamPartsChange,
  TurnStreamPartsPage,
  TurnStreamPartsQuery,
  TurnStreamCompletedTurns
} from '../../../lib/types'
import { compactTurnStreamEvents, foldTurnStreamEvents } from '../turn-stream'
import type { TurnStreamEvent } from '../turn-stream'
import { pageTurnStreamParts, completedTurnWindow } from '../turn-stream-page'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc/browser'
import { historyMirrorIssue, isStructuredOutputHistoryDecodeError } from './chat-engine-errors'
import {
  classifyProviderMessages,
  isDedicatedAssignmentAuditorThread,
  mergeAgentMessages,
  presentableMessages,
  restoreMirrorAccount,
  restoreMirrorThinkingLevel,
  stampAccount,
  stampHarnessId
} from './chat-engine-message-merge'
import { MEMORY_PREVIOUS_MESSAGE_CHARACTERS } from './chat-engine-message-text'
import {
  preserveMirrorGenerationDurations,
  preserveMirrorReasoningStamps,
  preserveMirrorToolStamps,
  turnStreamPath
} from './chat-engine-pure'
import { ChatEngine } from '../chat-engine'

/** ChatEngine messages-load: one concern, moved verbatim from the composition root. */
export class ChatEngineMessagesLoad {
  constructor(private readonly host: ChatEngine) {}

  /** Load the conversation, preferring the live driver and falling back to the mirror. */
  async loadMessages(projectId: string, threadId: string): Promise<AgentMessage[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    await this.host.threadCreation?.awaitReady(threadId)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) return []
    if (this.host.state.ovenChat.remote(thread)) return this.host.state.ovenChat.messages(thread)
    if (!thread.sessionId) {
      const messages = await this.host.threadManager.loadMessages(projectId, threadId)
      const projectPath = await this.host.units['turns'].resolveProjectPath(projectId)
      const synchronized = await this.host.state.generatedArtifactService.synchronize(
        thread,
        projectPath,
        messages
      )
      if (synchronized.changed) {
        await this.host.threadManager.upsertMessages(projectId, threadId, synchronized.messages)
      }
      return synchronized.messages
    }
    // The thread's bound session belongs to the harness that created it, not
    // necessarily the one currently selected in settings: after a mid-run
    // harness switch `settings.harnessId` points at the new harness while
    // `sessionId` still lives in the old one. Always read through the session's
    // owning driver (registry first, persisted owner second) so the old
    // transcript syncs completely and the new harness never sees a foreign id.
    const registeredOwner = this.host.sessionRegistry.get(thread.sessionId)?.driverId
    const driverId =
      registeredOwner ?? thread.sessionHarnessId ?? thread.settings?.harnessId ?? DEFAULT_HARNESS
    try {
      const accountId =
        this.host.sessionRegistry.get(thread.sessionId)?.accountId ?? thread.sessionAccountId
      const { driver, projectPath } = await this.host.resolve(
        projectId,
        driverId,
        threadId,
        accountId
      )
      const account = await this.host.state.accountRegistry.resolve(driverId, accountId)
      this.host.registerSession(
        thread.sessionId,
        projectId,
        threadId,
        projectPath,
        thread.settings?.permissionLevel ?? 'auto_review',
        driverId
      )
      const registered = this.host.sessionRegistry.get(thread.sessionId)
      if (registered) registered.accountId = accountId
      const messages = stampAccount(
        stampHarnessId(await driver.loadMessages(projectPath, thread.sessionId), driverId),
        account.id,
        account.label
      )
      this.host.units['misc'].applyReasoningStamps(thread.sessionId, messages)
      this.host.units['utilities-tools'].applyToolStamps(thread.sessionId, messages)
      this.host.units['misc'].applyGenerationStamps(thread.sessionId, messages)
      const mirror = await this.host.threadManager.loadMessageRecords(projectId, threadId)
      this.host.state.outboundMessageIdsBySession.set(
        thread.sessionId,
        new Set(mirror.filter((message) => message.role === 'user').map((message) => message.id))
      )
      // Preserve thinking and tool timestamps from the mirror for parts the driver lacks.
      preserveMirrorReasoningStamps(mirror, messages)
      preserveMirrorToolStamps(mirror, messages)
      preserveMirrorGenerationDurations(mirror, messages)
      let merged = restoreMirrorAccount(
        restoreMirrorThinkingLevel(
          mergeAgentMessages(
            mirror,
            classifyProviderMessages(
              messages,
              this.host.state.planningSessions.has(thread.sessionId) ||
                isDedicatedAssignmentAuditorThread(thread)
            )
          ),
          mirror
        ),
        mirror
      )
      const artifactProjectPath = await this.host.units['turns'].resolveProjectPath(projectId)
      const synchronized = await this.host.state.generatedArtifactService.synchronize(
        thread,
        artifactProjectPath,
        merged
      )
      merged = synchronized.messages
      await this.host.threadManager.upsertMessages(projectId, threadId, merged)
      return presentableMessages(merged, isDedicatedAssignmentAuditorThread(thread))
    } catch (error) {
      if (isStructuredOutputHistoryDecodeError(error)) {
        const mirror = await this.host.threadManager.loadMessages(projectId, threadId)
        try {
          const replacementSessionId = await this.host.ensureSession(projectId, threadId, driverId)
          Logger.info('Replaced an unreadable OpenCode structured-output session', {
            projectId,
            threadId,
            previousSessionId: thread.sessionId,
            replacementSessionId
          })
          const projectPath = await this.host.units['turns'].resolveProjectPath(projectId)
          const synchronized = await this.host.state.generatedArtifactService.synchronize(
            thread,
            projectPath,
            mirror
          )
          if (synchronized.changed) {
            await this.host.threadManager.upsertMessages(projectId, threadId, synchronized.messages)
          }
          return synchronized.messages
        } catch (repairError) {
          Logger.error('Structured-output session replacement failed', repairError)
        }
      }
      Logger.error('loadMessages: driver unavailable, using mirror', error)
      await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
        projectId,
        threadId,
        thread.sessionId,
        historyMirrorIssue(error, driverId)
      )
      const mirror = await this.host.threadManager.loadMessages(projectId, threadId)
      const projectPath = await this.host.units['turns'].resolveProjectPath(projectId)
      const synchronized = await this.host.state.generatedArtifactService.synchronize(
        thread,
        projectPath,
        mirror
      )
      if (synchronized.changed) {
        await this.host.threadManager.upsertMessages(projectId, threadId, synchronized.messages)
      }
      return synchronized.messages
    }
  }

  /**
   * Load a provider-native child session without merging it into the parent
   * thread mirror. Child session IDs are supplied by provider-normalized
   * sub-agent activity parts.
   */
  async loadSessionMessages(
    projectId: string,
    threadId: string,
    sessionId: string
  ): Promise<AgentMessage[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    sessionId = validateEntityId(sessionId, 'Session ID', 512)
    const owner = await this.host.units['assignment-workers'].resolveChildSessionOwner(
      projectId,
      threadId,
      sessionId
    )
    // A pawn's transcript lives on the pawn's own thread, so the load follows
    // the resolved owner rather than the thread whose card opened the view. For
    // a nested sub-agent the owner is that same thread, so nothing changes.
    const cached = await this.host.threadManager.loadSubagentMessages(
      projectId,
      owner.threadId,
      sessionId
    )
    if (cached.length > 0) {
      // The DB mirror is the store of truth for a settled sub-agent: reopen
      // must be a single DB read, not a harness probe. Only a still-running
      // worker justifies a background refresh.
      const status = this.host.state.childSessionActivityStatuses.get(sessionId)
      if (status === 'running' || status === 'pending') {
        void this.host.units['assignment-workers']
          .captureChildSession(owner, sessionId)
          .catch((error) => Logger.dev('Sub-agent transcript refresh unavailable:', error))
      }
      return cached
    }
    try {
      // captureChildSession never rejects: on a driver load failure it falls
      // back to the spawn tool's own transcript from the parent thread, and
      // while a live worker has not flushed anything yet it resolves empty so
      // the view stays in its loading state instead of surfacing the raw
      // "CLI session is unavailable" driver error. The view polls while the
      // worker is busy and reloads once it settles.
      const status = this.host.state.childSessionActivityStatuses.get(sessionId)
      return await this.host.units['assignment-workers'].captureChildSession(
        owner,
        sessionId,
        undefined,
        {
          // Only a still-running worker justifies blocking on the harness's
          // transcript flush; an unknown status means pre-restart or settled,
          // so the mirror/fallback must cover it without any watch delay.
          waitForFlush: status === 'running' || status === 'pending'
        }
      )
    } catch (error) {
      // Defensive: any residual failure still degrades to the parent's
      // sub-agent activity rather than throwing into the IPC handler.
      Logger.dev('Sub-agent transcript load failed:', error)
      return this.host.units['assignment-workers'].subagentMessagesFromParentActivity(
        owner,
        sessionId
      )
    }
  }

  /** Rebuild a bounded window of the working trace from the thread's durable
   *  SSE log, or report what the log touched since a change cursor. Returns only
   *  the most recent logical turn's parts, so a reopened mid-turn thread shows
   *  its own streamed work rather than stale parts from earlier turns. Parsed
   *  events are cached per thread and the log is append-only, so the log is
   *  tailed incrementally by byte offset and each call only parses bytes
   *  appended since the last load. */
  async loadTurnStreamParts(
    projectId: string,
    threadId: string,
    query: TurnStreamPartsQuery = {}
  ): Promise<TurnStreamPartsPage | TurnStreamPartsChange | TurnStreamCompletedTurns> {
    if (projectId === GLOBAL_BROWSER_PROJECT_ID) {
      // Repair settled browser history before the trace loader can compact old
      // turns out of the only record that still holds their assistant messages.
      await this.host.threadManager.loadMessagePage(projectId, threadId, undefined, 1)
    }
    // A turn the transcript has not mirrored yet lives only in the log, and once
    // the fold moved past it (a steer opens its own turn) nothing else can reach
    // it. This is the read that keeps that work auditable.
    if (query.completedTurns === true || query.turnEndTs !== undefined) {
      return this.loadCompletedTurnStreamParts(projectId, threadId, query)
    }
    const streamPath = turnStreamPath(projectId, threadId)
    const entry = this.host.units['turns-stream'].turnStreamEntry(streamPath)

    const size = await this.host.storage.rawSize(streamPath)
    if (size === null) {
      this.host.state.turnStreamCache.delete(streamPath)
      return pageTurnStreamParts([], [], query, null)
    }

    const turnStartTs = await this.host.units['lifecycle'].currentTurnStartTs(projectId, threadId)

    // The log is append-only, so a shrink means the file was rewritten
    // underneath us   drop every cached event and rehydrate from scratch.
    if (size < entry.consumedBytes) {
      entry.consumedBytes = 0
      entry.events = []
      entry.latestTurnId = ''
      entry.foldKey = null
      entry.folded = null
      entry.completedKey = null
      entry.completed = null
      entry.retainFromTs = null
    }

    if (entry.consumedBytes === 0) {
      // First hydration for this thread, or right after a rewrite: read the
      // log in the background I/O worker, walking backwards from its end so
      // only the newest turn is loaded and the thread's older history is never
      // touched. The log is thread-wide and append-only, so a long-lived thread
      // reaches hundreds of megabytes; reading it forwards on the main process
      // put every open behind it. The page a reader mounts is still bounded
      // (`WORKING_TRACE_PAGE_SIZE`), and older entries page in on demand.
      const hydrated = await this.host.units['thread-lifecycle'].readTurnStreamOffThread(
        streamPath,
        0,
        size,
        turnStartTs
      )
      entry.events = hydrated.events
      entry.latestTurnId = hydrated.latestTurnId
      entry.consumedBytes = hydrated.nextByte
    } else {
      const tail = await this.host.storage.readRawTail(streamPath, entry.consumedBytes)
      if (!tail) {
        this.host.state.turnStreamCache.delete(streamPath)
        return pageTurnStreamParts([], [], query, turnStartTs ?? null)
      }
      for (const line of tail.content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed) as TurnStreamEvent
          if (parsed.kind === 'part.updated' || parsed.kind === 'part.delta') {
            entry.events.push(parsed)
            if (parsed.turnId) entry.latestTurnId = parsed.turnId
          }
        } catch {
          // A malformed line must not block rehydration of the rest of the stream.
        }
      }
      entry.consumedBytes = tail.nextByte
    }

    // Bound the retained log before folding. The parse above only ever appends,
    // and a streaming turn keeps landing past the boundary between polls, so this
    // folds those into the same retained set. Compaction keeps the fold identical
    // while collapsing history to one snapshot per part the current turn still
    // touches. A run whose closed turns the transcript has not mirrored yet is
    // retained from its oldest prompt, so a steer can never make the log forget
    // the work it interrupted.
    const retainFromTs = entry.retainFromTs ?? turnStartTs
    const compacted = compactTurnStreamEvents(entry.events, retainFromTs)
    if (compacted !== entry.events) {
      entry.events = compacted
      entry.foldKey = null
    }
    // The same compaction on disk, so the next reopen is cheap. Nothing else ever
    // trimmed the file, so past the cap the load rewrites it to exactly the events
    // the fold needs, through the file's append queue and reusing the bytes this
    // load already parsed. The rewrite itself decides whether the trim is worth
    // it, so a log that is already just the current turn is left alone.
    if (size >= ChatEngine.TURN_STREAM_COMPACT_BYTES) {
      void this.host.units['turns-stream'].compactTurnStream(
        streamPath,
        entry.consumedBytes,
        entry.events,
        retainFromTs
      )
    }

    // Fold the latest bound turn PLUS every unbound-turn event. Re-folding is
    // skipped entirely when neither the events nor the turn boundary changed.
    const foldKey = `${entry.events.length}:${entry.latestTurnId}:${turnStartTs ?? ''}`
    let folded = entry.folded
    if (entry.foldKey !== foldKey || !folded) {
      folded = foldTurnStreamEvents(entry.events, entry.latestTurnId || undefined, turnStartTs)
      entry.folded = folded
      entry.foldKey = foldKey
    }
    return pageTurnStreamParts(folded, entry.events, query, turnStartTs ?? null)
  }

  /**
   * The durable record of every turn the transcript has not mirrored yet.
   *
   * A run in flight is a chain of turns: the prompt, then a steer's turn, then
   * the next steer's. Each closes where the next opens, and the provider
   * transcript only reaches the mirror in batches at sync points, so a closed
   * turn can have no assistant row at all for minutes while the log holds its
   * entire trace. This returns those turns, oldest first, so the transcript can
   * render them above the message that closed them instead of losing them.
   *
   * A single completed turn is served when `turnEndTs` names it, paged with
   * `beforeId`, so a very long one is read a window at a time.
   */
  async loadCompletedTurnStreamParts(
    projectId: string,
    threadId: string,
    query: TurnStreamPartsQuery
  ): Promise<TurnStreamCompletedTurns | TurnStreamPartsPage> {
    const turns = await this.host.units['turns'].completedTurnFolds(projectId, threadId)
    if (query.turnEndTs !== undefined) {
      const turn = turns.find((candidate) => candidate.endTs === query.turnEndTs)
      if (!turn) {
        // The turn left the log (compaction) or never had any entries: an empty
        // window is the honest answer, and the transcript then shows whatever the
        // mirror itself carries.
        return {
          kind: 'window',
          parts: [],
          total: 0,
          totalSteps: 0,
          start: 0,
          hasOlder: false,
          cursor: 0,
          todoParts: [],
          turnStartTs: null,
          completedTurn: true
        }
      }
      const window = completedTurnWindow(turn, query)
      return {
        kind: 'window',
        parts: window.parts,
        total: window.total,
        totalSteps: window.totalSteps,
        start: window.start,
        hasOlder: window.hasOlder,
        // A completed turn is not the live poll's coordinate space: its own start
        // is what identifies it, and the cursor belongs to the newest turn.
        cursor: 0,
        todoParts: [],
        turnStartTs: turn.startTs,
        completedTurn: true
      }
    }
    return {
      kind: 'completedTurns',
      turns: turns.map((turn) => completedTurnWindow(turn, query))
    }
  }

  /**
   * The user-authored message that preceded the turn being evaluated, when the
   * thread has one. The memory decision uses it to tell a standing rule apart
   * from a request the user had to repeat because an earlier attempt missed it,
   * so it is capped before it can crowd out the current turn's evidence.
   */
  async loadPreviousUserMessage(
    projectId: string,
    threadId: string,
    currentUserMessage: string
  ): Promise<string | null> {
    const messages = await this.host.threadManager.loadUserMessages(projectId, threadId)
    if (messages.length < 2) return null
    const current = currentUserMessage.trim()
    if (!current) return null
    const last = messages[messages.length - 1]
    // The current turn's message is normally already mirrored, so step one entry
    // back; when it is not, the last entry is itself the earlier message.
    const lastIsCurrent = last.content.includes(
      current.slice(0, MEMORY_PREVIOUS_MESSAGE_CHARACTERS)
    )
    const index = messages.length - (lastIsCurrent ? 2 : 1)
    if (index < 0) return null
    const previous = messages[index].content.trim()
    if (!previous || previous === current) return null
    return previous.slice(0, MEMORY_PREVIOUS_MESSAGE_CHARACTERS)
  }
}
