/**
 * Navigation-safe store for active agent runs and working-trace state.
 *
 * Keeps the "agent is working" flag and the current turn's walking-trace open
 * state keyed by thread, so switching away and back does not lose the trace.
 */

export type AgentRunActivity = 'session' | 'brainstorm_report'

/** Extra context for a background activity, e.g. which Brainstorm document
 *  phase is running so the UI can label it precisely. */
export interface AgentRunActivityDetail {
  phase: 'create' | 'refresh'
  version?: number
}

interface AgentRunEntry {
  /** True while the agent is processing the current turn. */
  busy: boolean
  /** The operation currently keeping the thread busy. */
  activity: AgentRunActivity
  /** Optional detail for the active background operation. */
  activityDetail: AgentRunActivityDetail | null
  /** True once live session activity has confirmed the run (vs an optimistic
   *  restore from a persisted in-flight status). The working trace is only ever
   *  expanded from a live-confirmed run so a stale DB status can't flash it
   *  open before the live session settles. */
  live: boolean
  /** When the current busy run started, used for the live working timer. */
  busySince: number | null
  /** When this thread last parked on a provider wait. A run start older than
   *  this belongs to the parked attempt, never to the run that resumed it. */
  parkedAt: number | null
  /** User message ID that started the current turn; used as the trace key. */
  currentTurnUserMessageId: string | null
  /** Whether the working trace is currently open. */
  traceOpen: boolean
  /** Provider retry deadline (epoch ms) while this thread waits on a
   *  usage/rate-limit reset; null when the thread is not scheduled to retry. */
  retryAt: number | null
  /** Whether the user explicitly opened the trace (vs auto-opened by busy state). */
  traceUserOpened: boolean
  /** True once the user explicitly folded the trace this turn. A folded trace
   *  stays folded across remounts (a window re-bound, "Load earlier messages")
   *  instead of being force-opened again by the busy state. */
  traceUserFolded: boolean
  /** When the last busy → idle transition happened, used by the thread row
   *  badge for "last action wins" ordering against side-chat unread marks. */
  settledAt: number
}

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

class AgentRunsStore {
  #runs = new Map<string, AgentRunEntry>()

  /** Reactive cache keyed by `projectId:threadId`. */
  runs = $state(new Map<string, AgentRunEntry>())

