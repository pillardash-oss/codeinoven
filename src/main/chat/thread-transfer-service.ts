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
 *
 * Only one hand-off may be in flight per thread. Two windows asking at the same
 * moment would otherwise both pass the owner's "is this still my turn" check
 * before either stopped anything, both get an ack, and both adopt, leaving two
 * harness writers on one session. A shared mutex   see
 * {@link ThreadTransferLock}   closes that: the receiving side holds `adopt` for
 * the whole hand-off and hands its token to the owner, and the owner holds
 * `release` while it stops and settles.
 */

import type { ThreadTransferResult } from '../../lib/types'
import { trustedIpcMain } from '../ipc/trusted-ipc-main'
import { InstanceHandoffBus, instanceHandoffBus } from '../system/instance-handoff-bus'
import type { HandoffRequest } from '../system/instance-handoff-bus'
import { instanceRegistry } from '../system/instance-registry'
import type { ThreadTransferLock } from '../system/thread-transfer-lock'
import { Logger } from '../system/logger'
import type { ChatEngine } from './chat-engine'

/**
 * The two chat-engine operations a transfer drives, one per side of the
 * hand-off: the owner releases the run, the adopter resumes it.
 */
export type ThreadTransferEngine = Pick<
  ChatEngine,
  'releaseThreadForTransfer' | 'adoptTransferredThread' | 'resolveTransferTarget'
> &
  Partial<Pick<ChatEngine, 'releaseIdleCodexThreadForTransfer' | 'attachThreadTransferPreflight'>>

/**
 * Liveness probes and transport, injectable so the two-sided rule can be
 * exercised without a second real app process. Defaults are the shared instance
 * registry and the app's hand-off bus.
 */
export interface ThreadTransferServiceOptions {
  /** Whether the process that recorded a turn is still running. */
  isRunOwnerAlive?: (pid: number) => boolean
  /** Live app processes to ask when no active-turn row names an idle writer. */
  liveInstancePids?: () => number[] | null
  /**
   * Whether a sibling app instance exists at all. The hand-off bus only keeps
   * its backstop poll armed while one does, because a peer is the only thing
   * that can write a request this process has to answer.
   */
  hasPeerInstance?: () => boolean
  /** The peer-to-peer bus this service asks for a release over. */
  bus?: InstanceHandoffBus
  /**
   * The per-thread transfer mutex. Both sides of a hand-off share one through
   * the config root database, so a second transfer of the same thread is refused
   * instead of racing the first into a second harness writer.
   */
  locks?: ThreadTransferLock
}

export class ThreadTransferService {
  private stopRequestListener: (() => void) | null = null
  private started = false
  private readonly isRunOwnerAlive: (pid: number) => boolean
  private readonly liveInstancePids: () => number[] | null
  private readonly hasPeerInstance: () => boolean
  private readonly bus: InstanceHandoffBus
  private readonly locks: ThreadTransferLock | null
  private detachPromptPreflight: (() => void) | null = null
  private stopPeerWatch: (() => void) | null = null

  constructor(
    private readonly chatEngine: ThreadTransferEngine,
    options: ThreadTransferServiceOptions = {}
  ) {
    this.isRunOwnerAlive =
      options.isRunOwnerAlive ?? ((pid) => instanceRegistry.isRunOwnerAlive(pid))
    this.liveInstancePids = options.liveInstancePids ?? (() => instanceRegistry.liveInstancePids())
    this.hasPeerInstance =
      options.hasPeerInstance ?? (() => instanceRegistry.hasOtherLiveInstance())
    this.bus = options.bus ?? instanceHandoffBus
    this.locks = options.locks ?? null
    this.detachPromptPreflight =
      this.chatEngine.attachThreadTransferPreflight?.((projectId, threadId) =>
        this.prepareIdleCodexThreadForPrompt(projectId, threadId)
      ) ?? null
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
    // Hand-offs are peer to peer, so with no sibling there is nothing for the
    // bus's backstop poll to recover and it stays event driven. Membership is the
    // registry's to report, and it reports it on change.
    this.syncPeerInstance()
    this.stopPeerWatch = instanceRegistry.onLiveInstanceSetChanged(() => this.syncPeerInstance())
    this.stopRequestListener = this.bus.onRequest((request) => {
      void this.handleRequest(request)
    })
  }

  /** Stop answering requests and drop the invoke handler. */
  dispose(): void {
    this.detachPromptPreflight?.()
    this.detachPromptPreflight = null
    this.stopPeerWatch?.()
    this.stopPeerWatch = null
    this.stopRequestListener?.()
    this.stopRequestListener = null
    this.started = false
    this.bus.stop()
    trustedIpcMain.removeHandler('thread:transferRun')
  }

