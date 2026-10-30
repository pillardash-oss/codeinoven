import { Logger } from '../../system/logger'
import type { HarnessDriver } from '../../drivers/driver.interface'
import { RANKING_RUBRIC_VERSION } from '../turn-grader-prompt'
import { isGreetingOnly } from '../greeting-filter'
import type { AgentMessage, Thread } from '../../../lib/types'
import { INBOX_PROJECT_ID, isOrchestrationChildThread } from '../../../lib/types'
import type {
  AuxiliaryRoute,
  FallbackRankingJudgeRoute,
  RankingDrainOutcome,
  RankingPassPlan,
  SessionInfo
} from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { textForMessage } from './chat-engine-message-text'
import {
  assistantTurnCostAccounting,
  toRankingCandidate,
  userInstructionText
} from './chat-engine-pure'
import { ChatEngine } from '../chat-engine'

/** ChatEngine rankings-queue: one concern, moved verbatim from the composition root. */
export class ChatEngineRankingsQueue {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Arm one process-wide wake-up for the earliest durable queue row.
   *
   * `delayOverrideMs` forces a wait (a full pass restarts sooner than the next
   * deadline), and a pending held-row retry floor raises every wait, so a wake
   * triggered from anywhere   a capture, a turn end, a thread deletion   cannot
   * restart the drain on rows whose deferral never landed.
   */
  scheduleRankingDrain(delayOverrideMs?: number): void {
    if (this.host.gradeDrainTimer) clearTimeout(this.host.gradeDrainTimer)
    const now = Date.now()
    if (
      this.host.state.rankingHeldRetryAtMs !== null &&
      this.host.state.rankingHeldRetryAtMs <= now
    ) {
      this.host.state.rankingHeldRetryAtMs = null
    }
    const holdMs =
      this.host.state.rankingHeldRetryAtMs === null ? 0 : this.host.state.rankingHeldRetryAtMs - now
    const nextDeadline = this.host.rankingSnapshotRepo.nextDueDeadline()
    if (nextDeadline === null && holdMs <= 0) {
      this.host.gradeDrainTimer = null
      return
    }
    const queuedMs = nextDeadline === null ? 0 : Math.max(0, nextDeadline - now)
    const delay = Math.max(delayOverrideMs ?? queuedMs, holdMs)
    this.host.gradeDrainTimer = setTimeout(
      () => {
        this.host.gradeDrainTimer = null
        void this.drainRankingQueue()
      },
      Math.min(2_147_483_647, delay)
    )
  }

