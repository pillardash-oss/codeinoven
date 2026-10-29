import { latestWorkingTraceParts, mergeWorkingParts } from '$lib/working-trace-parts'
import { SvelteSet } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { threadTraceCache } from '$lib/stores/thread-trace-cache.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { isTodoToolPart, todoSnapshotMatchesTurn } from '$lib/agent-todos'
import { WORKING_TRACE_PAGE_SIZE, COMPLETED_TURN_PAGE_SIZE } from '$shared/types'
import type {
  AgentMessage,
  AgentPart,
  PromptAttachment,
  TurnStreamPartsChange,
  TurnStreamPartsPage,
  TurnStreamCompletedTurn
} from '$shared/types'
import {
  buildTranscriptIndex,
  getTurnFinalText,
  getTurnWorkingParts,
  hasRenderableWorkingParts,
  isActivityOnlyUserMessage,
  isTurnCompleted,
  isTurnTransparentUserMessage,
  lastTurnStartIndex,
  pendingTurnAnchorIndex,
  streamWorkingPartsForTurn,
  turnEndsOnQuestion,
  type TranscriptIndex
} from '../thread-turn-parts'
import type { ThreadView } from './ThreadView-board.svelte'
/** One concern of the ThreadView board. */
export class ThreadViewPollStreamParts {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root) throw new Error('ThreadViewPollStreamParts read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
  }

  /** Opened from `bind()`: the scope names a thread that exists after build. */
  bindTraceScope(): void {
    this.streamTrace = threadTraceCache.scope(
      this.root.handleAgentEvent.thread.projectId,
      this.conversationId
    )
  }
  /** The conversation identity for held-steer tracking: temporary chats use
   *  their own id, threads use the thread id. */
  conversationId = $derived(
    this.root.props.controller?.conversationId ?? this.root.handleAgentEvent.thread.id
  )

  /**
   * Every per-message turn question, answered once per structural change. The
   * transcript asks these once per mounted message per render; reading them from
   * here turns that into an array lookup and keeps a long transcript from being
   * rescanned on every streamed frame.
   */
  transcriptIndex = $derived(
    buildTranscriptIndex(
      this.root.buildSpecActionPrompt.structureMessages,
      this.root.abortRun.checkpoints
    )
  )

  /**
   * A user message transparent to the turn span the live parts are read with: an
   * activity notice, or a steer still held for its undo window. Held state is not
   * on the message, so it is checked here; the persisted rule covers reloads.
   */
  isTransparentTurnMessage(message: AgentMessage): boolean {
    return (
      isTurnTransparentUserMessage(message) ||
      (message.role === 'user' &&
        threadMessages.isSteerHeld(
          this.root.handleAgentEvent.thread.projectId,
          this.conversationId,
          message.id
        ))
    )
  }

  conversationBusy = $derived(
    (this.root.props.controller?.busy ?? false) ||
      agentRuns.isConversationBusy(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
  )

  /**
   * Whether no assistant row renders the work of the turn ending at `index`.
   *
   * A turn's trace normally mounts inside its own assistant message. A run that
   * has not mirrored one yet   a follow-up before its first assistant row, or a
   * steer still held under the running trace   has no such mount point, so its
   * trace has to render on its own. Reading this prevents mounting a second copy
   * beside the assistant row that already carries it.
   */
  turnAboveHasAssistantRow(index: number): boolean {
    for (let i = index - 1; i >= 0; i--) {
      const message = this.root.buildSpecActionPrompt.structureMessages[i]
      if (!message) break
      if (message.role === 'assistant') return true
      if (message.role === 'user' && !this.isTransparentTurnMessage(message)) break
    }
    return false
  }

  /**
   * The durable work of a turn that settled without ever mirroring an assistant
   * message: a provider error, a user stop, a paused will-retry wait.
   *
   * The live pending block above only exists while the run is busy, and the
   * assistant-message branch below only exists once an assistant row is
   * mirrored, so a settled turn with neither had no renderer at all: the trace
   * the reader was watching vanished on the error and only the user's message
   * was left, even though the durable fold still held every part. This keeps
   * that work on screen for as long as it is the transcript's own turn, in the
   * settled (not busy) presentation, and yields to the assistant branch the
   * moment the assistant row lands. */
  settledTurnParts = $derived.by(() => {
    if (this.conversationBusy || this.root.unmirroredTraceStartTime.brainstormReportRefreshing)
      return []
    if (pendingTurnAnchorIndex(this.root.buildSpecActionPrompt.structureMessages) === -1) return []
    // Only when no assistant row exists at all. An earlier assistant turn is
    // itself a mount point for this fold (`streamWorkingPartsForTurn` keeps
    // every part the mirror does not already carry before that turn), so
    // mounting a second card here would render the same work twice.
    if (lastTurnStartIndex(this.root.buildSpecActionPrompt.structureMessages) !== -1) return []
    const parts = this.streamWorkingPartsForPendingTurn()
    return latestWorkingTraceParts(parts).length > 0 ? parts : []
  })

  /** Whether the latest turn currently has any renderable working-trace parts.
   *  When the thread is busy but nothing has materialized to write to the
   *  screen yet (the agent is still connecting/assembling, or the hydrated
   *  turn carries no visible reasoning/tool/sub-agent parts), the bottom
   *  working placeholder must keep showing so the user never stares at a blank
   *  conversation. Uses the raw busy flag   delegated work is covered by the
   *  placeholder's `delegatedWorkBusy` term instead of a forward reference.
   *
   *  An unanswered follow-up/steer is the key empty window: the thread is busy
   *  working on that trailing user message, but `lastTurnStartIndex` still
   *  points at the previous (already rendered) assistant turn   whose parts
   *  must not be mistaken for the current work. Count nothing in that window
   *  so the bottom working placeholder keeps showing instead of a blank tail. */
  latestTurnRenderableParts = $derived.by(() => {
    const lastMessage =
      this.root.loadOlderMessages.messages[this.root.loadOlderMessages.messages.length - 1]
    if (
      this.conversationBusy &&
      lastMessage?.role === 'user' &&
      !isActivityOnlyUserMessage(lastMessage)
    )
      return []
    if (this.root.buildSpecActionPrompt.latestTurnInfo.startIndex === -1) return []
    const { leading, body } = getTurnWorkingParts(
      this.root.loadOlderMessages.messages,
      this.root.buildSpecActionPrompt.latestTurnInfo.startIndex,
      this.conversationBusy && this.root.buildSpecActionPrompt.latestTurnInfo.active,
      this.isTransparentTurnMessage
    )
    return [...leading, ...body]
  })

  /**
   * Whether the turn ending at `endIndex` may surface its closing statement in
   * the transcript (see `getTurnFinalText`) instead of holding it in the working
   * trace for the whole run.
   *
   * A turn that is over always may, and so does every turn older than the
   * newest one. The newest turn may only once the agent has handed the floor
   * back: it closed on a Codex `final_answer`, or it asked the reader a question
   * and is sitting on the answer. Until then the newest text is the agent
   * talking about work still in flight, so it stays in the trace with that work
   * rather than flashing through the reading position and jumping back out.
   */
  closingStatementVisible(endIndex: number, isLastTurnEnd: boolean): boolean {
    const closing = getTurnFinalText(
      this.root.loadOlderMessages.messages,
      endIndex,
      this.isTransparentTurnMessage
    )
    if (!closing) return false
    if (closing.phase === 'final_answer') return true
    if (!this.conversationBusy || !isLastTurnEnd) return true
    return turnEndsOnQuestion(
      this.root.loadOlderMessages.messages,
      endIndex,
      this.isTransparentTurnMessage
    )
  }

  /** Older backing entries one inner-scroll page pulls in. Bigger than the
   *  render page so a scroll gesture reveals a useful run of steps, small enough
   *  that mounting them never stalls a frame; the main process clamps it. */
  STREAM_OLDER_PAGE_SIZE = 60

  /**
   * Durable working-trace parts loaded from the SSE log. They fill gaps in the
   * live mirror and restore the latest trace after an app refresh. A trace that
   * is on screen pages older entries in as the reader scrolls its top, one page
   * per gesture; a trace nobody is watching holds only the newest page.
   *
   * The fold lives in a thread-keyed cache, never in this component. This view
   * is keyed by thread id, so component-local trace state was discarded on every
   * switch and rebuilt over IPC (`thread:loadStreamParts`): reopening a live
   * thread painted its header with only the parts the message mirror had
   * persisted and the real tail arrived seconds later. The cache paints the
   * trace it last showed on the first frame, and every durable read merges into
   * it additively, so the tail never blanks and never waits on a round trip.
   */
  // Intentional initial-value capture: Workspace keys this view by thread ID,
  // so the scope this mount owns can never change under it.
  // svelte-ignore state_referenced_locally
  /** Set by `bind()`: the cache scope this run's trace is folded into. */
  streamTrace = threadTraceCache.scope('', '')

  /** True while a durable read for this mount is current. A late page from a
   *  superseded read must not touch the (shared) cached fold. */
  streamPartsLoadGeneration = $state(0)

  /** Bumped whenever the durable fold is dropped (a steer, a new local turn).
   *  An older-page read started before it must not resurrect entries from the
   *  turn the reader has left. */
  streamFoldVersion = $state(0)

  clearStreamParts(): void {
    this.streamPartsLoadGeneration += 1
    this.streamFoldVersion += 1
    this.streamTrace.reset()
    this.completedTurns = []
    this.completedTurnsGeneration += 1
  }

  /** True when a read landed on a different logical turn than the one mounted:
   *  the harness took a steer, and the boundary moved with it. */
  foldBoundaryMoved(page: TurnStreamPartsPage | TurnStreamPartsChange): boolean {
    if (typeof page.turnStartTs !== 'number') return false
    if (this.streamTrace.turnStartTs === null) return false
    return page.turnStartTs !== this.streamTrace.turnStartTs
  }

  /**
   * The fold moved to a new turn: the harness took the steer.
   *
   * The turn that was running closes here. Its trace is re-read from the durable
   * log as a completed turn, so the work stays on screen above the message that
   * closed it and stays readable after a reload, and the new turn mounts its own
   * fold with its own first step.
   */
  async handleFoldBoundaryMove(nextTurnStartTs: number, generation: number): Promise<void> {
    this.streamTrace.turnStartTs = nextTurnStartTs
    void this.loadCompletedTurns()
    await this.remountNewestStreamParts(generation)
  }

  /**
   * Turns a prompt closed whose work the transcript has not mirrored, oldest
   * first: what the durable log holds of a run in flight.
   *
   * A steer opens a turn of its own, so the fold moves to it and the work before
   * it leaves the newest-turn window. The provider transcript only reaches the
   * mirror in batches at sync points, so until that lands the interrupted turn
   * has no assistant row at all and this record is the only copy of its trace.
   * Reading it is what keeps that work auditable across a reload.
   */
  completedTurns = $state<TurnStreamCompletedTurn[]>([])

  completedTurnsGeneration = $state(0)

  async loadCompletedTurns(): Promise<void> {
    const { projectId, id } = this.root.handleAgentEvent.thread
    const generation = ++this.completedTurnsGeneration
    try {
      const result = await invoke('thread:loadStreamParts', projectId, id, {
        completedTurns: true
      })
      if (!this.root.loadOlderMessages.alive || generation !== this.completedTurnsGeneration) return
      if (result.kind !== 'completedTurns') return
      this.completedTurns = result.turns
    } catch {
      // Best-effort: the transcript still renders whatever the mirror carries.
    }
  }

  /**
   * Page a closed turn's older entries.
   *
   * A closed turn can hold hundreds of steps, so it ships its newest window and
   * reads the rest only when the reader opens it, exactly as the live trace
   * does.
   */
  async loadOlderCompletedTurnParts(endTs: number): Promise<void> {
    const turn = this.completedTurns.find((candidate) => candidate.endTs === endTs)
    const oldest = turn?.parts[0]
    if (!turn || !turn.hasOlder || !oldest) return
    const generation = this.completedTurnsGeneration
    try {
      const page = await invoke(
        'thread:loadStreamParts',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        {
          turnEndTs: endTs,
          beforeId: oldest.id,
          limit: COMPLETED_TURN_PAGE_SIZE
        }
      )
      if (!this.root.loadOlderMessages.alive || generation !== this.completedTurnsGeneration) return
      if (page.kind !== 'window' || page.completedTurn !== true) return
      this.completedTurns = this.completedTurns.map((candidate) =>
        candidate.endTs === endTs
          ? {
              ...candidate,
              parts: [...page.parts, ...candidate.parts],
              start: page.start,
              hasOlder: page.hasOlder,
              total: page.total,
              totalSteps: page.totalSteps
            }
          : candidate
      )
    } catch {
      // The reader keeps the window they have; the next open retries.
    }
  }

  /**
   * Each closed turn paired with the message that closed it (the steer), which
   * is where its trace renders.
   *
   * A turn the transcript has meanwhile mirrored is dropped, because its own
   * assistant rows already render that work: the log's copy would show the same
   * steps twice. A turn whose anchor is not on screen yet has no place to render
   * either, so it waits until the transcript reaches it.
   */
  completedTurnViews = $derived.by(() => {
    if (this.completedTurns.length === 0) return []
    const views: Array<{ turn: TurnStreamCompletedTurn; anchorId: string }> = []
    for (const turn of this.completedTurns) {
      const anchorIndex = this.root.buildSpecActionPrompt.structureMessages.findIndex(
        (message) => message.role === 'user' && (message.createdAt ?? 0) >= turn.endTs
      )
      if (anchorIndex === -1) continue
      const mirrored = this.root.buildSpecActionPrompt.structureMessages
        .slice(0, anchorIndex)
        .some(
          (message) =>
            message.role === 'assistant' &&
            message.visibility !== 'subagent_trace' &&
            (message.createdAt ?? 0) >= turn.startTs &&
            (message.createdAt ?? 0) < turn.endTs
        )
      if (mirrored) continue
      views.push({
        turn,
        anchorId: this.root.buildSpecActionPrompt.structureMessages[anchorIndex].id
      })
    }
    return views
  })

  /** Adopt a durable read's task-list snapshot together with the turn it was
   *  folded for, so the card can reject it once the transcript moves on. */
  applyTodoSnapshot(page: TurnStreamPartsPage | TurnStreamPartsChange): void {
    this.streamTrace.todoParts = page.todoParts
    this.streamTrace.todoTurnStart = page.turnStartTs
  }

  /**
   * Todo updates are working-trace parts too. The durable stream is written
   * from the live event path and can be newer than the bounded message mirror
   * that arrives with the final thread update. Feed that freshest snapshot to
   * the task card so a trailing provider snapshot cannot rewind the visible
   * task state. Task-list parts never render in the trace, so they are carried
   * beside its window instead of inside it.
   *
   * The snapshot only counts while it still describes the turn the transcript
   * is on. It is refreshed only while this view watches a live turn or crosses
   * a boundary it observed, so once the transcript advanced to a newer prompt
   * the previous turn's snapshot is dropped: it is appended after the messages
   * and a task-list snapshot replaces the whole task map, so otherwise it would
   * overrule the fresher message state and leave a stale list, and a stale
   * highlight, on screen.
   */
  todoSnapshotIsCurrent = $derived.by(() => {
    if (this.streamTrace.todoParts.length === 0) return false
    return todoSnapshotMatchesTurn(this.streamTrace.todoTurnStart, this.turnAnchorCreatedAt())
  })

  todoMessages = $derived.by(() => {
    if (!this.todoSnapshotIsCurrent) return this.root.loadOlderMessages.messages
    const streamMessage: AgentMessage = {
      id: `${this.root.handleAgentEvent.thread.id}:todo-stream`,
      role: 'assistant',
      parts: this.streamTrace.todoParts,
      createdAt: Number.MAX_SAFE_INTEGER
    }
    return [...this.root.loadOlderMessages.messages, streamMessage]
  })

  /**
   * Creation time of the newest prompt that opened a turn.
   *
   * Activity-only user messages (compaction notices, sub-agent envelopes, the
   * app's own continuation prompts) ride mid-turn and a steer the harness has
   * not taken yet opens no turn at all, so both are skipped   the same boundary
   * the main process folds its turn stream by. This is the instant the turn on
   * screen is measured from, and unlike the run store's in-memory start it is
   * persisted, so it survives a window reload.
   */
  turnAnchorCreatedAt(): number | null {
    for (let index = this.root.loadOlderMessages.messages.length - 1; index >= 0; index--) {
      const message = this.root.loadOlderMessages.messages[index]
      if (!message || message.role !== 'user') continue
      if (isActivityOnlyUserMessage(message)) continue
      if (
        threadMessages.isSteerHeld(
          this.root.handleAgentEvent.thread.projectId,
          this.conversationId,
          message.id
        )
      )
        continue
      return message.createdAt || null
    }
    return null
  }

  /**
   * Read the newest durable trace window and adopt it into the shared fold.
   *
   * Fired at the top of the mount path so the request is in flight while the
   * session handshake runs, instead of queued behind the status, permission and
   * question reads. The fold is additive, so a hover preload that already
   * filled it only refreshes entries in place, and the cached fold keeps
   * painting while this read is in flight. Only the newest page crosses IPC;
   * older entries page in from the trace's own inner scroll.
   */
  async loadLatestTraceWindow(): Promise<TurnStreamPartsPage | null> {
    const generation = ++this.streamPartsLoadGeneration
    try {
      const page = await invoke(
        'thread:loadStreamParts',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        {
          limit: WORKING_TRACE_PAGE_SIZE
        }
      )
      if (
        !this.root.loadOlderMessages.alive ||
        generation !== this.streamPartsLoadGeneration ||
        page.kind !== 'window'
      )
        return null
      this.streamTrace.adoptWindow(page)
      return page
    } catch {
      // A missing fold is not a failed open: the mirror still paints.
      return null
    }
  }

  /** Undo a steered message that is still held before harness delivery. The
   *  steer never reached the agent, so the session continues untouched; on
   *  threads the text returns to the composer queue for editing/resending. */
  async undoHeldSteer(msg: AgentMessage): Promise<void> {
    try {
      await threadMessages.discardSteer(
        this.root.handleAgentEvent.thread.projectId,
        this.conversationId,
        msg.id
      )
      // Threads only: put the undone steer back into the FIFO composer queue
      // so the text and attachments are not lost   the user can edit and
      // resend. Temporary chats just drop the message.
      if (this.conversationId !== this.root.handleAgentEvent.thread.id) return
      const text = msg.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n\n')
      const attachments: PromptAttachment[] = msg.parts
        .filter((part) => part.type === 'file')
        .map((part) => ({ mime: part.mime, url: part.url, filename: part.filename }))
      rendererRecovery.setQueuedMessage(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        {
          text,
          attachments,
          promptReferences: [],
          projectReferences: [],
          taskReferences: [],
          startAfterThreads: []
        }
      )
      this.root.steerQueuedMessage.syncQueuedFromStore()
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The steer could not be undone.'
    }
  }

  /** True when the persisted latest turn shows a run was mid-flight when the
   *  live stream went away: the turn has not completed a terminal message but
   *  already persisted real working parts (reasoning, tool calls, sub-agents).
   *  This is the evidence used to rehydrate the working trace instead of the
   *  thread reading as idle or as a bare spinner when no live session confirms
   *  the run. */
  hasPersistedInFlightWork(): boolean {
    const startIndex = this.root.buildSpecActionPrompt.latestTurnInfo.startIndex
    if (startIndex === -1) return false
    if (isTurnCompleted(this.root.buildSpecActionPrompt.structureMessages, startIndex)) return false
    const { leading, body } = getTurnWorkingParts(
      this.root.loadOlderMessages.messages,
      startIndex,
      false,
      this.isTransparentTurnMessage
    )
    return hasRenderableWorkingParts([...leading, ...body])
  }

  /** Merge durable stream-log parts (freshest) with mirror parts, deduped by id
   *  and preserving the preferred list's order (see `mergeWorkingParts`). */
  /** The main-process stream fold is already scoped to the newest real user
   *  message by event timestamp. Do not filter it against historical part IDs:
   *  a resumed Pi process may restart its local message counter, so an old and
   *  current part can temporarily carry the same provider-generated ID. */
  streamWorkingPartsForPendingTurn(): AgentPart[] {
    const prompt = this.root.buildSpecActionPrompt.pendingLiveTurn
      ? this.root.buildSpecActionPrompt.structureMessages[
          this.root.buildSpecActionPrompt.pendingLiveTurn.userMessageIndex
        ]
      : undefined
    // Delivery and the durable poll arrive separately. Until the fold catches
    // up, its parts still belong above the new prompt, never below it.
    if (
      prompt &&
      (this.streamTrace.turnStartTs === null || this.streamTrace.turnStartTs < prompt.createdAt)
    )
      return []
    return this.streamTrace.parts.filter(
      (part) => part.type !== 'question' && !isTodoToolPart(part)
    )
  }

  /**
   * Whether the cached fold belongs to the turn starting at `startIndex`.
   *
   * The fold is cached per thread and painted on the first frame, before the
   * durable read for this mount lands. A fold that belongs to an earlier turn
   * must never render under a newer prompt in that window: the fold's boundary
   * is the prompt that opened its turn, so it has to sit at or after this
   * turn's own start. A fold with no boundary yet is not evidence of anything
   * and stays permissive.
   */
  foldBelongsToTurn(startIndex: number): boolean {
    const boundary = this.streamTrace.turnStartTs
    if (boundary === null) return true
    const turnStart = this.root.buildSpecActionPrompt.structureMessages[startIndex]
    return turnStart === undefined || boundary >= turnStart.createdAt
  }

  /**
   * Assemble one turn's working-trace parts from the mirror and the live
   * durable log, dropping the closing statement once the transcript shows it.
   *
   * `closingTextId` is the turn's closing statement when the transcript renders
   * it (so the trace must not show the same sentence twice), and
   * `holdsClosingText` is true while the trace still owns that text because the
   * transcript cannot show it yet. `collectsDurable` mirrors the original rule
   * that only the current assistant turn merges the durable fold ahead of the
   * mirror body.
   */
  buildTurnTrace(
    startIndex: number,
    closingTextId: string | null,
    holdsClosingText: boolean,
    collectsDurable: boolean
  ): AgentPart[] {
    const working = getTurnWorkingParts(
      this.root.loadOlderMessages.messages,
      startIndex,
      holdsClosingText,
      this.isTransparentTurnMessage
    )
    const durable =
      this.root.buildSpecActionPrompt.pendingLiveTurn || !this.foldBelongsToTurn(startIndex)
        ? []
        : streamWorkingPartsForTurn(
            this.streamTrace.parts,
            this.transcriptIndex,
            startIndex,
            holdsClosingText
          )
    const collected =
      this.streamTrace.parts.length > 0 && collectsDurable
        ? // The durable log is the turn's stream order, so it orders the body;
          // entries that streamed before this view mounted only exist there. The
          // leading context is not in the durable fold, so it stays in front.
          mergeWorkingParts([...working.leading, ...durable], working.body)
        : this.root.unmirroredTraceStartTime.withoutPendingLiveParts([
            ...working.leading,
            ...working.body
          ])
    if (this.root.unmirroredTraceStartTime.isAssignmentAuditorThread) {
      // The auditor transcript renders its own commentary from the trace and
      // keeps its deliverable (the report card) out of both, so its trace still
      // holds commentary prose.
      return collected.filter((part) => part.type !== 'text' || part.phase === 'commentary')
    }
    return closingTextId ? collected.filter((part) => part.id !== closingTextId) : collected
  }

  /**
   * Trace parts for a settled turn, memoized by the transcript index they were
   * assembled from.
   *
   * `messages` moves on every streamed frame, so without this a long thread
   * re-assembled EVERY mounted turn's trace on every frame even though only the
   * live turn can still change. The key is the index instance, which is rebuilt
   * exactly when the transcript's structure changes, so the cache can never
   * serve a trace the structure has moved past. The live/current turn   and a
   * turn whose pending live parts are still being reconciled   always
   * recomputes. Deliberately a plain array, never reactive: this is a pure
   * cache, so subscribing to it would only buy extra renders.
   */
  settledTurnTraces = new WeakMap<TranscriptIndex, (AgentPart[] | undefined)[]>()

  turnTraceParts(
    startIndex: number,
    live: boolean,
    closingTextId: string | null,
    holdsClosingText: boolean
  ): AgentPart[] {
    // Only the turn that is actually live merges the durable fold. A pending
    // turn elsewhere in the transcript must never let this turn's trace pull the
    // log's newest entries: they belong to the pending turn, which renders them
    // from its own block, and merging them here is what kept an interrupted
    // turn's trace growing past a steer.
    if (live) {
      return this.buildTurnTrace(startIndex, closingTextId, holdsClosingText, true)
    }
    let byStart = this.settledTurnTraces.get(this.transcriptIndex)
    if (!byStart) {
      byStart = []
      this.settledTurnTraces.set(this.transcriptIndex, byStart)
    }
    const cached = byStart[startIndex]
    if (cached) return cached
    const built = this.buildTurnTrace(startIndex, closingTextId, holdsClosingText, false)
    byStart[startIndex] = built
    return built
  }

  /** Poll the durable stream once: only what the log touched since the last
   *  read crosses IPC, so a long live turn neither re-ships nor re-mounts the
   *  whole turn once a second. A change read (not a growth read) because an
   *  entry that is already mounted has to keep up with its own updates, not just
   *  with whatever appears after it. */
  async pollStreamParts(): Promise<void> {
    const { projectId, id } = this.root.handleAgentEvent.thread
    const generation = ++this.streamPartsLoadGeneration
    const cursor = this.streamTrace.cursor
    try {
      const page = await invoke(
        'thread:loadStreamParts',
        projectId,
        id,
        cursor === null ? { limit: WORKING_TRACE_PAGE_SIZE } : { changedSince: cursor }
      )
      if (!this.root.loadOlderMessages.alive || generation !== this.streamPartsLoadGeneration)
        return
      if (page.kind === 'window') {
        if (this.foldBoundaryMoved(page)) {
          await this.handleFoldBoundaryMove(page.turnStartTs as number, generation)
          return
        }
        // No cursor yet (a mount read that has not landed): adopt the window.
        this.streamTrace.turnStartTs = page.turnStartTs ?? null
        this.streamTrace.setParts(mergeWorkingParts(this.streamTrace.parts, page.parts))
        this.streamTrace.hasOlder = page.hasOlder
        this.streamTrace.totalSteps = page.totalSteps
        this.applyTodoSnapshot(page)
        this.streamTrace.cursor = page.cursor
        return
      }
      // A completed-turn read is a different request shape; the poll never asks
      // for one, so anything but a window or a change is not this reader's.
      if (page.kind === 'completedTurns') return
      if (this.foldBoundaryMoved(page)) {
        await this.handleFoldBoundaryMove(page.turnStartTs as number, generation)
        return
      }
      this.streamTrace.turnStartTs = page.turnStartTs ?? this.streamTrace.turnStartTs
      this.streamTrace.cursor = page.cursor
      this.streamTrace.totalSteps = page.totalSteps
      this.applyTodoSnapshot(page)
      // A fold that shrank under us with the same boundary belongs to a log
      // rewritten after the fact: remount the newest page instead of keeping
      // entries that no longer belong here.
      if (page.total < this.streamTrace.parts.length) {
        await this.remountNewestStreamParts(generation)
        return
      }
      if (page.parts.length > 0)
        this.streamTrace.setParts(mergeWorkingParts(this.streamTrace.parts, page.parts))
    } catch {
      // Transient read failure   keep what we have and try again next tick.
    }
  }

  /**
   * One bounded durable read at a turn boundary. The 1s poll dies the moment
   * `busy` flips false, so task-list checkoffs that streamed into the log in
   * the last poll gap — or the whole tail that streamed while this view sat
   * inactive — would otherwise never reach the card, and the stale snapshot
   * outranks the fresher message cache because the synthetic stream message is
   * appended last and a todo-list snapshot replaces the whole task map. A turn
   * boundary is the one moment the card must read the durable truth, so a
   * finished thread can still clear its card on its own.
   */
  async refreshStreamTailAfterTurn(): Promise<void> {
    // A turn boundary is also when the provider transcript may have reached the
    // mirror, so a closed turn's durable copy is re-read here: the mirror's own
    // trace takes over and the log's copy stands down.
    void this.loadCompletedTurns()
    try {
      const page = await invoke(
        'thread:loadStreamParts',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        {
          limit: WORKING_TRACE_PAGE_SIZE
        }
      )
      if (!this.root.loadOlderMessages.alive || page.kind !== 'window') return
      if (this.foldBoundaryMoved(page)) {
        await this.handleFoldBoundaryMove(
          page.turnStartTs as number,
          this.streamPartsLoadGeneration
        )
        return
      }
      this.streamTrace.turnStartTs = page.turnStartTs ?? null
      this.streamTrace.setParts(mergeWorkingParts(this.streamTrace.parts, page.parts))
      this.streamTrace.hasOlder = page.hasOlder
      this.streamTrace.totalSteps = page.totalSteps
      this.applyTodoSnapshot(page)
      this.streamTrace.cursor = page.cursor
    } catch {
      // Best-effort: the message cache still carries the checkoffs, and the
      // next turn's poll or mount read rebuilds the fold again.
    }
  }

  /** Replace the mounted window with the newest durable page. */
  async remountNewestStreamParts(generation: number): Promise<void> {
    const page = await invoke(
      'thread:loadStreamParts',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      {
        limit: WORKING_TRACE_PAGE_SIZE
      }
    )
    if (
      !this.root.loadOlderMessages.alive ||
      generation !== this.streamPartsLoadGeneration ||
      page.kind !== 'window'
    )
      return
    this.streamTrace.turnStartTs = page.turnStartTs ?? this.streamTrace.turnStartTs
    this.streamTrace.setParts(page.parts)
    this.streamTrace.hasOlder = page.hasOlder
    this.streamTrace.totalSteps = page.totalSteps
    this.applyTodoSnapshot(page)
    this.streamTrace.cursor = page.cursor
  }

  /** Pull the next older durable page for the trace's own inner-scroll paging,
   *  prepending it in the log's own order. One page per call: the trace pages as
   *  the reader scrolls up rather than mounting the whole turn at once, which is
   *  what let a long turn overwhelm the screen the moment it opened.
   *
   *  The page is authoritative for the entries it carries: an entry the poll had
   *  already appended out of place (a part older than the mounted window that kept
   *  updating) adopts its real position instead of staying stuck at the tail. */
  async loadOlderStreamParts(): Promise<void> {
    const oldest = this.streamTrace.parts[0]
    if (!oldest || !this.streamTrace.hasOlder) return
    const foldVersion = this.streamFoldVersion
    const page = await invoke(
      'thread:loadStreamParts',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      {
        beforeId: oldest.id,
        limit: this.STREAM_OLDER_PAGE_SIZE
      }
    )
    if (
      !this.root.loadOlderMessages.alive ||
      page.kind !== 'window' ||
      foldVersion !== this.streamFoldVersion
    )
      return
    if (page.parts.length === 0) {
      this.streamTrace.hasOlder = false
      return
    }
    const pagedIds = new SvelteSet(page.parts.map((part) => part.id))
    const mountedBefore = this.streamTrace.parts.length
    this.streamTrace.setParts([
      ...page.parts,
      ...this.streamTrace.parts.filter((part) => !pagedIds.has(part.id))
    ])
    this.streamTrace.hasOlder = page.hasOlder
    this.streamTrace.totalSteps = page.totalSteps
    if (this.streamTrace.parts.length === mountedBefore) this.streamTrace.hasOlder = false
  }
}
