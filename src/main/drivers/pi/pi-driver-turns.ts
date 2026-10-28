import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AgentEvent, AgentMessage, SessionAgentEvent } from '../../../lib/types'
import { CIO_SUBAGENT_STREAM_STATUS_KEY } from '../../../lib/core-tools'
import { parseRecord } from '../../../lib/agent-interactions'
import type { PersistentCliSession } from '../persistent-cli-driver'
import type { CliLineParseContext, CliLineParseResult } from '../persistent-cli-driver'
import type { PiRpcClient } from '../pi-rpc-client'
import { PI_COMPACTION_EXTENSION_KEY } from '../pi-compaction-extension'
import {
  PI_STATUS_COMPACTING,
  PI_STATUS_EXTENSION_KEY,
  PI_STATUS_IDLE,
  PI_STATUS_WORKING
} from '../pi-status-extension'
import { PI_USAGE_EXTENSION_KEY } from '../pi-usage-extension'
import { Logger } from '../../system/logger'
import { isOversizedRequestError } from './pi-errors'
import { findNativePiSessionFile, reconcileNativeCompactions } from './pi-native-session'
import { latestPiTurnIndex, mapPiRecord } from './pi-stream-fold'
import type { PiTurnState } from './pi-stream-types'
import { messageTimestamp, numberValue, record, stringValue } from './pi-values'

interface PiSilentContinueState {
  attempts: number
  owed: boolean
  lastError: string
  /** The failure was an oversized request body   compact before continuing. */
  compactFirst?: boolean
}

/** Silent continues per turn before the failure is surfaced as a real error. */
const SILENT_CONTINUE_MAX_ATTEMPTS = 10

/** Compact-and-continue recoveries per turn for oversized request bodies. */
const OVERSIZED_COMPACT_MAX_ATTEMPTS = 3

/** Everything the turn lifecycle needs from the driver. */
export interface PiTurnLifecycleHost {
  readonly agentDirectory: string | undefined
  requireSession(projectPath: string, sessionId: string): Promise<PersistentCliSession>
  persistSession(session: PersistentCliSession): Promise<void>
  mergeMessages(session: PersistentCliSession, messages: AgentMessage[]): void
  applySessionEvent(session: PersistentCliSession, event: AgentEvent): void
  emitEvent(event: AgentEvent): void
  client(sessionId: string): PiRpcClient | undefined
  projectOf(sessionId: string): string | undefined
  ensureClient(projectPath: string, sessionId: string): Promise<PiRpcClient>
  settledClient(sessionId: string): Promise<PiRpcClient | undefined>
  disposeClient(sessionId: string): void
  touchActivity(sessionId: string): void
  refreshSessionUsage(session: PersistentCliSession): Promise<void>
  scheduleLiveUsageRefresh(session: PersistentCliSession): void
  publishOversizedRecovery(sessionId: string, armed: boolean): Promise<void>
  /** Promote JSONL question/approval tool parts into the shared interaction stream. */
  normalizeInteractionEvents(sessionId: string, events: SessionAgentEvent[]): SessionAgentEvent[]
  /** Clear the mid-turn usage-refresh throttle at turn end. */
  clearUsageThrottle(sessionId: string): void
  markCompactionReady(sessionId: string): void
  handleUsageStatus(record: Record<string, unknown>, sessionId: string): Promise<void>
  handleSubagentStreamStatus(record: Record<string, unknown>, sessionId: string): void
}

/**
 * The logical turn: its registered state, the record stream folded into it, the
 * silent-continue recovery for finish-reason flakes, the page checkpoint that
 * keeps a turn alive across an abort + compact + re-prompt, and finalization.
 */