  /** Tell the bus whether there is a sibling instance to exchange hand-offs with. */
  private syncPeerInstance(): void {
    try {
      this.bus.setPeerInstancesPresent(this.hasPeerInstance())
    } catch (error) {
      Logger.dev('Could not read instance membership for the hand-off bus:', error)
    }
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
      if (ownerPid === null || ownerPid === this.bus.localPid) {
        return { ok: true, noLongerForeign: true }
      }
      if (!this.isRunOwnerAlive(ownerPid)) {
        return { ok: true, noLongerForeign: true }
      }
      // One transfer per thread. The receiving side takes `adopt` for the whole
      // hand-off and hands its token to the owner, so a second window asking at
      // the same moment is refused before anything on the owner is stopped, and
      // the owner can tell a real transfer from a request with no claim behind
      // it.
      const lock = await this.locks?.acquire(projectId, target.rootThreadId, 'adopt')
      if (this.locks && lock === null) {
        return { ok: false, reason: 'Another transfer of this thread is already in progress.' }
      }
      try {
        const ack = await this.bus.request(
          ownerPid,
          projectId,
          target.rootThreadId,
          'release-run',
          lock ?? undefined
        )
        if (ack.status !== 'accepted') {
          const current = await this.chatEngine.resolveTransferTarget(projectId, threadId)
          if (
            current.ownerPid === null ||
            current.ownerPid === this.bus.localPid ||
            !this.isRunOwnerAlive(current.ownerPid)
          ) {
            return { ok: true, noLongerForeign: true }
          }
          return {
            ok: false,
            reason: ack.reason ?? 'The instance running this thread did not hand it over.'
          }
        }
        return await this.chatEngine.adoptTransferredThread(projectId, target.rootThreadId)
      } finally {
        if (this.locks && lock) {
          await this.locks.release(projectId, target.rootThreadId, 'adopt', lock)
        }
      }
    } catch (error) {
      Logger.error('Cross-instance thread transfer failed:', error)
      return { ok: false, reason: 'The transfer could not be completed.' }
    }
  }

  /**
   * Before a Codex prompt, ask a sibling to release an idle native session it
   * still has loaded. The active-turn ledger remains authoritative: a live run
   * is left for the explicit run-transfer flow, while a settled thread can move
   * without an extra user action.
   */
  async prepareIdleCodexThreadForPrompt(
    projectId: string,
    threadId: string
  ): Promise<ThreadTransferResult> {
    try {
      const target = await this.chatEngine.resolveTransferTarget(projectId, threadId)
      if (target.ownerPid !== null) return { ok: true }

      const pids = this.liveInstancePids()
      if (!pids) return { ok: true }
      const peers = pids.filter((pid) => pid !== this.bus.localPid && this.isRunOwnerAlive(pid))
      if (peers.length === 0) return { ok: true }

      // Releasing a sibling's idle writer is still a hand-off of this thread, so
      // it takes the same mutex: a window that is already moving the thread has
      // the claim, and this prompt waits rather than racing it.
      const lock = await this.locks?.acquire(projectId, target.rootThreadId, 'adopt')
      if (this.locks && lock === null) {
        return { ok: false, reason: 'This thread is already being transferred.' }
      }
      try {
        const pending = new Map(
          peers.map((pid) => [
            pid,
            this.bus.request(
              pid,
              projectId,
              target.rootThreadId,
              'release-idle-codex-thread',
              lock ?? undefined
            )
          ])
        )
        while (pending.size > 0) {
          const settled = await Promise.race(
            [...pending].map(async ([pid, request]) => ({ pid, ack: await request }))
          )
          pending.delete(settled.pid)
          if (settled.ack.status === 'accepted') return { ok: true }
          if (
            settled.ack.status === 'not-owner' ||
            settled.ack.reason === 'This instance is no longer running that thread.'
          ) {
            continue
          }
          return {
            ok: false,
            reason:
              settled.ack.reason ??
              'The instance holding this Codex thread could not release its writer.'
          }
        }
        return { ok: true }
      } finally {
        if (this.locks && lock) {
          await this.locks.release(projectId, target.rootThreadId, 'adopt', lock)
        }
      }
    } catch (error) {
      Logger.error('Idle Codex thread transfer failed:', error)
      return { ok: false, reason: 'The Codex thread could not be transferred to this instance.' }
    }
  }

  /** Answer a sibling that asked this process to release a thread. */
  private async handleRequest(request: HandoffRequest): Promise<void> {
    if (request.targetPid !== this.bus.localPid) return
    // The sending side takes `release` so two requests for one thread cannot both
    // run the stop-and-settle on top of each other.
    const lock = await this.locks?.acquire(request.projectId, request.threadId, 'release')
    if (this.locks && lock === null) {
      await this.bus.respond(
        request,
        'refused',
        'Another transfer of this thread is already in progress.'
      )
      return
    }
    try {
      // When the requester named the claim it is acting under, honour only that
      // exact claim: a request whose lock is gone, expired, or held by someone
      // else must not stop a run. A legacy request carries no token and is left
      // to the release lock alone.
      if (this.locks && request.lockToken) {
        const held = await this.locks.holds(
          request.projectId,
          request.threadId,
          'adopt',
          request.requesterPid,
          request.lockToken
        )
        if (!held) {
          await this.bus.respond(
            request,
            'refused',
            'The transfer lock is not held by the requesting instance.'
          )
          return
        }
      }
      if (request.operation === 'release-idle-codex-thread') {
        if (!this.chatEngine.releaseIdleCodexThreadForTransfer) {
          await this.bus.respond(request, 'not-owner')
          return
        }
        const result = await this.chatEngine.releaseIdleCodexThreadForTransfer(
          request.projectId,
          request.threadId
        )
        await this.bus.respond(
          request,
          !result.owner ? 'not-owner' : result.released ? 'accepted' : 'refused',
          result.reason
        )
        return
      }
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
    } finally {
      if (this.locks && lock) {
        await this.locks.release(request.projectId, request.threadId, 'release', lock)
      }
    }
  }
}
