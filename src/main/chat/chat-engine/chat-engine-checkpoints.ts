import { Logger } from '../../system/logger'
import { compactionLineTokens } from '../../../lib/prompt-budget'
import { broadcastThreadUpdate } from '../thread-events'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type { ThreadCheckpoint, ThreadCheckpointKind, ThreadSettings } from '../../../lib/types'
import { rawErrorMessage } from './chat-engine-errors'
import type { ChatEngine } from '../chat-engine'

/**
 * Context checkpoints: the app's replacement for harness compaction.
 *
 * A session that has crossed the checkpoint line is not summarized in place. It
 * is **closed**, a successor is started on the same thread, and a
 * `thread_checkpoints` row records the boundary, the session that ended, and what
 * it had consumed. The conversation never moves — every row stays in the mirror,
 * tagged with the session it was written in — so the next window can read any of
 * the previous ones by thread id.
 *
 * This lives in the engine rather than in one harness because the two things it
 * needs are already app-owned: `createSession` on the driver and the thread's
 * session binding. That makes it work for every harness, including the ones that
 * compact on their own: the app checkpoints at its own line, which is below
 * theirs, and whatever boundary the harness produces anyway is still recorded.
 */
export class ChatEngineCheckpoints {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Replace the session when its context has crossed the line, before this turn
   * is dispatched into it.
   *
   * Returns the successor's session id when a checkpoint happened, so the caller
   * dispatches the turn into the new session, or undefined when the session is
   * still inside its window.
   *
   * Best-effort by design: a checkpoint that cannot be taken (the harness refuses
   * a new session, the driver is gone) leaves the turn on the session it has.
   * Losing a turn is worse than one window that ran long.
   */
  async checkpointBeforeTurn(input: {
    projectId: string
    threadId: string
    sessionId: string
    driver: HarnessDriver
    projectPath: string
    settings: ThreadSettings
  }): Promise<string | undefined> {
    const { projectId, threadId, sessionId, driver, projectPath, settings } = input
    // The same line the harnesses trigger on, so when a checkpoint happens does
    // not change — only what happens at it does.
    const usableInput = this.host.units['runtime-agents'].selectedModelInputBudget(
      settings.providerId,
      settings.modelId,
      projectId
    )
    const line = compactionLineTokens(usableInput)
    if (line <= 0) return undefined
    const used = await this.host.units['transcripts'].lastSessionContextUsed(
      projectId,
      threadId,
      driver.id,
      settings.providerId
    )
    if (used === undefined || used < line) return undefined
    return this.checkpoint({
      projectId,
      threadId,
      sessionId,
      driver,
      projectPath,
      settings,
      kind: 'auto',
      tokensBefore: used,
      label: `Checked in at ${Math.round(used / 1000)}k tokens`
    })
  }