export class PiTurnLifecycle {
  /** Tickets prevent duplicate compactions and continuation after user cancellation. */
  private readonly pageCompactions = new Map<string, { resume: boolean }>()
  private readonly turnStates = new Map<string, PiTurnState>()
  /**
   * Per session, the message that owns the answer the last task-list reconcile
   * nudge must not replace (see `taskReconcileAnswerId`).
   *
   * Written when the extension's nudge crosses the record stream and read once at
   * finalization, then cleared by the next prompt: a mark left over from an
   * earlier turn can only mislead a transcript read that reaches back before it.
   */
  private readonly reconcileAnswers = new Map<string, string>()
  private readonly activeTurns = new Set<string>()
  /**
   * Bounded silent-continue bookkeeping per session. When a turn settles with a
   * finish-reason flake (`Provider finish_reason: other` and friends), the
   * driver silently re-prompts the model instead of surfacing the error. The
   * mirror is claimed only while a continuation is actually owed, so every
   * other path keeps its plain `message.completed`/finalization behavior.
   */
  private readonly silentContinues = new Map<string, PiSilentContinueState>()

  constructor(private readonly host: PiTurnLifecycleHost) {}

  hasActiveTurn(sessionId: string): boolean {
    return this.activeTurns.has(sessionId)
  }

  addActiveTurn(sessionId: string): void {
    this.activeTurns.add(sessionId)
  }

  removeActiveTurn(sessionId: string): void {
    this.activeTurns.delete(sessionId)
  }

  /** True while pi is retrying the session's last request (a live run). */
  isProviderRetryPending(sessionId: string): boolean {
    return this.turnStates.get(sessionId)?.providerRetry === true
  }

  taskReconcileAnswerId(sessionId: string): string | undefined {
    return this.reconcileAnswers.get(sessionId)
  }

  clearReconcileAnswer(sessionId: string): void {
    this.reconcileAnswers.delete(sessionId)
  }

  /** Drop an owed silent continue; a user prompt or stop owns the turn now. */
  clearSilentContinue(sessionId: string): void {
    this.silentContinues.delete(sessionId)
  }

  /** Mark the page checkpoint of this session as needing its continuation. */
  markSteerResume(sessionId: string): void {
    const checkpoint = this.pageCompactions.get(sessionId)
    if (checkpoint) checkpoint.resume = true
  }

  /** Drop a session's in-flight page checkpoint ticket (its client is gone). */
  clearPageCompaction(sessionId: string): void {
    this.pageCompactions.delete(sessionId)
  }

  /** Release every turn mark a stopped session owns. */
  resetForStop(sessionId: string): void {
    if (this.pageCompactions.has(sessionId)) {
      const turn = this.turnStates.get(sessionId)
      if (turn) this.turnStates.set(sessionId, { ...turn, compacting: false })
    }
    this.pageCompactions.delete(sessionId)
    // An owed silent continue belongs to the turn the user is stopping: pi
    // settles the aborted run with `agent_settled`, and the continuation would
    // then start a fresh run seconds after the stop.
    this.silentContinues.delete(sessionId)
  }

  /** Start a session's turn state from its mirrored messages (process boot). */
  initializeTurnState(sessionId: string, messages: PersistentCliSession['messages']): void {
    const currentTurnState = this.turnStates.get(sessionId)
    this.turnStates.set(sessionId, {
      assistantMessageId: currentTurnState?.assistantMessageId ?? null,
      turnIndex: Math.max(currentTurnState?.turnIndex ?? 0, latestPiTurnIndex(messages, sessionId))
    })
  }

  /** Forget every turn mark of a deleted or parked session. */
  deleteSessionState(sessionId: string): void {
    this.activeTurns.delete(sessionId)
    this.turnStates.delete(sessionId)
    this.silentContinues.delete(sessionId)
    this.reconcileAnswers.delete(sessionId)
  }

  /** Drop every session's turn marks (driver disposal). */
  clearAll(): void {
    this.activeTurns.clear()
    this.turnStates.clear()
    this.reconcileAnswers.clear()
    this.silentContinues.clear()
  }

  parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const state = this.turnStates.get(context.sessionId) ?? {
      assistantMessageId: null,
      turnIndex: 0
    }
    this.turnStates.set(context.sessionId, state)
    const result = mapPiRecord(value, context, state)
    // The record mapper stores the task-list reconcile nudge's boundary on the
    // turn state; keep it per session so the chat engine can read it back at
    // finalization, once the whole turn is in hand.
    if (state.reconcileAnswerMessageId !== undefined) {
      this.reconcileAnswers.set(context.sessionId, state.reconcileAnswerMessageId)
    }
    return result
  }

  handleRpcEvent(
    record: Record<string, unknown>,
    sessionId: string,
    projectPath: string
  ): Promise<void> {
    // Pi names the extension and the hook that threw for every failed extension
    // hook, and this is the only place both reach the app: the stream fold keeps
    // just the message, which left a stale-extension failure attributable only
    // by reproducing it. Logged at error level because it fails a real turn.
    if (record['type'] === 'extension_error') {
      Logger.error('Pi extension error', {
        sessionId,
        extensionPath: stringValue(record['extensionPath']) ?? '',
        event: stringValue(record['event']) ?? '',
        error: stringValue(record['error']) ?? ''
      })
    }
    this.host.touchActivity(sessionId)
    return this.host
      .requireSession(projectPath, sessionId)
      .then(async (session) => {
        // Resolve the retained context at compaction time, never while forking.
        const compaction = parseRecord(record['result'])
        const keptId = compaction?.['firstKeptEntryId']
        const details = parseRecord(compaction?.['details'])
        const trace = parseRecord(details?.['lastWorkingTrace'])
        const checkpointKind = details?.['kind']
        const retainedAt =
          (checkpointKind === 'cio-page-checkpoint' ||
            checkpointKind === 'cio-emergency-checkpoint') &&
          trace?.['firstKeptEntryId'] === keptId
            ? numberValue(trace?.['firstKeptCreatedAt'])
            : undefined
        if (retainedAt !== undefined) record['firstKeptCreatedAt'] = retainedAt
        if (
          (record['type'] === 'auto_compaction_end' || record['type'] === 'compaction_end') &&
          typeof keptId === 'string' &&
          retainedAt === undefined &&
          session.nativeSessionId
        ) {
          try {
            const file = await findNativePiSessionFile(
              projectPath,
              session.nativeSessionId,
              this.host.agentDirectory
            )
            if (file) {
              const input = createReadStream(file)
              const lines = createInterface({ input, crlfDelay: Infinity })
              try {
                for await (const line of lines) {
                  const entry = parseRecord(line)
                  if (entry?.['id'] === keptId) {
                    const message = parseRecord(entry['message'])
                    if (message) record['firstKeptCreatedAt'] = messageTimestamp(message)
                    break
                  }
                  await new Promise<void>((resolve) => setImmediate(resolve))
                }
              } finally {
                lines.close()
                input.destroy()
              }
            }
          } catch (error) {
            Logger.dev('Pi compaction retained boundary unavailable:', error)
          }
        }
        const result = this.parseJsonLine(record, { session, sessionId, projectPath })
        if (!result) return
        if (result.nativeSessionId) session.nativeSessionId = result.nativeSessionId
        if (result.messages) this.host.mergeMessages(session, result.messages)
        for (const event of this.host.normalizeInteractionEvents(session.id, result.events ?? [])) {
          // A successful assistant completion proves the provider recovered, so
          // the flake budget resets: a long agentic turn that survives many
          // scattered hiccups must not be capped by their cumulative count.
          if (
            event.type === 'message.completed' &&
            !event.error &&
            !event.silentContinue &&
            !event.compaction
          ) {
            const state = this.silentContinues.get(session.id)
            if (state && state.attempts > 0) {
              state.attempts = 0
              this.silentContinues.set(session.id, state)
            }
            // The provider accepted a request again   stand the oversized
            // recovery context stripping down so future turns send full media.
            void this.host.publishOversizedRecovery(session.id, false)
            // The request's own token totals just landed; pull the session
            // stats too so the context meter keeps a provider reading (window,
            // occupancy, cost, quota) while the turn continues.
            this.host.scheduleLiveUsageRefresh(session)
          }
          // A continuable finish-reason flake is claimed by the driver: strip
          // the marker and never let the errored completion reach the engine,
          // or the chat would show a failure the silent continue is about to
          // recover from. The empty assistant message is dropped from the
          // mirror so the user never sees a blank failed turn.
          if (event.type === 'message.completed' && event.silentContinue) {
            const compactFirst = isOversizedRequestError(event.silentContinue.error)
            const state = this.silentContinues.get(session.id) ?? {
              attempts: 0,
              owed: false,
              lastError: ''
            }
            state.lastError = event.silentContinue.error
            const { silentContinue, ...clean } = event
            void silentContinue
            const maxAttempts = compactFirst
              ? OVERSIZED_COMPACT_MAX_ATTEMPTS
              : SILENT_CONTINUE_MAX_ATTEMPTS
            if (state.attempts < maxAttempts) {
              state.owed = true
              state.attempts += 1
              state.compactFirst = compactFirst
              this.silentContinues.set(session.id, state)
              // Mark the flaked message complete (without the error) so the
              // mirror stays consistent; content-bearing messages are kept.
              this.host.applySessionEvent(session, clean)
              this.dropMirroredEmptyAssistant(session)
              continue
            }
            // Cap reached: surface the original error through the normal path.
            state.owed = false
            this.silentContinues.set(session.id, state)
            const failure: SessionAgentEvent = { ...clean, error: state.lastError }
            this.host.applySessionEvent(session, failure)
            this.host.emitEvent(failure)
            continue
          }
          // The app's own checkpoint aborts the live run before it compacts
          // (Pi's `compact` RPC settles the session first), so Pi records that
          // abort as an aborted/error assistant completion. That failure is the
          // app's doing, never a provider fault: carrying it to the engine would
          // paint an error card over a turn the continuation is about to finish.
          // Strip the error and drop the empty stub, exactly as the
          // silent-continue path does, so the resume is the only visible result.
          if (
            event.type === 'message.completed' &&
            event.error &&
            (this.turnStates.get(session.id)?.compacting === true ||
              this.pageCompactions.has(session.id))
          ) {
            const { error, ...clean } = event
            void error
            this.host.applySessionEvent(session, clean)
            this.dropMirroredEmptyAssistant(session)
            continue
          }
          this.host.applySessionEvent(session, event)
          this.host.emitEvent({ ...event, sessionId: session.id })
        }
        session.updatedAt = Date.now()
        // pi auto-retries transient failures, emitting `agent_end` for every
        // attempt, before `auto_retry_end` and finally `agent_settled`. Only
        // `agent_settled` is a stable signal that no retry or queued
        // continuation remains, so never finalize a turn on `agent_end`.
        if (record['type'] === 'agent_settled') {
          // A settled signal during an RPC-initiated compaction is the
          // compaction run itself finishing, not the end of the logical turn:
          // pi still owes the user a retry of the aborted prompt. Register the
          // compaction turn so its streaming and finalization are tracked like
          // any other turn, and never finalize here   the compaction's own
          // `agent_settled` finalizes the whole turn.
          if (this.turnStates.get(session.id)?.compacting) return
          if (record['aborted'] === true) this.silentContinues.delete(session.id)
          else if (this.beginSilentContinue(session)) return
          this.activeTurns.delete(session.id)
          void this.host.refreshSessionUsage(session).finally(() => {
            void this.finishTurn(session)
          })
        }
      })
      .catch((error) => {
        Logger.dev('Pi event handler dropped', error)
      })
  }

  /** Compact the session's transcript, keeping a live turn alive across it. */
  async compactSession(
    session: PersistentCliSession,
    projectPath: string,
    client: PiRpcClient
  ): Promise<void> {
    const sessionId = session.id
    // pi's `compact` RPC aborts any active run and then compacts, so it works
    // both mid-turn and on an idle session. Awaiting here keeps the handoff
    // deterministic from the caller's view; compaction_start/compaction_end
    // events stream out as it summarizes.
    const currentTurnState = this.turnStates.get(sessionId)
    this.turnStates.set(sessionId, {
      assistantMessageId: currentTurnState?.assistantMessageId ?? null,
      turnIndex: Math.max(
        currentTurnState?.turnIndex ?? 0,
        latestPiTurnIndex(session.messages, sessionId)
      ),
      compacting: true
    })
    this.activeTurns.add(sessionId)
    // pi's `compact` RPC aborts any active run before compacting. When a turn
    // was live (or a steer/follow-up was queued into the compaction window),
    // the work must resume after the checkpoint instead of silently dying:
    // pi drains queued steer/follow-up messages only inside an agent run, and
    // compaction leaves the session idle, so without a continuation the
    // queued messages strand forever and the user's steered input is lost.
    let before: Record<string, unknown> | null
    try {
      before = record(await client.getState())
    } catch {
      before = null
    }
    let continuationStarted = false
    try {
      const result = await client.compact()
      await this.handleRpcEvent({ type: 'compaction_end', result }, sessionId, projectPath)
      const after = record(await client.getState())
      // pi resumed the aborted run itself (overflow recovery)   let its own
      // `agent_settled` finalize the turn; do not compete with it.
      if (after?.['isStreaming'] === true) return
      const pending = numberValue(after?.['pendingMessageCount']) ?? 0
      const interrupted = before?.['isStreaming'] === true
      if (pending > 0 || interrupted) {
        // Clear the compacting flag before the continuation so the
        // continuation run's `agent_settled` finalizes the turn normally.
        const settled = this.turnStates.get(sessionId)
        if (settled) this.turnStates.set(sessionId, { ...settled, compacting: false })
        continuationStarted = true
        await client.prompt(
          'Continue from the Last working trace in the checkpoint. Complete the current step, then the next unfinished step.'
        )
        return
      }
    } finally {
      // A started continuation keeps the turn registered (its own settled
      // finalizes it); every other path finalizes right here so the thread
      // never lingers "working" until the watchdog reconciles.
      const state = this.turnStates.get(sessionId)
      if (state) this.turnStates.set(sessionId, { ...state, compacting: false })
      if (!continuationStarted && this.activeTurns.has(sessionId)) {
        this.activeTurns.delete(sessionId)
        await this.host.refreshSessionUsage(session).finally(() => void this.finishTurn(session))
      }
    }
  }

  /** Route app-owned extension status records and compaction requests. */
  handleExtensionStatus(record: Record<string, unknown>, sessionId: string): void {
    if (stringValue(record['statusKey']) === PI_COMPACTION_EXTENSION_KEY) {
      const request = parseRecord(record['statusText'])
      if (request?.['type'] === 'ready') this.host.markCompactionReady(sessionId)
      if (request?.['type'] === 'threshold') {
        void this.compactPageCheckpoint(sessionId, request['resume'] === true)
      }
      return
    }
    if (stringValue(record['statusKey']) === PI_USAGE_EXTENSION_KEY) {
      void this.host.handleUsageStatus(record, sessionId)
      return
    }
    if (stringValue(record['statusKey']) === CIO_SUBAGENT_STREAM_STATUS_KEY) {
      this.host.handleSubagentStreamStatus(record, sessionId)
      return
    }
    if (stringValue(record['statusKey']) !== PI_STATUS_EXTENSION_KEY) return
    const text = stringValue(record['statusText'])
    if (!text) return
    if (!this.activeTurns.has(sessionId)) return
    const state =
      text === PI_STATUS_WORKING || text === PI_STATUS_COMPACTING
        ? ({ state: 'working' } as const)
        : text === PI_STATUS_IDLE
          ? ({ state: 'idle' } as const)
          : null
    if (!state) return
    // A settle that lands inside a driver-owned checkpoint is not the turn's
    // end. Page checkpoints (`compactPageCheckpoint`) and oversized-request
    // recovery (`compactAndContinue`) abort the in-flight run, compact, and
    // re-prompt it, so the aborted run settles idle while this driver still
    // owns the turn, which is exactly the settle `agent_settled` already ignores
    // through the `compacting` turn state. The engine, however, treats ANY idle
    // status as the turn's end: it finalized the turn, tore down the turn's
    // utility gateway (handoff clear + gateway cleanup), and left the resumed
    // run with dead cio_util_* tools for the rest of the turn. Only a settle the
    // driver is not going to resume may be reported idle here; the turn's real
    // idle is this driver's own `session.idle` from `finishTurn`.
    if (state.state === 'idle' && this.turnIsMidCheckpoint(sessionId)) return
    // `agent_settled` remains the sole finalization trigger (usage stats +
    // session persistence); the idle status here only clears the busy flag.
    this.host.emitEvent({ type: 'session.status', sessionId, status: state })
  }

  /** Preserve the logical turn while the 85% checkpoint aborts, compacts, and resumes Pi. */
  private async compactPageCheckpoint(sessionId: string, resume: boolean): Promise<void> {
    const client = this.host.client(sessionId)
    const projectPath = this.host.projectOf(sessionId)
    const turn = this.turnStates.get(sessionId)
    if (
      !client ||
      !projectPath ||
      !turn ||
      turn.compacting ||
      this.pageCompactions.has(sessionId)
    ) {
      return
    }
    const ticket = { resume }
    this.pageCompactions.set(sessionId, ticket)
    this.turnStates.set(sessionId, { ...turn, compacting: true })
    this.activeTurns.add(sessionId)
    const current = () => this.pageCompactions.get(sessionId) === ticket
    try {
      // Native overflow recovery may already own the session. Let it finish
      // through the same page hook instead of interrupting its checkpoint.
      const state = record(await client.getState())
      if (!current() || state?.['isCompacting'] === true) return
      const result = await client.compact()
      if (!current()) return
      await this.handleRpcEvent(
        { type: 'compaction_end', result, reason: 'threshold' },
        sessionId,
        projectPath
      )
      if (!current()) return
      const after = record(await client.getState())
      if (!current()) return
      const latest = this.turnStates.get(sessionId)
      if (latest) this.turnStates.set(sessionId, { ...latest, compacting: false })
      if (after?.['isStreaming'] === true) return
      if (ticket.resume || (numberValue(after?.['pendingMessageCount']) ?? 0) > 0) {
        await client.prompt(
          'Continue from the Last working trace in the checkpoint. Complete the current step, then the next unfinished step.'
        )
      } else {
        const session = await this.host.requireSession(projectPath, sessionId)
        this.activeTurns.delete(sessionId)
        await this.host.refreshSessionUsage(session)
        await this.finishTurn(session)
      }
    } catch (error) {
      if (!current()) return
      const session = await this.host.requireSession(projectPath, sessionId)
      if (!current()) return
      // The compaction succeeded; only the resume failed. Recover through the
      // resilient continuation instead of discarding a healthy checkpointed
      // turn   a fresh RPC process resumes the persisted native transcript.
      const latest = this.turnStates.get(sessionId)
      if (latest) this.turnStates.set(sessionId, { ...latest, compacting: false })
      await this.promptContinuation(
        session,
        projectPath,
        'Continue from the Last working trace in the checkpoint. Complete the current step, then the next unfinished step.',
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      if (current()) {
        this.pageCompactions.delete(sessionId)
        const latest = this.turnStates.get(sessionId)
        if (latest) this.turnStates.set(sessionId, { ...latest, compacting: false })
      }
    }
  }

  /**
   * Whether this session's turn is being held across a checkpoint that resumes
   * it: a page checkpoint in flight (`compactPageCheckpoint` keeps the logical
   * turn through an abort + compact + re-prompt), a compaction run
   * (`compactAndContinue`, manual `/compact`), or the abort/compact window of
   * either. Tells a checkpoint's intermediate settle apart from the turn's real
   * end.
   */
  private turnIsMidCheckpoint(sessionId: string): boolean {
    return (
      this.pageCompactions.has(sessionId) || this.turnStates.get(sessionId)?.compacting === true
    )
  }

  /** Finalize a settled turn: reconcile compactions, persist, report idle. */
  async finishTurn(session: PersistentCliSession): Promise<void> {
    // A turn that ends without its own `auto_retry_end` (a watchdog kill, an
    // abort, a crashed process) must not leave the session reading as retrying:
    // the flag answers every liveness question, so a stale one would keep the
    // next turn permanently busy.
    const endedTurn = this.turnStates.get(session.id)
    if (endedTurn?.providerRetry === true) {
      this.turnStates.set(session.id, { ...endedTurn, providerRetry: false })
    }
    // Reconcile compactions against pi's durable session transcript before
    // persisting: the live RPC event stream loses compaction records on
    // process exit, watchdog finalization, and between-turn compactions, but
    // pi itself always wrote them durably to the session JSONL.
    try {
      await this.reconcileCompactions(session)
    } catch (error) {
      Logger.dev('Pi compaction reconciliation failed:', error)
    }
    try {
      await this.host.persistSession(session)
    } catch (error) {
      Logger.error('Pi session persistence failed:', error)
    }
    // The turn is over: clear the live-refresh throttle so the next turn's
    // first completed request refreshes its usage immediately.
    this.host.clearUsageThrottle(session.id)
    this.host.emitEvent({ type: 'session.idle', sessionId: session.id })
  }

  /**
   * Driver contract hook (`reconcileSession`): recover compaction reporting
   * from pi's durable session transcript when a session settled without
   * driver finalization, so the engine's finalization and the next turn's
   * history replay see the recovered boundary.
   */
  async reconcileSession(projectPath: string, sessionId: string): Promise<void> {
    const session = await this.host.requireSession(projectPath, sessionId)
    await this.reconcileCompactions(session)
    await this.host.persistSession(session)
  }

  private async reconcileCompactions(session: PersistentCliSession): Promise<void> {
    await reconcileNativeCompactions(
      session,
      this.host.projectOf(session.id),
      (messages) => this.host.mergeMessages(session, messages),
      this.host.agentDirectory
    )
  }

  /**
   * Drop the trailing assistant message the mirror captured for a flaked turn
   * when it produced no user-visible content, so the silent continue does not
   * leave a blank stub behind.
   */
  private dropMirroredEmptyAssistant(session: PersistentCliSession): void {
    const last = [...session.messages].reverse().find((message) => message.role === 'assistant')
    if (!last || last.error) return
    const hasContent = last.parts.some((part) => {
      if (part.type === 'text' || part.type === 'reasoning') return part.text.trim().length > 0
      return part.type === 'tool'
    })
    if (hasContent) return
    const index = session.messages.indexOf(last)
    if (index !== -1) session.messages.splice(index, 1)
  }

  /**
   * Claim a owed silent continue when the turn settles. Returns true when a
   * continuation was started (the turn stays active); false when there is
   * nothing owed and the turn should finalize normally.
   */
  private beginSilentContinue(session: PersistentCliSession): boolean {
    const state = this.silentContinues.get(session.id)
    if (!state?.owed) return false
    state.owed = false
    this.dropMirroredEmptyAssistant(session)
    const client = this.host.client(session.id)
    if (!client) {
      this.failSilentContinue(session, state.lastError)
      return true
    }
    if (state.compactFirst) {
      void this.compactAndContinue(session, client, state)
      return true
    }
    void this.promptContinuation(
      session,
      this.host.projectOf(session.id),
      'Continue.',
      state.lastError
    )
    return true
  }

  /** Re-prompt a settled turn on the continuation channel. A rejection here is
   *  a transport/state failure (pi rejects `prompt` only at transport level;
   *  provider errors stream as events afterwards), so recover instead of
   *  killing the turn: retry the live client once after a short settle, then
   *  boot a fresh RPC process (which resumes the persisted native transcript)
   *  and try again. Only a double failure finalizes the turn with the error. */
  private async promptContinuation(
    session: PersistentCliSession,
    projectPath: string | undefined,
    text: string,
    fallbackError: string
  ): Promise<void> {
    // A continuation is a prompt like any other: dispatching it into a session
    // whose replacement is still running kills it the moment pi disposes that
    // session (see `ensureClient`), so wait for any in-flight bootstrap.
    const live = await this.host.settledClient(session.id)
    if (live) {
      try {
        await live.prompt(text)
        return
      } catch (error) {
        Logger.error('Pi continuation prompt rejected by the live client', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      // The compaction lane can still be settling when the continuation is
      // issued; a short delay clears the transient busy state.
      await new Promise((resolve) => setTimeout(resolve, 300))
      try {
        await live.prompt(text)
        return
      } catch {
        // Fall through to the fresh-process recovery.
      }
    }
    if (projectPath) {
      try {
        this.host.disposeClient(session.id)
        const fresh = await this.host.ensureClient(projectPath, session.id)
        await fresh.prompt(text)
        return
      } catch (error) {
        Logger.error('Pi continuation retry on a fresh RPC process failed', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    this.failSilentContinue(session, fallbackError)
  }

  /**
   * Recover an oversized-request-body failure: compact the transcript so the
   * replayed history collapses into a summary and the next request fits the
   * provider's byte limit, then re-prompt. The turn stays active throughout  
   * the compaction run's own `agent_settled` is swallowed by the `compacting`
   * turn-state flag, and the continuation run finalizes the turn normally.
   */
  private async compactAndContinue(
    session: PersistentCliSession,
    client: PiRpcClient,
    state: PiSilentContinueState
  ): Promise<void> {
    const projectPath = this.host.projectOf(session.id)
    if (!projectPath) {
      this.failSilentContinue(session, state.lastError)
      return
    }
    const turnState = this.turnStates.get(session.id)
    this.turnStates.set(session.id, {
      assistantMessageId: turnState?.assistantMessageId ?? null,
      turnIndex: Math.max(
        turnState?.turnIndex ?? 0,
        latestPiTurnIndex(session.messages, session.id)
      ),
      compacting: true
    })
    try {
      const result = await client.compact()
      await this.handleRpcEvent({ type: 'compaction_end', result }, session.id, projectPath)
    } catch (error) {
      this.turnStates.set(session.id, {
        ...(this.turnStates.get(session.id) ?? { assistantMessageId: null, turnIndex: 0 }),
        compacting: false
      })
      this.failSilentContinue(session, error instanceof Error ? error.message : state.lastError)
      return
    }
    // Clear the compacting flag before starting the continuation so the
    // compaction run's `agent_settled` (if any) finalizes cleanly and the
    // continuation run owns the turn from there.
    const settled = this.turnStates.get(session.id)
    if (settled) this.turnStates.set(session.id, { ...settled, compacting: false })
    // `prompt`   not `followUp`   is the only correct continuation here. pi's
    // `compact` RPC aborts the run and settles to idle before summarizing, and
    // queued follow-ups are drained exclusively at the end of an active run,
    // so a follow-up queued into an idle session is never delivered (the turn
    // silently stalls   pi's own TUI re-prompts after compaction for the same
    // reason). A fresh prompt starts the new run when idle.
    // Arm the oversized-recovery extension before the continuation: the
    // compaction kept the recent transcript tail intact, and that tail is
    // exactly where multi-hundred-KB base64 image tool results live
    // compaction alone cannot bring the request body under the provider's
    // byte limit. While armed, the extension's `context` hook strips image
    // parts and oversized text from the REQUEST copy only; the transcript
    // keeps the originals. Disarmed again on the first successful completion.
    await this.host.publishOversizedRecovery(session.id, true)
    try {
      await client.prompt('Continue.')
    } catch (error) {
      // Keep the recovery armed: the fresh-process retry below still needs the
      // extension to strip image parts and oversized text from the request.
      await this.promptContinuation(
        session,
        projectPath,
        'Continue.',
        error instanceof Error ? error.message : state.lastError
      )
    }
  }

  /** Surface a silent continue that could not be started as a real error. */
  private failSilentContinue(session: PersistentCliSession, error: string): void {
    // Logged at error level: a silent-continue failure kills a real turn, and
    // the raw reason (pi process death, transport rejection) was previously
    // invisible everywhere but the user-facing card, making diagnosis impossible.
    Logger.error('Pi silent continue failed; finalizing the turn', {
      sessionId: session.id,
      error
    })
    this.silentContinues.delete(session.id)
    this.activeTurns.delete(session.id)
    this.host.emitEvent({
      type: 'session.error',
      sessionId: session.id,
      error: error || 'Pi turn failed'
    })
    void this.finishTurn(session)
  }
}