  private entry(projectId: string, threadId: string): AgentRunEntry {
    const key = threadKey(projectId, threadId)
    let entry = this.#runs.get(key)
    if (!entry) {
      entry = {
        busy: false,
        activity: 'session',
        activityDetail: null,
        live: false,
        busySince: null,
        parkedAt: null,
        currentTurnUserMessageId: null,
        traceOpen: false,
        retryAt: null,
        traceUserOpened: false,
        traceUserFolded: false,
        settledAt: 0
      }
      this.#runs.set(key, entry)
      this.runs = new Map(this.#runs)
    }
    return entry
  }

  /** True while the agent is processing a turn for this thread. */
  isBusy(projectId: string, threadId: string): boolean {
    return this.runs.get(threadKey(projectId, threadId))?.busy ?? false
  }

  /** The active operation, used when the conversation needs a more specific indicator. */
  activity(projectId: string, threadId: string): AgentRunActivity | null {
    const entry = this.runs.get(threadKey(projectId, threadId))
    return entry?.busy ? entry.activity : null
  }

  /** Detail for the active background operation, when present. */
  activityDetail(projectId: string, threadId: string): AgentRunActivityDetail | null {
    const entry = this.runs.get(threadKey(projectId, threadId))
    return entry?.busy ? (entry.activityDetail ?? null) : null
  }

  /** Scheduled provider retry deadline for this thread, or null when none. */
  retryAt(projectId: string, threadId: string): number | null {
    return this.runs.get(threadKey(projectId, threadId))?.retryAt ?? null
  }

  /** Record (or clear) the scheduled provider retry deadline for this thread. */
  setRetryAt(projectId: string, threadId: string, retryAt: number | null): void {
    const entry = this.entry(projectId, threadId)
    if (entry.retryAt === retryAt) return
    entry.retryAt = retryAt
    this.#notify()
  }

  /** Whether any tracked thread currently carries a provider retry deadline. */
  get hasPendingRetry(): boolean {
    for (const entry of this.runs.values()) {
      if (typeof entry.retryAt === 'number') return true
    }
    return false
  }

  /** True only while the interactive harness session owns the busy state. */
  isConversationBusy(projectId: string, threadId: string): boolean {
    const entry = this.runs.get(threadKey(projectId, threadId))
    return entry?.busy === true && entry.activity === 'session'
  }

  /** Whether this thread's run state has been settled by a live session check
   *  (a ThreadView mounted for it and its live status was observed, or its
   *  session streamed activity). Once settled, `isBusy` is authoritative and a
   *  stale persisted `planning`/`executing` status must not keep the working
   *  UI (row spinner, header indicator) alive. */
  hasSettled(projectId: string, threadId: string): boolean {
    return this.runs.has(threadKey(projectId, threadId))
  }

  /** ID of the user message that started the current turn, if any. */
  currentTurnUserMessageId(projectId: string, threadId: string): string | null {
    return this.runs.get(threadKey(projectId, threadId))?.currentTurnUserMessageId ?? null
  }

  /** Whether the current run has been confirmed by live session activity. */
  isLiveBusy(projectId: string, threadId: string): boolean {
    return this.runs.get(threadKey(projectId, threadId))?.live ?? false
  }

  /** When the current busy run started, or undefined when idle. */
  busySince(projectId: string, threadId: string): number | undefined {
    return this.runs.get(threadKey(projectId, threadId))?.busySince ?? undefined
  }

  /** When the last busy → idle transition happened for this thread, or 0 when
   *  the thread has never settled a run in this window. Used by the thread
   *  row badge for "last action wins" ordering against side-chat unread
   *  marks (see temporaryChatUnread.lastUnreadAt). */
  settledAt(projectId: string, threadId: string): number {
    return this.runs.get(threadKey(projectId, threadId))?.settledAt ?? 0
  }

  /** Whether the working trace is open for the current turn. */
  isTraceOpen(projectId: string, threadId: string): boolean {
    return this.runs.get(threadKey(projectId, threadId))?.traceOpen ?? false
  }

  /** Whether the user explicitly opened the trace. */
  isTraceUserOpened(projectId: string, threadId: string): boolean {
    return this.runs.get(threadKey(projectId, threadId))?.traceUserOpened ?? false
  }

  /** Whether the user explicitly folded the current turn's trace. */
  isTraceUserFolded(projectId: string, threadId: string): boolean {
    return this.runs.get(threadKey(projectId, threadId))?.traceUserFolded ?? false
  }

  /**
   * Mark a run as active. If a new turn is starting, resets trace state and
   * records the user message ID that owns the turn.
   *
   * `live` distinguishes a run confirmed by live session activity from an
   * optimistic restore off a persisted in-flight status; only live runs may
   * expand the working trace. `openTrace` controls whether becoming busy
   * auto-opens the trace (optimistic restores keep it closed until live
   * activity confirms the run).
   */
  setBusy(
    projectId: string,
    threadId: string,
    busy: boolean,
    turnUserMessageId?: string,
    startedAt?: number,
    live = true,
    openTrace = true,
    activity: AgentRunActivity = 'session',
    detail?: AgentRunActivityDetail
  ): void {
    const entry = this.entry(projectId, threadId)
    const previousBusy = entry.busy
    const previousActivity = entry.activity
    const previousActivityDetail = entry.activityDetail
    const previousLive = entry.live
    const previousBusySince = entry.busySince
    const previousTurnUserMessageId = entry.currentTurnUserMessageId
    const previousTraceOpen = entry.traceOpen
    const previousTraceUserOpened = entry.traceUserOpened
    const previousTraceUserFolded = entry.traceUserFolded
    const wasBusy = entry.busy
    const isNewTurn =
      busy &&
      turnUserMessageId !== undefined &&
      turnUserMessageId !== entry.currentTurnUserMessageId
    // A start time older than the last park is the run that was parked, not the
    // run that just resumed it. Honoring it is what kept a retried turn on the
    // parked attempt's clock, so its trace read minutes of work with no steps.
    const runStart =
      startedAt !== undefined && startedAt > 0 && startedAt >= (entry.parkedAt ?? 0)
        ? startedAt
        : undefined
    if (busy) {
      if (!wasBusy || isNewTurn) {
        entry.busySince = runStart ?? Date.now()
      } else if (runStart !== undefined) {
        entry.busySince = Math.min(entry.busySince ?? runStart, runStart)
      }
    }
    entry.busy = busy
    if (busy) entry.activity = activity
    if (busy) entry.live = live
    if (busy && detail) entry.activityDetail = detail
    if (!busy) entry.activityDetail = null

    if (isNewTurn && turnUserMessageId) {
      entry.currentTurnUserMessageId = turnUserMessageId
      entry.traceOpen = false
      entry.traceUserOpened = false
      entry.traceUserFolded = false
    }

    // Auto-open the trace when a new turn starts; auto-close when it ends
    // unless the user explicitly opened it.
    if (busy && (!wasBusy || isNewTurn)) {
      if (openTrace) entry.traceOpen = true
    } else if (!busy && !entry.traceUserOpened) {
      entry.traceOpen = false
    }

    if (
      entry.busy !== previousBusy ||
      entry.activity !== previousActivity ||
      entry.activityDetail !== previousActivityDetail ||
      entry.live !== previousLive ||
      entry.busySince !== previousBusySince ||
      entry.currentTurnUserMessageId !== previousTurnUserMessageId ||
      entry.traceOpen !== previousTraceOpen ||
      entry.traceUserOpened !== previousTraceUserOpened ||
      entry.traceUserFolded !== previousTraceUserFolded
    ) {
      this.#notify()
    }
  }

  /** Mark a non-conversation workflow operation as active without opening the prior turn trace. */
  setBackgroundBusy(
    projectId: string,
    threadId: string,
    activity: Exclude<AgentRunActivity, 'session'>,
    startedAt?: number,
    detail?: AgentRunActivityDetail
  ): void {
    this.setBusy(projectId, threadId, true, undefined, startedAt, false, false, activity, detail)
  }

  /** Clear a background operation only when it still owns the thread's busy state. */
  completeBackground(
    projectId: string,
    threadId: string,
    activity: Exclude<AgentRunActivity, 'session'>
  ): void {
    const entry = this.runs.get(threadKey(projectId, threadId))
    if (!entry?.busy || entry.activity !== activity) return
    this.setIdle(projectId, threadId)
  }

  /** Clear an interactive session only when a later background workflow has not taken ownership. */
  completeSession(projectId: string, threadId: string): void {
    const entry = this.runs.get(threadKey(projectId, threadId))
    if (entry?.busy && entry.activity !== 'session') return
    this.setIdle(projectId, threadId)
  }

  /** Toggle the working trace open/closed state, recording user intent.
   *  `userFolded` marks an explicit fold so a remount cannot force it back open. */
  setTraceOpen(
    projectId: string,
    threadId: string,
    open: boolean,
    userOpened: boolean,
    userFolded: boolean
  ): void {
    const entry = this.entry(projectId, threadId)
    entry.traceOpen = open
    entry.traceUserOpened = userOpened
    entry.traceUserFolded = userFolded
    this.#notify()
  }

  /**
   * Forget the trace state a visit left behind.
   *
   * Opening a trace is a gesture inside one visit, not a preference: a settled
   * thread must never come back with an old turn's trace expanded, so every
   * mount of a thread view starts from the fold the turn itself asks for. A
   * still-running turn re-opens on its own (see `setBusy`, and the busy effect
   * inside the trace), so nothing live is lost by clearing this.
   */
  resetTraceView(projectId: string, threadId: string): void {
    const entry = this.runs.get(threadKey(projectId, threadId))
    if (!entry) return
    if (!entry.traceOpen && !entry.traceUserOpened && !entry.traceUserFolded) return
    entry.traceOpen = false
    entry.traceUserOpened = false
    entry.traceUserFolded = false
    this.#notify()
  }

  /**
   * A session parked on a provider wait (a reset window, or a connection the
   * device lost) is not working: no work is being produced, and its harness
   * session reports `waiting` until it is admitted again. End the live run so
   * the conversation shows its waiting card instead of a live trace ticking
   * over zero steps, and keep the retry deadline on the entry so the surfaces
   * that schedule and order retries still read it. `parkedAt` invalidates the
   * parked attempt's start time, so the clock restarts when the retry fires.
   */
  setWaiting(projectId: string, threadId: string, retryAt: number | null): void {
    const entry = this.entry(projectId, threadId)
    const previousBusy = entry.busy
    const previousActivity = entry.activity
    const previousActivityDetail = entry.activityDetail
    const previousLive = entry.live
    const previousBusySince = entry.busySince
    const previousTurnUserMessageId = entry.currentTurnUserMessageId
    const previousTraceOpen = entry.traceOpen
    const previousRetryAt = entry.retryAt
    const previousParkedAt = entry.parkedAt
    // The park transition is the first waiting status after a run: later ones
    // keep it, so the deadline clock cannot drift on repeated statuses.
    entry.parkedAt = previousBusy || previousParkedAt === null ? Date.now() : previousParkedAt
    // A background workflow (a Brainstorm report refresh) owns the busy state
    // when it runs, so parking the session must not clear work that is still
    // live.
    if (entry.busy && entry.activity !== 'session') {
      entry.retryAt = retryAt
      if (entry.retryAt !== previousRetryAt) this.#notify()
      return
    }
    if (previousBusy) entry.settledAt = Date.now()
    entry.busy = false
    entry.activity = 'session'
    entry.activityDetail = null
    entry.live = false
    entry.busySince = null
    entry.currentTurnUserMessageId = null
    entry.retryAt = retryAt
    if (!entry.traceUserOpened) entry.traceOpen = false
    if (
      entry.busy !== previousBusy ||
      entry.activity !== previousActivity ||
      entry.activityDetail !== previousActivityDetail ||
      entry.live !== previousLive ||
      entry.busySince !== previousBusySince ||
      entry.currentTurnUserMessageId !== previousTurnUserMessageId ||
      entry.traceOpen !== previousTraceOpen ||
      entry.retryAt !== previousRetryAt ||
      entry.parkedAt !== previousParkedAt
    ) {
      this.#notify()
    }
  }

  /** Mark the run idle and close the trace unless the user opened it. */
  setIdle(projectId: string, threadId: string): void {
    const entry = this.entry(projectId, threadId)
    const previousBusy = entry.busy
    const previousActivity = entry.activity
    const previousActivityDetail = entry.activityDetail
    const previousLive = entry.live
    const previousBusySince = entry.busySince
    const previousTurnUserMessageId = entry.currentTurnUserMessageId
    const previousTraceOpen = entry.traceOpen
    const previousRetryAt = entry.retryAt
    if (previousBusy) {
      entry.settledAt = Date.now()
    }
    entry.busy = false
    entry.activity = 'session'
    entry.activityDetail = null
    entry.live = false
    entry.busySince = null
    entry.currentTurnUserMessageId = null
    entry.retryAt = null
    if (!entry.traceUserOpened) {
      entry.traceOpen = false
    }
    if (
      entry.busy !== previousBusy ||
      entry.activity !== previousActivity ||
      entry.activityDetail !== previousActivityDetail ||
      entry.live !== previousLive ||
      entry.busySince !== previousBusySince ||
      entry.currentTurnUserMessageId !== previousTurnUserMessageId ||
      entry.retryAt !== previousRetryAt ||
      entry.traceOpen !== previousTraceOpen
    ) {
      this.#notify()
    }
  }

  /** Clear the run state for a thread (e.g. on deletion). */
  clear(projectId: string, threadId: string): void {
    const key = threadKey(projectId, threadId)
    this.#runs.delete(key)
    this.#notify()
  }

  #notify(): void {
    this.runs = new Map(this.#runs)
  }
}

export const agentRuns = new AgentRunsStore()
