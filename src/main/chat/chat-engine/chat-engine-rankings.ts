import { Logger } from '../../system/logger'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type { RankingQueueHead } from '../../database/repositories/model-ranking-snapshot-repo'
import type {
  AuxiliaryRoute,
  FallbackRankingJudgeRoute,
  RankingPassPlan
} from './chat-engine-types'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine rankings: one concern, moved verbatim from the composition root. */
export class ChatEngineRankings {
  constructor(private readonly host: ChatEngine) {}

  /**
   * The user undid a turn's file changes: that turn is a rejected answer, so
   * the queued conversation window answering the same visible user message is
   * recorded as 0 without a judge (see `drainRankingQueue`). Matching by the
   * window's anchor   exactly the user message the turn answered   keeps an
   * undo from reaching an unrelated conversation. Returns the number of queued
   * windows caught, which is 0 once the score has already left the queue (an
   * already-applied aggregate cannot be re-scored).
   */
  markTurnRankingUndone(threadId: string, sourceMessageId: string | undefined): number {
    if (!sourceMessageId) return 0
    const marked = this.host.rankingSnapshotRepo.markUndoneForAnchor(
      threadId,
      sourceMessageId,
      Date.now()
    )
    // A row reset out of an in-flight claim is due immediately; arm the drain so
    // its 0 is not left waiting on a timer that never fires.
    if (marked > 0) this.host.scheduleRankingDrain()
    Logger.dev('Turn file changes undone; queued ranking window scores 0', {
      threadId,
      marked
    })
    return marked
  }

  /**
   * The user redid a previously undone turn's changes: clear the undo mark so
   * the restored work is graded normally again. Only a still-queued window can
   * be cleared; one already scored and deleted keeps its 0.
   */
  clearTurnRankingUndone(threadId: string, sourceMessageId: string | undefined): number {
    if (!sourceMessageId) return 0
    return this.host.rankingSnapshotRepo.clearUndoneForAnchor(threadId, sourceMessageId)
  }

  /**
   * The moment the judge routes of one queued row reopen, or null while at
   * least one route can still judge it.
   */
  rankingRowBlockedUntil(
    row: RankingQueueHead,
    native: HarnessDriver | null,
    auxiliary: AuxiliaryRoute | null,
    fallback: FallbackRankingJudgeRoute | null
  ): number | null {
    const nativeUntil = this.host.units['turns'].nativeRouteWindowUntil(row, native)
    // An auxiliary assignment pins exactly one candidate, so its route is known
    // in full and needs no discovery.
    const auxiliaryUntil = auxiliary
      ? this.host.units['turns'].windowUntil(auxiliary.driver, [
          { providerId: auxiliary.providerId, modelId: auxiliary.modelId }
        ])
      : null
    const fallbackUntil = fallback
      ? this.host.units['turns'].windowUntil(fallback.driver, fallback.candidates)
      : null
    // Either free route being enough: a held auxiliary or native window still
    // falls through, and a fallback judge keeps rows judgeable however blocked
    // the graded harness's routes are. `undefined` marks a lane that does not
    // exist at all, so an absent lane can never rescue a closed one.
    return this.host.units['misc'].blockedUntilOf([
      auxiliary ? auxiliaryUntil : undefined,
      nativeUntil,
      fallback ? fallbackUntil : undefined
    ])
  }

  /**
   * Hold back the rows whose window is still closed, one worker write per
   * distinct deadline.
   *
   * The rows are never claimed first: a queue that has to wait must not consume
   * judge attempts on work that cannot run, and must not report the null scores
   * that make a blocked window look like a failing judge. The write moves their
   * deadline, which is also what stops the drain from waking up on them again.
   * The returned flag says whether every write landed; the pass needs it because
   * a row that is still due after a failed write would otherwise be re-planned
   * the instant its window was discovered.
   */
  async deferHeldBackRankingRows(
    heldBack: RankingPassPlan['heldBack'],
    nowMs: number
  ): Promise<{ failed: boolean; earliestUntilMs: number } | null> {
    if (heldBack.length === 0) return null
    let failed = false
    for (const group of heldBack) {
      const result = await this.host.rankingSnapshotRepo.deferPendingRowsViaWorker(
        group.ids,
        group.untilMs,
        nowMs
      )
      failed = failed || !result.ok
    }
    const earliestUntilMs = Math.min(...heldBack.map((group) => group.untilMs))
    const rows = heldBack.reduce((total, group) => total + group.ids.length, 0)
    if (failed) {
      // The rows are still due in the queue and only this process holds their
      // pacing, so the lost write has to be visible rather than logged as a
      // hold-back that landed.
      Logger.error('Ranking rows could not be re-dated past their usage window', {
        rows,
        until: new Date(earliestUntilMs).toISOString()
      })
    } else {
      Logger.info('Ranking rows held back until their provider usage window reopens', {
        rows,
        until: new Date(earliestUntilMs).toISOString()
      })
    }
    return { failed, earliestUntilMs }
  }
}
