import { resolve } from 'path'
import { Logger } from '../../system/logger'
import type { AuxiliaryModelCandidate } from '../../drivers/driver.interface'
import {
  buildTurnGradeQuestions,
  buildTurnGradeState,
  readTurnGrade,
  TURN_GRADE_JUDGE_HARNESS_ID,
  TURN_GRADE_SEAM
} from '../turn-grader-decision'
import type {
  AgentModelSelection,
  ThreadSettings,
  ModelRankingSnapshotRow,
  LocalRankingGradeProgress,
  LocalRankingGradeScope,
  RankingJudgeConfig
} from '../../../lib/types'
import { INBOX_PROJECT_ID } from '../../../lib/types'
import type {
  AuxiliaryRoute,
  FallbackRankingJudgeRoute,
  RankingGradeCandidate,
  RankingJudgeOutcome
} from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { ChatEngine } from '../chat-engine'

/** ChatEngine rankings-grade: one concern, moved verbatim from the composition root. */
export class ChatEngineRankingsGrade {
  constructor(private readonly host: ChatEngine) {}

  /**
   * The harness-agnostic fallback judge lane, resolved only when the graded
   * harness's own candidates and any auxiliary assignment cannot grade.
   * Candidate probes are tried in this order:
   *
   * 1. The model and account of a session that currently has an active turn:
   *    the judge the user is using right now, already authenticated and
   *    freshly exercised.
   * 2. The harness of any other registered session.
   * 3. Any other installed harness with a resolvable account, judged through
   *    that harness's own cheap-model candidates.
   *
   * A probe whose provider reported its usage window closed is demoted behind
   * free probes rather than dropped, so a fallback that exists always runs
   * even while every lane is congested. A probe that fails to resolve
   * (driver unavailable, account removed) is skipped silently; a null result
   * simply keeps the caller's existing failure path.
   */
  async resolveFallbackRankingJudge(
    workingDirectory: string,
    excludeHarnessIds: readonly string[]
  ): Promise<FallbackRankingJudgeRoute | null> {
    const excluded = new Set(excludeHarnessIds)
    interface FallbackProbe {
      harnessId: string
      accountId?: string
      /** Provider that owns the probe model, when read from a live session. */
      providerId?: string
      /** The exact model of the conversation the user has open, when known. */
      inUseModelId?: string
    }
    const active: FallbackProbe[] = []
    const idle: FallbackProbe[] = []
    for (const session of this.host.sessionRegistry.values()) {
      if (!session.driverId || excluded.has(session.driverId)) continue
      const probe: FallbackProbe = { harnessId: session.driverId, accountId: session.accountId }
      // A live session carries the exact model of the conversation the user is
      // in: read its settings back so the judge candidate is that model.
      if (session.projectId !== INBOX_PROJECT_ID && session.threadId) {
        const thread = await this.host.threadManager.getThread(session.projectId, session.threadId)
        if (thread?.settings && thread.settings.providerId && thread.settings.modelId) {
          probe.providerId = thread.settings.providerId
          probe.inUseModelId = thread.settings.modelId
        }
      }
      if (session.activeTurnId) active.push(probe)
      else idle.push(probe)
    }
    const harnessProbes: FallbackProbe[] = [...this.host.drivers.keys()]
      .filter((harnessId) => !excluded.has(harnessId))
      .map((harnessId) => ({ harnessId }))

    const resolved: Array<{ route: FallbackRankingJudgeRoute; untilMs: number | null }> = []
    const skipped: Array<{ route: FallbackRankingJudgeRoute; untilMs: number | null }> = []
    for (const probe of [...active, ...idle, ...harnessProbes]) {
      try {
        const account = await this.host.state.accountRegistry.resolve(
          probe.harnessId,
          probe.accountId
        )
        const driver = await this.host.driverForAccount(probe.harnessId, account.id)
        // The probe's exact conversation model is the first candidate when
        // the user has a live session on it; otherwise the harness's own
        // cheap-model discovery, which the shared one-shot runner also
        // de-duplicates against the settings fallback.
        const modelToCandidate = new Map<string, AuxiliaryModelCandidate>()
        if (probe.providerId && probe.inUseModelId) {
          modelToCandidate.set(probe.inUseModelId, {
            providerId: probe.providerId,
            modelId: probe.inUseModelId
          })
        }
        for (const candidate of driver.auxiliaryRouteCandidates?.() ?? []) {
          if (candidate.modelId) modelToCandidate.set(candidate.modelId, candidate)
        }
        const candidates = [...modelToCandidate.values()]
        if (candidates.length === 0) continue
        const modelId = candidates[0].modelId
        const candidateProviderId = candidates[0].providerId
        const settings: ThreadSettings = {
          harnessId: probe.harnessId,
          accountId: account.id,
          providerId: candidateProviderId,
          modelId,
          thinkingLevel: 'minimal',
          permissionLevel: 'auto_review',
          assignmentMode: false,
          loopMode: false
        }
        const untilMs = this.host.units['turns'].windowUntil(driver, candidates)
        const entry = {
          route: {
            driver,
            harnessId: probe.harnessId,
            providerId: candidateProviderId,
            modelId,
            accountId: account.id,
            candidates,
            settings
          },
          untilMs
        }
        if (untilMs === null) resolved.push(entry)
        else skipped.push(entry)
      } catch (error) {
        Logger.dev('Ranking fallback judge probe skipped:', {
          harnessId: probe.harnessId,
          error: rawErrorMessage(error)
        })
      }
    }
    return resolved[0]?.route ?? skipped[0]?.route ?? null
  }

