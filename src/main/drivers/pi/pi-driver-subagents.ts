import type {
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentToolStatus,
  SessionAgentEvent
} from '../../../lib/types'
import { parseRecord } from '../../../lib/agent-interactions'
import { classifyProviderIssue, presentProviderError } from '../../../lib/provider-issue'
import { Logger } from '../../system/logger'
import type { StorageEngine } from '../../storage/storage-engine'
import type { PersistentCliSession } from '../persistent-cli-driver'
import { TERMINAL_SUBAGENT_STATUSES, subagentTimeRange } from './pi-subagent'
import { mapPiRecord } from './pi-stream-fold'
import type { PiStreamContext, PiTurnState } from './pi-stream-types'
import { stringValue } from './pi-values'

/**
 * Child sessions whose live transcript is retained in memory. Each entry is a
 * few dozen kilobytes for a long worker, and every entry is worth keeping for
 * as long as an open sub-agent tab might read it, so the map is bounded to the
 * recent few rather than the whole app session, with headroom over the spawn
 * cap (CIO_SUBAGENT_MAX_CONCURRENT in the core-tools extension) because a
 * worker's transcript is read until it settles.
 */
const PI_CHILD_STREAM_MAX = 20

/**
 * How long a child transcript stays watched after the app last asked for it.
 * An open sub-agent view polls its child every few seconds, so a visible
 * transcript keeps its own entry fresh; a view the user closed lapses on its
 * own and the worker's token stream stops being forwarded.
 */
const PI_SUBAGENT_WATCH_WINDOW_MS = 45_000

/**
 * Live transcript of one delegated child pi session, fed by the core-tools
 * extension's streamed `setStatus` records. The child session runs in-process
 * inside the harness, so nothing else can observe it while it works; keeping
 * the folded transcript here lets a tab open mid-run render the trace so far
 * instantly (no disk probe) and lets the engine persist the final transcript
 * without waiting for pi to flush the child's session file.
 */
export interface PiChildStreamState {
  context: PiStreamContext
  turnState: PiTurnState
  /** Root session that spawned this child. Kept here so a stop (or a process
   *  death) can close every child transcript of the stopped parent without a
   *  second index. */
  parentSessionId: string
  /** True once a working status was emitted for this child. */
  announcedWorking: boolean
  /** True once the child reported its terminal settle record. */
  settled: boolean
}

/** Everything the sub-agent streams need from the driver. */
export interface PiSubagentStreamHost {
  readonly id: string
  readonly storage: StorageEngine
  emitEvent(event: AgentEvent): void
  /** The live session record of the parent thread, when the driver holds it. */
  cachedSession(sessionId: string): PersistentCliSession | undefined
  hasActiveTurn(sessionId: string): boolean
  applySessionEvent(session: PersistentCliSession, event: AgentEvent): void
  applyMessagesEvent(messages: AgentMessage[], event: AgentEvent): void
}

/**
 * Live transcripts of delegated pi child sessions, plus the watch file the
 * core-tools extension reads to decide which children still stream tokens.
 *
 * A child session runs in-process inside the harness, so this is the only place
 * its transcript exists until pi flushes the child's own session file.
 */
export class PiSubagentStreams {
  private readonly childStreams = new Map<string, PiChildStreamState>()
  /** Per-session watch file the extension reads to learn which child
   *  transcripts the app is displaying (see `watchSubagentSession`). */
  private readonly cioWatchFlagPaths = new Map<string, string>()
  /** Child session ids the app asked for, with the moment the request goes
   *  stale. A transcript view polls its child while it is open, so a live view
   *  keeps its entry fresh and a closed one lapses within the watch window. */
  private readonly cioWatchedChildren = new Map<string, Map<string, number>>()
  /** Last watch list published per session, so unchanged state is not rewritten. */
  private readonly cioPublishedWatch = new Map<string, string>()

  constructor(private readonly host: PiSubagentStreamHost) {}

