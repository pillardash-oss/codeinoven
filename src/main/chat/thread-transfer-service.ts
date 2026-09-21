/**
 * Move a running thread between CodeInOven instances.
 *
 * Two instances share one config root, so a window can see a thread a sibling is
 * running   the `active_turns` ledger names that process, and `ForeignRunService`
 * tells every window about it   but it cannot stream or stop a harness process it
 * does not own. Transferring the run is therefore a two-sided hand-off:
 *
 * 1. The window that wants the thread asks this service (`thread:transferRun`).
 * 2. This service asks the owning process, over the filesystem hand-off bus, to
 *    release the thread.
 * 3. The owning process stops that one run without latching a user stop, settles
 *    the turn, and acks.
 * 4. This service resumes the settled thread through the normal send-prompt
 *    pipeline, which claims the ledger row for this process and streams here.
 *
 * Ownership is never guessed: both sides read `active_turns.owner_pid`, exactly
 * as restart recovery and the foreign-run notice do, so a thread cannot be
 * transferred out from under a process that is not actually running it.
 */

import type { ThreadTransferResult } from '../../lib/types'
import type { Database } from '../database/database'
import { trustedIpcMain } from '../ipc/trusted-ipc-main'
import { instanceHandoffBus } from '../system/instance-handoff-bus'
import type { HandoffRequest } from '../system/instance-handoff-bus'
import { instanceRegistry } from '../system/instance-registry'
import { Logger } from '../system/logger'
import type { ChatEngine } from './chat-engine'

/**
 * Liveness probes, injectable so the two-sided rule can be exercised without a
 * second real app process. Defaults to the instance registry.
 */
export interface ThreadTransferServiceOptions {
  /** Whether the process that recorded a turn is still running. */
  isRunOwnerAlive?: (pid: number) => boolean
}

export class ThreadTransferService {
  private stopRequestListener: (() => void) | null = null
  private started = false
  private readonly isRunOwnerAlive: (pid: number) => boolean

  constructor(
    private readonly db: Database,
    private readonly chatEngine: ChatEngine,
    options: ThreadTransferServiceOptions = {}
  ) {
    this.isRunOwnerAlive =
      options.isRunOwnerAlive ?? ((pid) => instanceRegistry.isRunOwnerAlive(pid))
  }

  /**
   * Serve transfer requests on demand. Registered before `app:featuresReady`
   * so a window that mounts with the transfer card cannot race the handler.
   */
  registerIpc(): void {
    trustedIpcMain.handle('thread:transferRun', (_, projectId: string, threadId: string) =>
      this.transferToThisInstance(projectId, threadId)
    )
  }

  /** Start answering hand-off requests addressed to this process. */
  start(): void {
    if (this.started) return
    this.started = true
    instanceHandoffBus.start()
    this.stopRequestListener = instanceHandoffBus.onRequest((request) => {
      void this.handleRequest(request)
    })
  }

  /** Stop answering requests and drop the invoke handler. */
  dispose(): void {
    this.stopRequestListener?.()
    this.stopRequestListener = null
    this.started = false
    instanceHandoffBus.stop()
    trustedIpcMain.removeHandler('thread:transferRun')
  }

  /**
   * Take a foreign run over on this instance.
   *
   * A thread this process already owns (or one nobody owns) is not a transfer:
   * the window either has the run or is free to start one, so it succeeds
   * without touching the other instance.
   */
  async transferToThisInstance(projectId: string, threadId: string): Promise<ThreadTransferResult> {
    try {
      const ownerPid = await this.ownerPidFor(projectId, threadId)
      if (ownerPid === null || ownerPid === process.pid) return { ok: true }
      if (!this.isRunOwnerAlive(ownerPid)) {
        return {
          ok: false,
          reason: 'The instance running this thread is no longer running.'
        }
      }
      const ack = await instanceHandoffBus.request(ownerPid, projectId, threadId)
      if (ack.status !== 'accepted') {
        return {
          ok: false,
          reason: ack.reason ?? 'The instance running this thread did not hand it over.'
        }
      }
      return await this.chatEngine.adoptTransferredThread(projectId, threadId)
    } catch (error) {
      Logger.error('Cross-instance thread transfer failed:', error)
      return { ok: false, reason: 'The transfer could not be completed.' }
    }
  }

  /** Answer a sibling that asked this process to release a thread. */
  private async handleRequest(request: HandoffRequest): Promise<void> {
    if (request.targetPid !== process.pid) return
    try {
      const result = await this.chatEngine.releaseThreadForTransfer(
        request.projectId,
        request.threadId
      )
      await instanceHandoffBus.respond(
        request,
        result.released ? 'accepted' : 'refused',
        result.reason
      )
    } catch (error) {
      Logger.error('Cross-instance thread release failed:', error)
      await instanceHandoffBus.respond(
        request,
        'refused',
        'The instance running this thread could not stop its run.'
      )
    }
  }

  /** The process that recorded the thread's in-flight turn, if any. */
  private async ownerPidFor(projectId: string, threadId: string): Promise<number | null> {
    const result = await this.db.queryViaWorker(
      'SELECT owner_pid FROM active_turns WHERE project_id = ? AND thread_id = ?',
      [projectId, threadId],
      1
    )
    if (!result.ok) throw new Error(result.error ?? 'turn ownership query failed')
    const row = result.rows[0]
    if (!row) return null
    const owner = Number(row['owner_pid'])
    return Number.isInteger(owner) && owner > 0 ? owner : null
  }
}