  /**
   * Restart recovery: rows orphaned mid-claim by a crash return to the queue,
   * then every overdue closed conversation is drained. The stale-claim sweep
   * shares the drain guard so overlapping recoveries can never flip a row a
   * concurrent drain is actively judging.
   */
  async recoverPendingRankingGrades(): Promise<void> {
    await this.host.units['rankings-queue'].drainRankingQueue(true)
  }

  /** Live progress of the user-requested run, or null when the queue is idle. */
  rankingGradeRunStatus(): LocalRankingGradeProgress | null {
    return this.host.state.rankingManualRun ? { ...this.host.state.rankingManualRun } : null
  }

  /**
   * Stop the user-requested run at the end of the pass in flight.
   *
   * A pass is up to three harness processes, so cancelling cannot interrupt one
   * mid-judge; what it guarantees is that no further row is claimed, which is
   * what keeps a cancel from costing more than the batch already running.
   */
  cancelRankingGrade(): void {
    if (this.host.state.rankingManualRun) this.host.state.rankingManualRun.cancelled = true
  }

  /**
   * Grade the ranking queue now, on the user's explicit request.
   *
   * `due` runs the passes the automatic drain was about to run anyway, only
   * sooner. `all` additionally pulls every conversation still inside its
   * inactivity window forward and gives a conversation parked after exhausting
   * its retries one fresh attempt, so the queue a user is looking at actually
   * empties.
   *
   * The work stays in bounded passes: each one claims at most three rows, waits
   * for a breath, and re-reads the queue, so a backlog is never graded in one
   * burst and the main thread is never held. A second request while a run is in
   * flight joins it rather than starting a rival one, and two consecutive passes
   * that grade nothing end the run and report what is left, so a queue whose
   * judge routes are all inside a closed provider window cannot spin.
   */
  async gradeRankingQueueNow(
    scope: LocalRankingGradeScope,
    onProgress?: (progress: LocalRankingGradeProgress) => void
  ): Promise<LocalRankingGradeProgress> {
    const inFlight = this.host.state.rankingManualRunPromise
    if (inFlight) return inFlight
    const run = this.runRankingGradeQueue(scope, onProgress)
    this.host.state.rankingManualRunPromise = run
    try {
      return await run
    } finally {
      this.host.state.rankingManualRunPromise = null
    }
  }