  /**
   * Independent grading runner. Each pass reads a bounded window of the due
   * queue, decides which rows it may judge before it claims anything (a route
   * whose provider already reported its usage window closed is held back
   * unclaimed, see `planRankingPass`), claims at most three of the rest, and
   * scores each one: on success exactly one aggregate increment plus the
   * snapshot hard-delete in one transaction. Failed judges retry with bounded
   * backoff up to the attempt cap, then park as failed for the recovery pass; a
   * harness whose judge keeps failing has its queue held back instead of being
   * retried row by row (see `deferJudgeFailure`).
   */
  async drainRankingQueue(requeueStale = false): Promise<RankingDrainOutcome | null> {
    if (this.host.state.gradeDrainRunning) return null
    this.host.state.gradeDrainRunning = true
    let processed = 0
    let scored = 0
    let failed = 0
    let plan: RankingPassPlan = { claimIds: [], heldBack: [] }
    let planFailed = false
    let heldBackDeferral: { failed: boolean; earliestUntilMs: number } | null = null
    try {
      if (requeueStale) await this.host.rankingSnapshotRepo.requeueStaleProcessing()
      const nowMs = Date.now()
      await this.host.rankingSnapshotRepo.requeueFailedForRecovery(
        ChatEngine.RANKING_RECOVERY_COOLDOWN_MS,
        nowMs
      )
      try {
        plan = await this.planRankingPass(nowMs)
      } catch (error) {
        // Planning must never take the queue down with it: judge nothing this
        // pass, say so, and retry at the held-row interval rather than looping.
        planFailed = true
        Logger.dev('Ranking queue planning failed:', rawErrorMessage(error))
      }
      heldBackDeferral = await this.host.units['rankings'].deferHeldBackRankingRows(
        plan.heldBack,
        nowMs
      )
      const rows = this.host.rankingSnapshotRepo.claimRows(nowMs, plan.claimIds)
      for (const row of rows) {
        // A window the user undid is a verdict no judge can improve on: the
        // model's work was rejected wholesale, so it is recorded as 0 without
        // spending a judge call. `outcome` is only consulted when a judge
        // actually ran.
        const undone = row.undone_at_ms !== null
        const candidate = toRankingCandidate(row)
        const outcome = undone
          ? null
          : await this.host.units['rankings-grade'].gradeCandidateCore(candidate)
        const score = outcome ? outcome.score : 0
        if (score !== null) {
          this.host.state.rankingJudgeFailures.delete(row.harness_id)
          const durationMs = Math.max(0, row.ended_at - row.started_at)
          const applied = this.host.rankingSnapshotRepo.deleteScoredInTransaction(
            row.id,
            row.claim_token ?? '',
            () => {
              this.host.rankingRepo.increment({
                harnessId: row.harness_id,
                providerId: row.provider_id,
                modelId: row.model_id,
                thinkingLevel: row.thinking_level,
                shotCategory: row.shot_category,
                score,
                durationMs,
                costUsd: row.cost_usd,
                rubricVersion: RANKING_RUBRIC_VERSION
              })
            }
          )
          // The snapshot vanished mid-drain or was re-claimed by a later
          // generation (stale judge result); never defer or double-count it.
          if (applied) {
            processed += 1
            scored += 1
          }
          continue
        }
        if (outcome) {
          await this.host.units['rankings-grade'].deferJudgeFailure(row, outcome)
        }
        processed += 1
        failed += 1
      }
    } finally {
      this.host.state.gradeDrainRunning = false
      // Rows a failed deferral left due would be planned again the instant the
      // timer fired, so a pass that judged nothing waits a bounded retry
      // interval instead of spinning on rows it cannot claim.
      // Rows a failed deferral (or a failed plan) left due would be planned
      // again the instant any trigger armed the timer, so the retry floor is
      // kept on the instance where every `scheduleRankingDrain` call sees it.
      const needsFloor = planFailed || heldBackDeferral?.failed === true
      this.host.state.rankingHeldRetryAtMs = needsFloor
        ? Math.min(
            heldBackDeferral?.earliestUntilMs ?? Number.POSITIVE_INFINITY,
            Date.now() + ChatEngine.RANKING_HELD_RETRY_MS
          )
        : null
      this.host.scheduleRankingDrain(
        processed >= ChatEngine.RANKING_DRAIN_BATCH_SIZE
          ? ChatEngine.RANKING_DRAIN_RESTART_MS
          : undefined
      )
    }
    // Returned after the `finally` on purpose: returning from inside it would
    // swallow a judge error thrown by the pass, turning a real failure into a
    // quiet "graded nothing" result.
    return { scored, failed }
  }

