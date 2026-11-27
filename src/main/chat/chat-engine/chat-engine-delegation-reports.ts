import { Logger } from '../../system/logger'
import { join } from 'node:path'
import { messageId } from '../../../lib/id'
import { isThreadBusyStatus } from '../../../lib/thread-status-policy'
import type { ChatEngine } from '../chat-engine'
import {
  composeDelegationReportTurn,
  DELEGATION_REPORT_QUEUE_DIR,
  delegationReportQueueKey,
  delegationReportQueuePath,
  MAX_QUEUED_DELEGATION_REPORTS,
  parseDelegationReportQueue,
  selectDelegationReportBatch,
  type DelegationReportQueue,
  type QueuedDelegationReport
} from '../delegation/delegation-report-batch'

/** What a finished run hands the queue; the queue owns storage and delivery. */
export interface DelegationReportRequest {
  projectId: string
  threadId: string
  kind: QueuedDelegationReport['kind']
  text: string
  action: string
  body: string
}

/**
 * How long to wait before trying a delivery that failed on an idle thread again.
 *
 * An idle thread emits no further idle signal, so a failed attempt there has
 * nothing left to wake it: without this the reports sit on disk until the
 * person happens to send another message.
 */
const DELEGATION_REPORT_RETRY_MS = 30_000

/**
 * Delegated reports waiting for the thread that asked for them.
 *
 * Every finished pawn and every finished dispatched run reports here instead of
 * calling straight into the parent's session. The queue exists because "when it
 * finished" and "when the parent can hear it" are two different moments:
 *
 * - Ten pawns finishing together used to hand ten prompts to one session at
 *   once. A steer into a turn that was already ending threw, failed the whole
 *   dispatch and marked the parent's thread failed, so the parent got a wall of
 *   errors and none of the news.
 * - A report is not a user message. It must never cost the parent the turn it is
 *   running, so a queued report is delivered as the parent's *next* turn, never
 *   as a steer into the live one.
 * - One parent turn reads a small batch at a time, so ten reports are a few
 *   turns instead of ten processes, and nothing is lost if the app quits while
 *   they wait: the queue is on disk.
 */