  /**
   * Close one session and continue the thread on a newly created one, recording
   * the boundary. Shared by the automatic line, a harness switch, and the
   * manual action.
   */
  async checkpoint(input: {
    projectId: string
    threadId: string
    sessionId: string
    driver: HarnessDriver
    projectPath: string
    settings?: ThreadSettings
    kind: ThreadCheckpointKind
    tokensBefore?: number
    label?: string
    /** Set on a fork: the thread this one's history came from. */
    parentThreadId?: string
  }): Promise<string | undefined> {
    const { projectId, threadId, sessionId, driver, projectPath, settings } = input
    let row: ThreadCheckpoint | undefined
    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread) return undefined
      // The boundary is the last message the closed session saw, read before the
      // successor exists so the marker is what the old window actually covered.
      const boundary = await this.host.checkpoints.boundaryViaWorker(threadId)
      row = this.host.checkpoints.create({
        threadId,
        kind: input.kind,
        harnessId: driver.id,
        sessionId,
        projectPath,
        ...(settings?.providerId ? { providerId: settings.providerId } : {}),
        ...(settings?.modelId ? { modelId: settings.modelId } : {}),
        ...(settings?.accountId ? { accountId: settings.accountId } : {}),
        ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        ...(input.label ? { label: input.label } : {})
      })
      const successor = await driver.createSession(projectPath, thread.title)
      const bound = await this.host.threadManager.setSessionId(
        projectId,
        threadId,
        successor,
        driver.id,
        settings?.accountId
      )
      this.host.registerSession(
        successor,
        projectId,
        threadId,
        projectPath,
        settings?.permissionLevel ?? thread.settings?.permissionLevel ?? 'auto_review',
        driver.id
      )
      // A fresh session holds no history, so the next turn's recap is the brief
      // that names this thread and the checkpoints behind it.
      this.host.state.sessionNativeHistory.set(successor, false)
      this.host.checkpoints.close(row.id, {
        nextSessionId: successor,
        tokensBefore: input.tokensBefore,
        contextWindow: this.host.units['transcripts'].modelContextWindow(
          projectId,
          settings?.providerId,
          settings?.modelId
        ),
        ...(boundary?.id ? { boundaryMessageId: boundary.id } : {}),
        ...(boundary?.createdAt !== undefined ? { boundaryCreatedAt: boundary.createdAt } : {})
      })
      broadcastThreadUpdate(bound)
      Logger.info('Context checkpoint taken', {
        projectId,
        threadId,
        kind: input.kind,
        from: sessionId,
        to: successor,
        tokensBefore: input.tokensBefore
      })
      return successor
    } catch (error) {
      // The row is written before the successor exists. A failure after that
      // would leave a checkpoint whose session never ended, which every reader
      // would take as a boundary that lost its continuation, so it is removed.
      if (row) {
        this.host.checkpoints.delete(row.id)
      }
      Logger.error('Context checkpoint failed; continuing on the current session', {
        projectId,
        threadId,
        kind: input.kind,
        sessionId,
        error: rawErrorMessage(error)
      })
      return undefined
    }
  }

  /**
   * Record a session another path already closed — a harness switch creates or
   * resumes the successor itself — so the thread's windows stay complete
   * whichever path ended them.
   */
  async recordClosedSession(input: {
    projectId: string
    threadId: string
    sessionId: string
    harnessId: string
    nextSessionId: string
    kind: ThreadCheckpointKind
    projectPath: string
    label?: string
  }): Promise<void> {
    const boundary = await this.host.checkpoints.boundaryViaWorker(input.threadId)
    const row = this.host.checkpoints.create({
      threadId: input.threadId,
      kind: input.kind,
      harnessId: input.harnessId,
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      ...(input.label ? { label: input.label } : {})
    })
    this.host.checkpoints.close(row.id, {
      nextSessionId: input.nextSessionId,
      ...(boundary?.id ? { boundaryMessageId: boundary.id } : {}),
      ...(boundary?.createdAt !== undefined ? { boundaryCreatedAt: boundary.createdAt } : {})
    })
    Logger.info('Recorded a closed session as a context checkpoint', {
      projectId: input.projectId,
      threadId: input.threadId,
      kind: input.kind,
      from: input.sessionId,
      to: input.nextSessionId
    })
  }

  /**
   * The user's own checkpoint: the same swap as the automatic line, taken on
   * request. Returns the successor's session id, or undefined when the thread has
   * no session to close.
   */
  async checkpointNow(projectId: string, threadId: string): Promise<string | undefined> {
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread?.sessionId || !thread.settings) return undefined
    const driverId = thread.settings.harnessId
    const account = await this.host.state.accountRegistry.resolveForProvider(
      driverId,
      thread.settings.providerId,
      thread.sessionAccountId ?? thread.settings.accountId
    )
    const { driver, projectPath } = await this.host.resolve(
      projectId,
      driverId,
      threadId,
      account.id
    )
    const used = await this.host.units['transcripts'].lastSessionContextUsed(
      projectId,
      threadId,
      driver.id,
      thread.settings.providerId
    )
    return this.checkpoint({
      projectId,
      threadId,
      sessionId: thread.sessionId,
      driver,
      projectPath,
      settings: thread.settings,
      kind: 'manual',
      ...(used !== undefined ? { tokensBefore: used } : {}),
      label: 'Checked in on request'
    })
  }

  /** The thread's newest checkpoints, for the brief and the renderer's list. */
  async list(threadId: string, limit?: number): Promise<ThreadCheckpoint[]> {
    return this.host.checkpoints.listViaWorker(threadId, limit)
  }
}