  /** Register a materialized session's watch file; its list starts empty. */
  registerSession(sessionId: string, watchFlagPath: string): void {
    this.cioWatchFlagPaths.set(sessionId, watchFlagPath)
    this.cioWatchedChildren.set(sessionId, new Map())
  }

  /** The retained transcript of a child session, when one is still in memory. */
  snapshot(childSessionId: string): AgentMessage[] | undefined {
    const live = this.childStreams.get(childSessionId)
    if (!live || live.context.session.messages.length === 0) return undefined
    return structuredClone(live.context.session.messages)
  }

  /** True while a nested worker of this session is still running. */
  hasLiveChildSession(parentSessionId: string): boolean {
    for (const state of this.childStreams.values()) {
      if (state.parentSessionId === parentSessionId && !state.settled) return true
    }
    return false
  }

  /**
   * Close every still-open child transcript of one parent session. Called when
   * the user stops the session (its workers are being aborted) and when the
   * harness process dies (its nested sessions die with it), so no sub-agent
   * card, tab or trace row can keep spinning for work that is already gone.
   */
  settleChildStreams(
    parentSessionId: string,
    status: 'aborted' | 'error',
    onlyChildSessionId?: string
  ): void {
    const error =
      status === 'error' ? 'The session ended while this sub-agent was still running.' : undefined
    for (const [childSessionId, state] of this.childStreams) {
      if (state.parentSessionId !== parentSessionId || state.settled) continue
      if (onlyChildSessionId && childSessionId !== onlyChildSessionId) continue
      state.settled = true
      this.closeSubagentCard(parentSessionId, childSessionId, error, status, true)
      if (status === 'aborted') {
        this.host.emitEvent({
          type: 'session.status',
          sessionId: childSessionId,
          status: { state: 'idle' }
        })
        continue
      }
      const detail = error ?? 'The sub-agent run ended unexpectedly.'
      const kind = classifyProviderIssue(detail)
      this.host.emitEvent({
        type: 'session.status',
        sessionId: childSessionId,
        status: {
          state: 'error',
          issue: {
            kind,
            message: presentProviderError(detail).message,
            rawError: detail,
            harnessId: this.host.id,
            retryable: kind !== 'billing'
          }
        }
      })
    }
  }

  /**
   * Fold one batch of streamed child-session records into that child's live
   * transcript and re-emit them as child-scoped events. Records carry pi's own
   * shapes, so they go through `mapPiRecord`   the exact mapper a root thread
   * uses   which is what makes a sub-agent stream and render like a normal
   * thread: the engine broadcasts whatever session id the driver reports, and
   * the sub-agent view already filters on the child session id.
   */
  handleSubagentStreamStatus(record: Record<string, unknown>, parentSessionId: string): void {
    const payload = parseRecord(record['statusText'])
    if (!payload) return
    const childSessionId = stringValue(payload['childSessionId'])
    if (!childSessionId) return
    const state = this.childStreamState(childSessionId, parentSessionId)
    const records = Array.isArray(payload['records']) ? payload['records'] : []
    if (records.length > 0 && !state.announcedWorking && !state.settled) {
      state.announcedWorking = true
      this.host.emitEvent({
        type: 'session.status',
        sessionId: childSessionId,
        status: { state: 'working' }
      })
    }
    for (const value of records) {
      const result = mapPiRecord(value, state.context, state.turnState)
      if (!result) continue
      for (const message of result.messages ?? []) {
        const messages = state.context.session.messages
        const index = messages.findIndex((candidate) => candidate.id === message.id)
        if (index === -1) messages.push(message)
        else messages[index] = message
      }
      for (const event of result.events ?? []) {
        this.applyChildStreamEvent(state, event)
        this.host.emitEvent({ ...event, sessionId: childSessionId })
      }
    }
    if (payload['settled'] !== true) return
    state.settled = true
    const error = stringValue(payload['error'])
    // A worker the user stopped is neither a completion nor a failure: it gets
    // its own terminal status so no surface can report finished work, and its
    // card is stamped even though the stopped parent turn is already gone.
    const aborted = stringValue(payload['status']) === 'aborted'
    const status: AgentToolStatus = aborted ? 'aborted' : error ? 'error' : 'completed'
    // The child's own settle record closes the parent thread's card, so the
    // working-trace dropdown and the sub-agent tab flip together instead of
    // the card waiting for the model loop to drain its done notification.
    this.closeSubagentCard(parentSessionId, childSessionId, error, status, aborted)
    if (!error || aborted) {
      this.host.emitEvent({
        type: 'session.status',
        sessionId: childSessionId,
        status: { state: 'idle' }
      })
      return
    }
    // The child's failure belongs to the child's transcript: report it on the
    // child session so the sub-agent view shows the reason and offers a retry,
    // never on the parent thread.
    const kind = classifyProviderIssue(error)
    this.host.emitEvent({
      type: 'session.status',
      sessionId: childSessionId,
      status: {
        state: 'error',
        issue: {
          kind,
          message: presentProviderError(error).message,
          rawError: error,
          harnessId: this.host.id,
          retryable: kind !== 'billing'
        }
      }
    })
  }

