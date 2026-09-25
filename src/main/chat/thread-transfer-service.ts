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
import { trustedIpcMain } from '../ipc/trusted-ipc-main'
import { InstanceHandoffBus, instanceHandoffBus } from '../system/instance-handoff-bus'
import type { HandoffRequest } from '../system/instance-handoff-bus'
import { instanceRegistry } from '../system/instance-registry'
import { Logger } from '../system/logger'
import type { ChatEngine } from './chat-engine'

/**
 * The two chat-engine operations a transfer drives, one per side of the
 * hand-off: the owner releases the run, the adopter resumes it.
 */
export type ThreadTransferEngine = Pick<
  ChatEngine,
  'releaseThreadForTransfer' | 'adoptTransferredThread' | 'resolveTransferTarget'
>

/**
 * Liveness probes and transport, injectable so the two-sided rule can be
 * exercised without a second real app process. Defaults are the shared instance
 * registry and the app's hand-off bus.
 */
export interface ThreadTransferServiceOptions {
  /** Whether the process that recorded a turn is still running. */
  isRunOwnerAlive?: (pid: number) => boolean
  /** The peer-to-peer bus this service asks for a release over. */
  bus?: InstanceHandoffBus
}

export class ThreadTransferService {
  private stopRequestListener: (() => void) | null = null
  private started = false
  private readonly isRunOwnerAlive: (pid: number) => boolean
  private readonly bus: InstanceHandoffBus

  constructor(
    private readonly chatEngine: ThreadTransferEngine,
    options: ThreadTransferServiceOptions = {}
  ) {
    this.isRunOwnerAlive =
      options.isRunOwnerAlive ?? ((pid) => instanceRegistry.isRunOwnerAlive(pid))
    this.bus = options.bus ?? instanceHandoffBus
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
    this.bus.start()
    this.stopRequestListener = this.bus.onRequest((request) => {
      void this.handleRequest(request)
    })
  }

  /** Stop answering requests and drop the invoke handler. */
  dispose(): void {
    this.stopRequestListener?.()
    this.stopRequestListener = null
    this.started = false
    this.bus.stop()
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
      // A coordinated workflow is addressed by its coordinator and moves as one
      // unit; a plain thread is its own target. The engine resolves which, and
      // who owns it, from the same ledgers recovery uses, so a workflow can no
      // longer be split across two instances.
      const target = await this.chatEngine.resolveTransferTarget(projectId, threadId)
      const ownerPid = target.ownerPid
      if (ownerPid === null || ownerPid === this.bus.localPid) return { ok: true }
      if (!this.isRunOwnerAlive(ownerPid)) {
        return {
          ok: false,
          reason: 'The instance running this thread is no longer running.'
        }
      }
      const ack = await this.bus.request(ownerPid, projectId, target.rootThreadId)
      if (ack.status !== 'accepted') {
        return {
          ok: false,
          reason: ack.reason ?? 'The instance running this thread did not hand it over.'
        }
      }
      return await this.chatEngine.adoptTransferredThread(projectId, target.rootThreadId)
    } catch (error) {
      Logger.error('Cross-instance thread transfer failed:', error)
      return { ok: false, reason: 'The transfer could not be completed.' }
    }
  }

  /** Answer a sibling that asked this process to release a thread. */
  private async handleRequest(request: HandoffRequest): Promise<void> {
    if (request.targetPid !== this.bus.localPid) return
    try {
      const result = await this.chatEngine.releaseThreadForTransfer(
        request.projectId,
        request.threadId
      )
      await this.bus.respond(request, result.released ? 'accepted' : 'refused', result.reason)
    } catch (error) {
      Logger.error('Cross-instance thread release failed:', error)
      await this.bus.respond(
        request,
        'refused',
        'The instance running this thread could not stop its run.'
      )
    }
  }
}