  /**
   * Decide what this pass may judge, before any row is claimed or any harness
   * process is spent.
   *
   * A row is held back only when every judge route it would take is inside a
   * provider usage window the provider already reported closed: the
   * user-assigned auxiliary model when one exists, the graded harness's own
   * discovered candidates, and the harness-agnostic fallback judge (see
   * `resolveFallbackRankingJudge`). Everything else   a driver that cannot be resolved
   * or cannot name its route, no auxiliary assignment, one free candidate, a
   * window that already reopened   keeps the row judgeable, so a wrong guess can
   * only ever postpone a row whose route was genuinely closed.
   */
  async planRankingPass(nowMs: number): Promise<RankingPassPlan> {
    const head = this.host.rankingSnapshotRepo.dueQueueHead(
      nowMs,
      ChatEngine.RANKING_QUEUE_SCAN_SIZE
    )
    if (head.length === 0) return { claimIds: [], heldBack: [] }
    const projectPath = await this.host.units['turns'].auxiliaryWorkingDirectory()
    const drivers = new Map<string, Promise<HarnessDriver | null>>()
    const routes = new Map<string, Promise<AuxiliaryRoute | null>>()
    const fallbacks = new Map<string, Promise<FallbackRankingJudgeRoute | null>>()
    // One resolution per harness for the whole window: the routes and their
    // drivers are the same for every row of a harness, only the graded model
    // differs, and re-resolving them per row would re-read the config.
    const driverFor = (harnessId: string): Promise<HarnessDriver | null> => {
      const cached = drivers.get(harnessId)
      if (cached) return cached
      const pending = Promise.resolve(this.host.driverForAccount(harnessId)).catch(() => null)
      drivers.set(harnessId, pending)
      return pending
    }
    const routeFor = (harnessId: string): Promise<AuxiliaryRoute | null> => {
      const cached = routes.get(harnessId)
      if (cached) return cached
      const pending = this.host.units['turns'].resolveAuxiliaryRoute({
        threadHarnessId: harnessId,
        projectPath
      })
      routes.set(harnessId, pending)
      return pending
    }
    // One fallback resolution per harness: the graded harness and its
    // auxiliary assignment are excluded, and the fallback's drivers are the
    // same for every row, so only the exclusion set differs per harness.
    const fallbackFor = (
      harnessId: string,
      exclude: readonly string[]
    ): Promise<FallbackRankingJudgeRoute | null> => {
      const cached = fallbacks.get(harnessId)
      if (cached) return cached
      const pending = this.host.units['rankings-grade']
        .resolveFallbackRankingJudge(projectPath, exclude)
        .catch(() => null)
      fallbacks.set(harnessId, pending)
      return pending
    }
    const claimIds: string[] = []
    const heldBack = new Map<number, string[]>()
    // A pinned judge stands in for the auxiliary lane across the whole window:
    // it is one route for every row, so it is resolved once, and it is the lane
    // the pass would actually grade with. An unresolvable pin leaves the lane
    // exactly as it was, because grading then falls back to the same chain.
    const pinned = await this.host.units['rankings-grade'].resolvePinnedRankingJudge(projectPath)
    for (const row of head) {
      const native = await driverFor(row.harness_id)
      const auxiliary = pinned ?? (await routeFor(row.harness_id))
      const fallback = await fallbackFor(
        row.harness_id,
        auxiliary ? [row.harness_id, auxiliary.harnessId] : [row.harness_id]
      )
      const untilMs = this.host.units['rankings'].rankingRowBlockedUntil(
        row,
        native,
        auxiliary,
        fallback
      )
      if (untilMs === null) {
        claimIds.push(row.id)
        // A full batch ends the pass: the window is scanned again one pass
        // later, which keeps the work per pass bounded.
        if (claimIds.length >= ChatEngine.RANKING_DRAIN_BATCH_SIZE) break
        continue
      }
      const group = heldBack.get(untilMs)
      if (group) group.push(row.id)
      else heldBack.set(untilMs, [row.id])
    }
    return {
      claimIds,
      heldBack: [...heldBack].map(([untilMs, ids]) => ({ untilMs, ids }))
    }
  }