  /**
   * Close the parent thread's sub-agent card for one settled child session.
   *
   * A background spawn's tool call returns before its worker does, and the
   * `cio-subagent-done` notification only reaches the driver once the model
   * loop drains it (the drain can wait a whole turn). The child's own stream
   * already reports the settle, so stamping the parent card here is what keeps
   * the card, the dropdown and the tab on the same terminal state at the same
   * moment. The card's earlier payload still wins for output, files and model:
   * only the lifecycle fields are authoritative here.
   */
  private closeSubagentCard(
    parentSessionId: string,
    childSessionId: string,
    error: string | undefined,
    status: AgentToolStatus = error ? 'error' : 'completed',
    force = false
  ): void {
    // A parent that is mid-turn buffers the done notification until its loop
    // reaches the next step, which is exactly the lag this closes. An idle
    // parent runs the notification turn immediately, so its own patch lands
    // just as fast and this extra update would only flip the thread's live
    // activity back on with no turn behind it. A stop is the exception: the
    // parent's turn is already gone when its workers settle, so a stopped
    // worker's card is stamped regardless   otherwise it spins forever.
    if (!force && !this.host.hasActiveTurn(parentSessionId)) return
    const session = this.host.cachedSession(parentSessionId)
    if (!session) return
    for (const message of session.messages) {
      const part = message.parts.findLast(
        (candidate): candidate is Extract<AgentPart, { type: 'subagent' }> =>
          candidate.type === 'subagent' && candidate.activity.childSessionId === childSessionId
      )
      // A card that already reports a terminal state carries the richer
      // payload (final output, duration); never overwrite it with a lifecycle
      // stamp alone.
      if (!part || TERMINAL_SUBAGENT_STATUSES.has(part.activity.status)) {
        continue
      }
      const event: SessionAgentEvent = {
        type: 'message.part.updated',
        sessionId: parentSessionId,
        part: {
          ...part,
          activity: {
            ...part.activity,
            status,
            ...(error ? { error } : {}),
            time: subagentTimeRange(part.activity, status)
          }
        }
      }
      this.host.applySessionEvent(session, event)
      this.host.emitEvent(event)
    }
  }

  /**
   * Fold one child event into that child's transcript. A root session's
   * transcript is rebuilt from the harness (the driver only stamps it), but a
   * child session's transcript exists nowhere else until pi flushes its file
   *   so a streamed part whose message has not been materialized yet creates
   * that message here. Without this the live snapshot would be empty and the
   * final tool inputs could not be correlated with their results.
   */
  private applyChildStreamEvent(state: PiChildStreamState, event: SessionAgentEvent): void {
    const messages = state.context.session.messages
    if (event.type === 'message.part.updated' && event.part.type !== 'subagent') {
      if (!messages.some((message) => message.id === event.part.messageID)) {
        messages.push({
          id: event.part.messageID,
          role: 'assistant',
          parts: [],
          createdAt: Date.now(),
          harnessId: this.host.id
        })
      }
    }
    this.host.applyMessagesEvent(messages, event)
  }