export class ChatEngineDelegationReports {
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly host: ChatEngine) {}

  /** Record a finished run's report and start delivering whatever is due. */
  async enqueue(report: DelegationReportRequest): Promise<void> {
    const { projectId, threadId } = report
    await this.withQueueLock(projectId, threadId, async () => {
      const queue = await this.readQueue(projectId, threadId)
      queue.items.push({
        schemaVersion: 1,
        id: messageId(),
        projectId,
        threadId,
        kind: report.kind,
        text: report.text,
        action: report.action,
        body: report.body,
        createdAt: Date.now()
      })
      // A parent that is down for a long time must not grow an unbounded file.
      // The newest reports are the ones still worth reading, so the oldest go.
      if (queue.items.length > MAX_QUEUED_DELEGATION_REPORTS) {
        queue.items.splice(0, queue.items.length - MAX_QUEUED_DELEGATION_REPORTS)
      }
      await this.host.storage.write(delegationReportQueuePath(projectId, threadId), queue)
    })
    await this.drain(projectId, threadId)
  }

  /** How many reports are waiting for one thread. */
  async queuedReportCount(projectId: string, threadId: string): Promise<number> {
    const queue = await this.readQueue(projectId, threadId)
    return queue.items.length
  }

  /**
   * Deliver the next batch if the parent can take it, and report whether it did.
   *
   * "Can take it" means: the thread still exists, the thread is not busy, and its
   * session has no live turn or queued retry. Anything else leaves the batch in
   * the queue untouched   the session's idle signal drains it later, and a
   * delivery that throws keeps it for the next attempt instead of dropping news.
   */
  async drain(projectId: string, threadId: string): Promise<boolean> {
    const key = delegationReportQueueKey(projectId, threadId)
    const active = this.host.state.delegationReportDrains.get(key)
    if (active) return active
    const drain = (async (): Promise<boolean> => {
      const queue = await this.readQueue(projectId, threadId)
      const { batch } = selectDelegationReportBatch(queue.items)
      if (batch.length === 0) {
        // Nothing to deliver: a stale file is a leftover, not state.
        await this.host.storage
          .remove(delegationReportQueuePath(projectId, threadId))
          .catch(() => undefined)
        return false
      }
      const thread = await this.host.threadManager.getThread(projectId, threadId).catch(() => null)
      if (!thread || !thread.settings) {
        await this.host.storage
          .remove(delegationReportQueuePath(projectId, threadId))
          .catch(() => undefined)
        return false
      }
      if (isThreadBusyStatus(thread.status)) return false
      const sessionId = thread.sessionId
      const sessionState = sessionId ? this.host.sessionStatuses.get(sessionId)?.state : undefined
      if (sessionState === 'working' || sessionState === 'waiting') return false
      const turn = composeDelegationReportTurn(batch)
      const deliveredIds = batch.map((item) => item.id)
      try {
        await this.host.sendPrompt(
          projectId,
          threadId,
          thread.settings,
          turn.text,
          [],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'internal',
          { action: turn.action, body: turn.body },
          undefined,
          false,
          true
        )
      } catch (error) {
        Logger.error('A queued delegated report could not be delivered', {
          projectId,
          threadId,
          reports: batch.length,
          error: error instanceof Error ? error.message : String(error)
        })
        this.scheduleRetry(projectId, threadId)
        return false
      }
      await this.withQueueLock(projectId, threadId, async () => {
        const latest = await this.readQueue(projectId, threadId)
        const remaining = latest.items.filter((item) => !deliveredIds.includes(item.id))
        if (remaining.length === latest.items.length) return
        const path = delegationReportQueuePath(projectId, threadId)
        if (remaining.length === 0) {
          await this.host.storage.remove(path).catch(() => undefined)
          return
        }
        await this.host.storage.write(path, { ...latest, items: remaining })
      })
      this.clearRetry(projectId, threadId)
      return true
    })().finally(() => {
      if (this.host.state.delegationReportDrains.get(key) === drain) {
        this.host.state.delegationReportDrains.delete(key)
      }
    })
    this.host.state.delegationReportDrains.set(key, drain)
    return drain
  }

  /**
   * Deliver reports left behind by a process that stopped.
   *
   * Runs at launch: a parent that was idle when the app quit has a queue on disk
   * and no runtime to drain it, and its pawns' news must not depend on that.
   */
  async restoreQueues(): Promise<void> {
    let projects: string[]
    try {
      projects = await this.host.storage.listDirectories(DELEGATION_REPORT_QUEUE_DIR)
    } catch (error) {
      Logger.dev('Delegated report queues could not be listed:', error)
      return
    }
    for (const projectId of projects) {
      const projectPath = join(DELEGATION_REPORT_QUEUE_DIR, projectId)
      for (const entry of await this.host.storage.list(projectPath).catch(() => [])) {
        if (!entry.endsWith('.json')) continue
        const threadId = entry.slice(0, -'.json'.length)
        void this.drain(projectId, threadId).catch((error) =>
          Logger.dev('A restored delegated report could not be delivered:', {
            projectId,
            threadId,
            error: error instanceof Error ? error.message : String(error)
          })
        )
      }
    }
  }

  /** Try a failed idle-thread delivery again, once, later. */
  private scheduleRetry(projectId: string, threadId: string): void {
    const key = delegationReportQueueKey(projectId, threadId)
    if (this.retryTimers.has(key)) return
    const timer = setTimeout(() => {
      this.retryTimers.delete(key)
      void this.drain(projectId, threadId).catch(() => undefined)
    }, DELEGATION_REPORT_RETRY_MS)
    // A waiting report must never be the reason the process stays alive.
    timer.unref?.()
    this.retryTimers.set(key, timer)
  }

  private clearRetry(projectId: string, threadId: string): void {
    const key = delegationReportQueueKey(projectId, threadId)
    const timer = this.retryTimers.get(key)
    if (!timer) return
    clearTimeout(timer)
    this.retryTimers.delete(key)
  }

  private async readQueue(projectId: string, threadId: string): Promise<DelegationReportQueue> {
    const raw = await this.host.storage.read<unknown>(
      delegationReportQueuePath(projectId, threadId)
    )
    return parseDelegationReportQueue(raw, projectId, threadId)
  }

  /** Serialize queue read-modify-write for one thread, the same shape as the
   *  coordinator handoff queue so two finishes cannot overwrite each other. */
  private async withQueueLock<T>(
    projectId: string,
    threadId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = delegationReportQueueKey(projectId, threadId)
    const previous = this.host.state.delegationReportQueueLocks.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.host.state.delegationReportQueueLocks.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.host.state.delegationReportQueueLocks.get(key) === tail) {
        this.host.state.delegationReportQueueLocks.delete(key)
      }
    }
  }
}