  /**
   * Capture or extend the ranking window for a completed, error-free turn that
   * answered a real instruction.
   *
   * Ranking answers one question: how well does a model perform when it is
   * instructed to do actual work? Only an implementation turn on a real project
   * qualifies, so every other surface returns early:
   *
   * - Standalone Chats live in the Inbox project and Temporary side chats are
   *   ephemeral sessions that never reach this path. Neither has a repository to
   *   implement anything in.
   * - Brainstorm, PRD, specification-authoring, and Assignment or Achievement
   *   turns write a document or delegate work instead of implementing it.
   * - A turn the app drove itself never becomes a shot and never rewrites the
   *   prompt a shot grades. A resolved question card, a spec-contract
   *   continuation, an incomplete-turn recovery, and an audit rework all
   *   continue an instruction the user already gave, so they may only refresh
   *   that shot's answer.
   *
   * One snapshot per conversation: the first graded instruction opens a
   * `first_shot` window; a later instruction on the same thread upgrades it to
   * `multi_shot` and appends its prompt as judge context. The window stays open
   * until the conversation closes   thread deletion or the inactivity deadline
   *   and is graded exactly once at that point. Greeting-only first prompts
   *   never enter the queue, so they never consume judge tokens.
   *
   * A shot is counted per user instruction, never per provider turn, and the
   * instruction is the turn's own dispatch record rather than the newest
   * user-origin row in the mirror: a question card persisted mid-turn is
   * visible but is not a new instruction (see `registerCompletedExchange`).
   */
  async openRankingSnapshot(
    info: SessionInfo,
    thread: Thread | null,
    mirror: AgentMessage[],
    turnAssistant: AgentMessage,
    awaitingUser: boolean
  ): Promise<void> {
    if (awaitingUser) return
    if (!thread?.settings) return
    const projectId = info.projectId
    const threadId = info.threadId
    // Standalone Chats run in the Inbox project: there is no repository and no
    // work of the user's to rank.
    if (projectId === INBOX_PROJECT_ID) return
    // Assignment and Achievement threads orchestrate: the model there delegates,
    // audits, and reports instead of implementing.
    if (
      isOrchestrationChildThread(thread) ||
      thread.assignmentRole === 'coordinator' ||
      thread.achievementRole === 'coordinator'
    ) {
      return
    }
    // A planning turn authors a Brainstorm, PRD, specification, or Assignment
    // decomposition   documents, not implementations. The mark is set at
    // dispatch by the same branch that selects the planning prompt.
    if (this.host.state.planningSessions.has(info.sessionId)) return
    if (!turnAssistant.modelId && !thread.settings.modelId) return
    const brainstormStage = this.host.state.brainstormEngine.getWorkflowState(
      projectId,
      threadId
    )?.stage
    if (brainstormStage === 'drafting') return
    const prdStage = this.host.state.prdEngine.getWorkflowState(projectId, threadId)?.stage
    if (prdStage === 'drafting' || prdStage === 'brainstorming') return
    // Whether the user wrote this turn's instruction cannot be read back from
    // the persisted record: `persistOutboundMessage` stores every prompt that
    // carries a presentation as a visible user message, so an audit rework or a
    // question resume the app composed looks exactly like a card the user
    // clicked. The dispatch origin is recorded on the session instead.
    const userDriven = info.activeTurnOrigin === 'user'
    const dispatch = info.activeTurnUserMessageId
      ? mirror.find((message) => message.id === info.activeTurnUserMessageId)
      : undefined
    const endedAt = turnAssistant.completedAt ?? turnAssistant.createdAt ?? Date.now()
    const assistantText = textForMessage(turnAssistant).slice(0, 6_000)
    const open = this.host.rankingSnapshotRepo.openForThread(threadId)
    if (open) {
      // Later exchange on the still-open window. A prompt this window already
      // answers is a repeat (invisible continuation or resumed retry) and
      // refreshes the final answer instead of upgrading to multi_shot. If the
      // drain had already claimed the row, it is reset to pending and the stale
      // judge result is discarded by its delete guard. An app-driven turn
      // repeats the window's own anchor, so it can only ever refresh an answer.
      const promptId = userDriven && dispatch ? dispatch.id : open.anchor_message_id
      // A window with no recorded anchor (a row from before the anchor column
      // existed) cannot be refreshed without inventing one, so it is left to
      // close on its inactivity deadline.
      if (!promptId) return
      const promptText = userDriven && dispatch ? userInstructionText(dispatch).slice(0, 6_000) : ''
      this.host.rankingSnapshotRepo.registerCompletedExchange(
        open.id,
        promptId,
        promptText,
        assistantText,
        endedAt,
        endedAt + ChatEngine.spreadDeadline(ChatEngine.RANKING_INACTIVITY_CLOSE_MS)
      )
      this.host.scheduleRankingDrain()
      return
    }
    // No window is open, so an app-driven turn has no instruction of its own to
    // grade.
    if (!userDriven || !dispatch) return
    const parentText = userInstructionText(dispatch)
    if (isGreetingOnly(parentText)) return
    const { costUsd, costStatus } = assistantTurnCostAccounting(turnAssistant)
    // Await the durable insert so the drain timer is armed against a settled
    // queue   otherwise a session ending right after capture could miss the
    // inactivity deadline until the next trigger or restart.
    await this.host.rankingSnapshotRepo.insertViaWorker({
      threadId,
      projectId,
      shotCategory: 'first_shot',
      harnessId: turnAssistant.harnessId ?? thread.settings.harnessId,
      providerId: turnAssistant.providerId ?? thread.settings.providerId ?? '',
      modelId: turnAssistant.modelId ?? thread.settings.modelId ?? '',
      thinkingLevel: turnAssistant.thinkingLevel ?? thread.settings.thinkingLevel ?? '',
      startedAt: dispatch.createdAt ?? endedAt,
      endedAt,
      dueAtMs: endedAt + ChatEngine.spreadDeadline(ChatEngine.RANKING_INACTIVITY_CLOSE_MS),
      userMessageText: parentText.slice(0, 6_000),
      assistantOutputText: assistantText,
      anchorMessageId: dispatch.id,
      costUsd,
      costStatus
    })
    this.host.scheduleRankingDrain()
  }
}