  /** The live transcript state of one child session, capped and LRU-ordered. */
  private childStreamState(childSessionId: string, parentSessionId: string): PiChildStreamState {
    const existing = this.childStreams.get(childSessionId)
    if (existing) {
      // Re-insert so the oldest entry is always the least recently used.
      this.childStreams.delete(childSessionId)
      this.childStreams.set(childSessionId, existing)
      return existing
    }
    const created: PiChildStreamState = {
      context: { sessionId: childSessionId, session: { messages: [] } },
      turnState: { assistantMessageId: null, turnIndex: 0 },
      parentSessionId,
      announcedWorking: false,
      settled: false
    }
    this.childStreams.set(childSessionId, created)
    while (this.childStreams.size > PI_CHILD_STREAM_MAX) {
      const oldest = this.childStreams.keys().next().value
      if (oldest === undefined) break
      this.childStreams.delete(oldest)
    }
    return created
  }

  /**
   * Remember that the app is displaying a child session's transcript. The
   * extension reads the resulting watch file and forwards token deltas for
   * watched children only: a worker nobody is looking at still reports every
   * message, tool call and settle, but stops shipping a per-token stream that
   * only a view would consume.
   */
  watchSubagentSession(childSessionId: string): void {
    const parentSessionId = this.childStreams.get(childSessionId)?.parentSessionId
    if (!parentSessionId || !this.cioWatchFlagPaths.has(parentSessionId)) return
    const watched = this.cioWatchedChildren.get(parentSessionId) ?? new Map<string, number>()
    watched.set(childSessionId, Date.now() + PI_SUBAGENT_WATCH_WINDOW_MS)
    this.cioWatchedChildren.set(parentSessionId, watched)
    void this.publishWatchedChildren(parentSessionId)
  }

  /** Publish every live parent's watch list; the sweep's lapse cadence. */
  publishWatchLists(): void {
    for (const parentSessionId of this.cioWatchedChildren.keys()) {
      void this.publishWatchedChildren(parentSessionId)
    }
  }

  /** Forget a disposed session's watch list, publishing the empty list. */
  resetWatch(sessionId: string): void {
    // No process is left to read a watch list for this session, and the file
    // outlives the process: publish an empty list so a fresh spawn starts with
    // nothing wrongly marked as displayed.
    if (!this.cioWatchedChildren.has(sessionId)) return
    this.cioWatchedChildren.set(sessionId, new Map())
    this.cioPublishedWatch.delete(sessionId)
    void this.publishWatchedChildren(sessionId)
  }

  /** Write the live watch list for one parent session, when it changed. */
  private async publishWatchedChildren(parentSessionId: string): Promise<void> {
    const path = this.cioWatchFlagPaths.get(parentSessionId)
    if (!path) return
    const childSessionIds = this.liveWatchedChildren(parentSessionId)
    const signature = childSessionIds.join(',')
    if (this.cioPublishedWatch.get(parentSessionId) === signature) return
    this.cioPublishedWatch.set(parentSessionId, signature)
    try {
      await this.host.storage.writeRaw(
        path,
        JSON.stringify({ childSessionIds, updatedAt: Date.now() })
      )
    } catch (error) {
      Logger.dev('Sub-agent watch publication failed:', error)
    }
  }

  /** Watched child ids of one session, dropping every lapsed mark. */
  private liveWatchedChildren(parentSessionId: string): string[] {
    const watched = this.cioWatchedChildren.get(parentSessionId)
    if (!watched) return []
    const now = Date.now()
    const live: string[] = []
    for (const [childSessionId, expiresAt] of watched) {
      if (expiresAt <= now) {
        watched.delete(childSessionId)
        continue
      }
      live.push(childSessionId)
    }
    return live.sort()
  }

  /** Drop every retained child transcript (driver disposal). */
  clear(): void {
    this.childStreams.clear()
    this.cioWatchFlagPaths.clear()
    this.cioWatchedChildren.clear()
    this.cioPublishedWatch.clear()
  }
}