  /**
   * The body of one user-requested run. Separate from the public entry point so
   * a joining request can await the very same promise and read its result.
   */
  async runRankingGradeQueue(
    scope: LocalRankingGradeScope,
    onProgress?: (progress: LocalRankingGradeProgress) => void
  ): Promise<LocalRankingGradeProgress> {
    const run: LocalRankingGradeProgress = {
      requested: 0,
      graded: 0,
      failed: 0,
      remaining: 0,
      cancelled: false
    }
    this.host.state.rankingManualRun = run
    const emit = (): void => onProgress?.({ ...run })
    try {
      const nowMs = Date.now()
      if (scope === 'all') {
        await this.host.rankingSnapshotRepo.requeueFailedRowsViaWorker(nowMs)
        await this.host.rankingSnapshotRepo.pullPendingForwardViaWorker(nowMs)
      }
      // A hold left by an earlier pass must not pace work the user just asked
      // for, and the stale-claim sweep runs on the first pass of a full run so
      // rows a crash left mid-judge are not counted as ungradable.
      this.host.state.rankingHeldRetryAtMs = null
      const inScope = (): number => {
        const counts = this.host.rankingSnapshotRepo.queueCounts(Date.now())
        return scope === 'all' ? counts.awaiting : counts.due
      }
      run.requested = inScope()
      // What the row shows while the run works: every conversation still
      // waiting, not only the ones this scope may grade, so a user grading the
      // due rows still sees how much of the queue is left behind them.
      run.remaining = await this.host.rankingSnapshotRepo.totalCount()
      emit()
      let firstPass = true
      let idlePasses = 0
      while (!run.cancelled && inScope() > 0) {
        const outcome = await this.host.units['rankings-queue'].drainRankingQueue(
          firstPass && scope === 'all'
        )
        firstPass = false
        // Another pass owns the drain right now: wait for it instead of
        // counting its work as an idle pass and giving up early.
        if (outcome === null) {
          await new Promise((resolve) => setTimeout(resolve, ChatEngine.RANKING_MANUAL_POLL_MS))
          run.remaining = await this.host.rankingSnapshotRepo.totalCount()
          emit()
          continue
        }
        if (outcome.scored === 0 && outcome.failed === 0) {
          idlePasses += 1
          if (idlePasses >= ChatEngine.RANKING_MANUAL_IDLE_PASSES) {
            run.remaining = await this.host.rankingSnapshotRepo.totalCount()
            emit()
            break
          }
        } else {
          idlePasses = 0
        }
        run.graded += outcome.scored
        run.failed += outcome.failed
        run.remaining = await this.host.rankingSnapshotRepo.totalCount()
        emit()
        if (!run.cancelled && inScope() > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, ChatEngine.RANKING_MANUAL_PASS_PAUSE_MS)
          )
        }
      }
      return { ...run }
    } finally {
      this.host.state.rankingManualRun = null
      emit()
    }
  }

  /**
   * The judge preference, defaulting to the automatic chain for a config
   * written before the setting existed.
   */
  async rankingJudgePreference(): Promise<RankingJudgeConfig> {
    const config = await this.host.storage.getConfig()
    return config.rankingJudge ?? { kind: 'automatic' }
  }

  /**
   * The route of a judge the user pinned to one exact model, or null when the
   * preference is not a model pin or the pin cannot be resolved (harness gone,
   * account signed out). An unresolvable pin is not an error: the caller falls
   * through to the automatic chain, which is the same route the app took before
   * the setting existed.
   */
  async resolvePinnedRankingJudge(projectPath: string): Promise<AuxiliaryRoute | null> {
    const preference = await this.rankingJudgePreference()
    if (preference.kind !== 'model') return null
    const { harnessId, providerId, modelId } = preference
    if (!harnessId || !providerId || !modelId) return null
    const selection: AgentModelSelection = {
      harnessId,
      providerId,
      modelId,
      ...(preference.accountId === undefined ? {} : { accountId: preference.accountId }),
      inferenceMode: preference.inferenceMode,
      contextWindow: preference.contextWindow,
      ...(preference.thinkingLevel === undefined ? {} : { thinkingLevel: preference.thinkingLevel })
    }
    try {
      const account = await this.host.state.accountRegistry.resolveForProvider(
        selection.harnessId,
        selection.providerId,
        selection.accountId
      )
      const driver = await this.host.driverForAccount(selection.harnessId, account.id)
      return this.host.units['runtime-agents'].buildAuxiliaryRoute(
        selection,
        account.id,
        driver,
        projectPath
      )
    } catch (error) {
      Logger.dev('Pinned ranking judge could not be resolved; using the automatic chain', {
        harnessId,
        providerId,
        modelId,
        error: rawErrorMessage(error)
      })
      return null
    }
  }

  /**
   * Record one judge failure and hold the harness back once it has failed
   * repeatedly.
   *
   * The retry write itself goes to the database worker: a retry is bookkeeping,
   * and a contended main connection was observed stalling the Electron main
   * thread on it for over half a second. The cooldown then pushes every due row
   * of that harness   including this one, whose retry deadline is the earliest
   * in the queue   out to a jittered deadline, so the herd that used to arrive
   * every five minutes becomes a slowly backed-off schedule. The queue is only
   * deferred, never dropped: a judge that recovers scores its backlog, and an
   * exhausted row still parks for the recovery pass.
   */
  async deferJudgeFailure(
    row: ModelRankingSnapshotRow,
    outcome: RankingJudgeOutcome
  ): Promise<void> {
    const now = Date.now()
    await this.host.rankingSnapshotRepo.deferOrParkViaWorker(
      row.id,
      row.claim_token ?? '',
      ChatEngine.RANKING_ATTEMPT_CAP,
      ChatEngine.spreadDeadline(ChatEngine.RANKING_RETRY_BASE_MS),
      now
    )
    const consecutive = (this.host.state.rankingJudgeFailures.get(row.harness_id) ?? 0) + 1
    this.host.state.rankingJudgeFailures.set(row.harness_id, consecutive)
    if (consecutive < ChatEngine.RANKING_JUDGE_FAILURE_THRESHOLD) return
    const cooldownMs = Math.min(
      ChatEngine.RANKING_JUDGE_COOLDOWN_BASE_MS *
        2 ** (consecutive - ChatEngine.RANKING_JUDGE_FAILURE_THRESHOLD),
      ChatEngine.RANKING_JUDGE_COOLDOWN_MAX_MS
    )
    const cooldownUntilMs = now + cooldownMs
    Logger.info('Ranking judge held back after repeated failures', {
      // The graded harness owns the queue and the cooldown; the judge identity
      // says which model actually failed, which an auxiliary assignment makes
      // a different harness from the graded one.
      harnessId: row.harness_id,
      viaAuxiliary: outcome.viaAuxiliary,
      judgeHarnessId: outcome.judgeHarnessId,
      judgeModelId: outcome.judgeModelId,
      consecutiveFailures: consecutive,
      cooldownMs
    })
    await this.host.rankingSnapshotRepo.deferQueuedHarnessCooldown(
      row.harness_id,
      cooldownUntilMs,
      cooldownMs * ChatEngine.RANKING_DEADLINE_JITTER_RATIO,
      now
    )
  }

  /**
   * Grade one ranked conversation with the app's TypeSafe capability.
   *
   * Null hands the row back to the harness lanes below exactly as they ran before
   * this existed. That covers every way the capability can fail to produce a
   * usable number, so a revoked key, an outage, and an unreadable answer all cost
   * a slower judge instead of a lost grade.
   */
  async gradeWithTypesafe(candidate: RankingGradeCandidate): Promise<RankingJudgeOutcome | null> {
    const capabilities = this.host.state.typesafeDecision
    if (!capabilities) return null
    const decision = await capabilities.decide({
      seam: TURN_GRADE_SEAM,
      state: buildTurnGradeState({
        userMessage: candidate.userMessage,
        assistantOutput: candidate.assistantOutput,
        followUp: candidate.followUp
      }),
      questions: buildTurnGradeQuestions(),
      // The grade is read from the answer's own distribution, so the capability's
      // floors   which ask for a confident yes   do not apply to a rating.
      thresholds: { noul: 0, confidence: 0 }
    })
    if (decision.status !== 'answered') {
      this.host.units['questions'].reportTypesafeFallthrough(
        decision.status,
        decision.detail,
        candidate
      )
      return null
    }
    const grade = readTurnGrade(decision.answers)
    if (!grade) {
      Logger.dev('TypeSafe returned no readable grade:', {
        harnessId: candidate.harnessId,
        modelId: candidate.modelId
      })
      return null
    }
    Logger.dev('Ranking grading completed on TypeSafe', {
      harnessId: candidate.harnessId,
      modelId: candidate.modelId,
      score: grade.score,
      confidence: grade.confidence,
      judgeModelId: decision.model,
      latencyMs: decision.latencyMs
    })
    return {
      score: grade.score,
      judgeHarnessId: TURN_GRADE_JUDGE_HARNESS_ID,
      judgeModelId: decision.model,
      viaAuxiliary: false
    }
  }

  /**
   * Judge one candidate and persist nothing. Returns the 0–10 score, or null on
   * judge failure, together with the judge that ran so a failure is reported
   * against the model that produced it rather than against the graded model.
   */
  async gradeCandidateCore(candidate: RankingGradeCandidate): Promise<RankingJudgeOutcome> {
    // Names the judge that actually ran; the outer catch reports a failure
    // against it, so an unusable auxiliary assignment is not misattributed to
    // the graded harness's own model.
    let judge: RankingJudgeOutcome = {
      score: null,
      judgeHarnessId: candidate.harnessId,
      judgeModelId: candidate.modelId,
      viaAuxiliary: false
    }
    try {
      // A pinned judge runs first, so the model a user chose on the Usage page is
      // the model that grades. The pin is a preference, never a lock: anything
      // short of a readable score falls through to the chain below, so choosing a
      // judge can only ever cost a slower grade, never a lost one.
      const workingDirectory = await this.host.units['turns'].auxiliaryWorkingDirectory()
      const preference = await this.rankingJudgePreference()
      if (preference.kind === 'model') {
        const pinned = await this.resolvePinnedRankingJudge(workingDirectory)
        if (pinned) {
          judge = {
            score: null,
            judgeHarnessId: pinned.harnessId,
            judgeModelId: pinned.modelId,
            viaAuxiliary: true
          }
          const pinnedScore = await pinned.driver.gradeTurn(workingDirectory, {
            settings: pinned.settings,
            candidates: pinned.candidates,
            userMessage: candidate.userMessage,
            assistantOutput: candidate.assistantOutput,
            followUp: candidate.followUp
          })
          if (typeof pinnedScore === 'number') {
            Logger.dev('Ranking grading completed on the pinned judge', {
              judgeHarnessId: pinned.harnessId,
              judgeModelId: pinned.modelId,
              gradedHarnessId: candidate.harnessId,
              gradedModelId: candidate.modelId,
              score: pinnedScore
            })
            return { ...judge, score: pinnedScore }
          }
          Logger.dev('Pinned judge returned no score; using the automatic chain', {
            judgeHarnessId: pinned.harnessId,
            judgeModelId: pinned.modelId,
            gradedHarnessId: candidate.harnessId
          })
        }
      }
      // TypeSafe whenever it is available: one HTTPS call with no process
      // spawn, no provider account and a judge outside every harness. Anything
      // short of a readable score falls through to the lanes below.
      const typesafe = await this.gradeWithTypesafe(candidate)
      if (typesafe) return typesafe

      // A user-assigned auxiliary model judges the conversation when one is
      // configured for the graded model's harness. Grading has no thread, so a
      // failed or unusable judge falls back to the graded model's own harness
      // candidate below, which is the only judge that stays inside that
      // harness's candidate mechanism.
      const auxiliary = await this.host.units['turns'].resolveAuxiliaryRoute({
        threadHarnessId: candidate.harnessId,
        projectPath: workingDirectory
      })
      if (auxiliary) {
        judge = {
          score: null,
          judgeHarnessId: auxiliary.harnessId,
          judgeModelId: auxiliary.modelId,
          viaAuxiliary: true
        }
        let auxiliaryScore: number | null = null
        try {
          auxiliaryScore = await auxiliary.driver.gradeTurn(auxiliary.projectPath, {
            settings: auxiliary.settings,
            candidates: auxiliary.candidates,
            userMessage: candidate.userMessage,
            assistantOutput: candidate.assistantOutput,
            followUp: candidate.followUp
          })
        } catch (error) {
          Logger.dev('Auxiliary agent grading failed; using the harness candidate judge:', {
            auxiliaryHarnessId: auxiliary.harnessId,
            auxiliaryModelId: auxiliary.modelId,
            error: rawErrorMessage(error)
          })
        }
        if (typeof auxiliaryScore === 'number') {
          Logger.dev('Ranking grading completed on the auxiliary agent', {
            harnessId: auxiliary.harnessId,
            modelId: auxiliary.modelId,
            gradedHarnessId: candidate.harnessId,
            score: auxiliaryScore
          })
          return { ...judge, score: auxiliaryScore }
        }
        // A judge that answers without a score is otherwise invisible: the run
        // silently falls through to the graded harness below, so name it here.
        Logger.dev('Auxiliary agent returned no score; using the harness candidate judge', {
          auxiliaryHarnessId: auxiliary.harnessId,
          auxiliaryModelId: auxiliary.modelId,
          gradedHarnessId: candidate.harnessId,
          gradedModelId: candidate.modelId
        })
      }
      // The snapshot is self-contained: grading judges the conversation payload,
      // never the project, so a deleted or renamed project cannot block it.
      // A harness whose own route already failed once is struck out of the
      // native lane, but only when a harness-agnostic fallback judge is
      // actually resolvable to take the row: a strike with no fallback is not
      // actionable, so the native lane still runs rather than burning the
      // row's attempt cap without a single grading call.
      const excludeHarnessIds = auxiliary
        ? [candidate.harnessId, auxiliary.harnessId]
        : [candidate.harnessId]
      const struckOut =
        (this.host.state.rankingNativeJudgeStrikes.get(candidate.harnessId) ?? 0) > 0
      const struckOutFallback = struckOut
        ? await this.resolveFallbackRankingJudge(workingDirectory, excludeHarnessIds)
        : null
      let nativeScore: number | null = null
      if (!struckOut || struckOutFallback === null) {
        try {
          const driver = await this.host.driverForAccount(candidate.harnessId)
          judge = {
            score: null,
            judgeHarnessId: candidate.harnessId,
            judgeModelId: candidate.modelId,
            viaAuxiliary: false
          }
          const score = await driver.gradeTurn(workingDirectory, {
            settings: {
              harnessId: candidate.harnessId,
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              thinkingLevel: candidate.thinkingLevel,
              permissionLevel: 'auto_review'
            },
            userMessage: candidate.userMessage,
            assistantOutput: candidate.assistantOutput,
            followUp: candidate.followUp
          })
          // A driver that violates its number-or-null contract is a judge
          // failure, not a score.
          nativeScore = typeof score === 'number' ? score : null
        } catch (error) {
          Logger.dev('Ranking grading failed on the graded harness:', {
            harnessId: candidate.harnessId,
            modelId: candidate.modelId,
            error: rawErrorMessage(error)
          })
          nativeScore = null
        }
        if (nativeScore === null) {
          this.host.state.rankingNativeJudgeStrikes.set(
            candidate.harnessId,
            (this.host.state.rankingNativeJudgeStrikes.get(candidate.harnessId) ?? 0) + 1
          )
        } else {
          this.host.state.rankingNativeJudgeStrikes.delete(candidate.harnessId)
          Logger.dev('Ranking grading completed', {
            harnessId: candidate.harnessId,
            modelId: candidate.modelId,
            score: nativeScore
          })
          return { ...judge, score: nativeScore }
        }
      }
      // No harness-native judge is available. Ranking measures the graded
      // model, so the judge's harness is an implementation detail: fall back
      // to the model and account the user is actively using, or to any other
      // resolvable harness's cheap candidates.
      const fallback =
        struckOutFallback ??
        (await this.resolveFallbackRankingJudge(workingDirectory, excludeHarnessIds))
      if (!fallback) return judge
      judge = {
        score: null,
        judgeHarnessId: fallback.harnessId,
        judgeModelId: fallback.modelId,
        viaAuxiliary: true
      }
      const fallbackScore = await fallback.driver.gradeTurn(workingDirectory, {
        settings: fallback.settings,
        candidates: fallback.candidates,
        userMessage: candidate.userMessage,
        assistantOutput: candidate.assistantOutput,
        followUp: candidate.followUp
      })
      // A driver that violates its number-or-null contract is a judge failure.
      return { ...judge, score: typeof fallbackScore === 'number' ? fallbackScore : null }
    } catch (error) {
      Logger.dev('Ranking grading failed:', rawErrorMessage(error))
      return judge
    }
  }
}
