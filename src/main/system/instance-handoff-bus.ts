/**
 * Cross-instance handoff requests: "another window wants to own this thread".
 *
 * Two CodeInOven instances share one config root, so one window can see a thread
 * a sibling is running but cannot stop it: the harness process and the live
 * stream belong to the sibling. Transferring the run therefore needs one process
 * to ask another, and a request is the only shape that works when the two
 * processes have no transport between them.
 *
 * Delivery rides the same filesystem registry the rest of the cross-instance
 * machinery uses   one flat directory under the config root, watched by every
 * instance   so a request reaches the target without polling, a port, or a
 * server. Each request is a small file; the target answers with an ack file and
 * removes the request, and the requester removes the ack it consumed. Anything
 * left behind by a crashed process is swept by age.
 *
 * The watcher is a latency optimisation, never the delivery guarantee: every
 * event re-reads the whole directory, and a slow poll does the same so a dropped
 * or coalesced event cannot strand a request or an ack until the timeout.
 *
 * The bus is deliberately dumb: it carries identifiers and a verdict, never turn
 * state. `active_turns` stays the single source of truth for who owns a turn,
 * and the transfer service re-reads it on both sides.
 *
 * A bus instance speaks for exactly one process (`localPid`), while the
 * directory it watches can hold traffic for several: routing is decided by the
 * pid fields inside each file.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { FSWatcher } from 'node:fs'
import { getConfigRoot } from '../../lib/utils'
import type { HandedOffWorker } from '../chat/thread-transfer-service/thread-transfer-workers'
import { Logger } from './logger'

/** How long a requester waits for the target's verdict before giving up. */
const HANDOFF_TIMEOUT_MS = 30_000
/** Files older than this are leftovers from a crashed process. */
const HANDOFF_TTL_MS = 5 * 60_000
/**
 * How often the directory is re-read for anything the watcher did not report,
 * and how often leftovers are swept.
 *
 * A watch event is not a guarantee: FSEvents can drop events for a directory
 * that was created moments before the watcher attached, coalesce several writes
 * into one event naming an already-replaced file, and inotify can overflow its
 * queue. Delivery therefore never depends on an event arriving   this interval
 * is the floor, and it is far below `HANDOFF_TIMEOUT_MS` so a missed event
 * delays a transfer instead of failing it. The directory holds a handful of
 * small files, so a pass costs one `readdir`.
 *
 * The floor is only worth paying while there is traffic it could recover, so
 * this interval is armed on a condition rather than at start-up. See
 * {@link InstanceHandoffBus.setPeerInstancesPresent}.
 */
const HANDOFF_POLL_MS = 2_000

const REQUEST_SUFFIX = '.req.json'
const ACK_SUFFIX = '.ack.json'

export interface HandoffRequest {
  requestId: string
  requesterPid: number
  targetPid: number
  projectId: string
  threadId: string
  createdAt: number
  /** Omitted requests are legacy run transfers. */
  operation?: 'release-run' | 'release-idle-codex-thread'
  /**
   * The requester's `adopt` transfer-lock token. The target refuses to act for a
   * request whose token no longer matches the lock the requester holds, so a
   * thread cannot be claimed by a transfer that is not really held. Absent on a
   * legacy requester, which the target tolerates (it still takes its own
   * `release` lock).
   */
  lockToken?: string
}

/**
 * What the releasing instance hands back with an accepted transfer.
 *
 * A hand-off moves a thread, not the work running under it: nested workers and
 * pawns end with the process that hosted them. The roster rides the ack because
 * it is the only place the receiving instance can learn it: by the time the
 * adopter looks at the shared database those workers are already settled, and a
 * settled card cannot say whether it finished or was stopped by the move.
 */
export interface HandoffReleaseDetails {
  /** Workers the release had to stop, as the resuming agent must hear them. */
  workers?: readonly HandedOffWorker[]
  /** Pawn threads whose runs were stopped so the adopter can resume them. */
  pawnThreadIds?: readonly string[]
}

export interface HandoffAck {
  requestId: string
  requesterPid: number
  targetPid: number
  status: 'accepted' | 'refused' | 'not-owner'
  reason?: string
  /** Present on an accepted `release-run` when the release has something to say. */
  details?: HandoffReleaseDetails
  createdAt: number
}

interface PendingRequest {
  resolve: (ack: HandoffAck) => void
  timer: ReturnType<typeof setTimeout>
}

export class InstanceHandoffBus {
  /**
   * The process this bus speaks for. Requests addressed elsewhere are ignored and
   * acks addressed elsewhere are not consumed, so a peer is identified by the pid
   * it writes into the files. The app's singleton always carries `process.pid`;
   * a test can stand up two peers on one directory by giving each its own id.
   */
  readonly localPid: number
  private readonly dir: string
  private watcher: FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private sequence = 0
  private started = false
  /**
   * Whether a sibling instance is alive to exchange hand-offs with.
   *
   * Starts true, which is what the bus did before this input existed: a bus
   * nobody informs keeps its backstop poll. The app reports the real membership
   * through {@link setPeerInstancesPresent}, so a process running alone clears
   * the interval instead of re-reading an empty directory twice a second.
   */
  private peerInstancesPresent = true
  /** Whether the directory still holds a request to consume or a leftover to sweep. */
  private trafficOnDisk = false
  private readonly requestListeners = new Set<(request: HandoffRequest) => void>()
  private readonly pending = new Map<string, PendingRequest>()
  /** Request ids already delivered to listeners, so a repeat watch event is inert. */
  private readonly seenRequests = new Set<string>()

  constructor(directory = join(getConfigRoot(), 'instances', 'handoffs'), localPid = process.pid) {
    this.dir = directory
    this.localPid = localPid
  }

  start(): void {
    if (this.started) return
    this.started = true
    try {
      mkdirSync(this.dir, { recursive: true })
      // A request or ack may already be waiting from before this bus started.
      this.drain()
      this.sweepStale()
    } catch (error) {
      // The bus is best effort: a failure to start only means transfer is
      // unavailable until the next launch, never that the app cannot run.
      Logger.dev('Cross-instance handoff directory unavailable:', error)
    }
    this.startWatcher()
    this.syncPoll()
  }

  stop(): void {
    this.started = false
    this.disarmPoll()
    this.watcher?.close()
    this.watcher = null
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve({
        requestId,
        requesterPid: this.localPid,
        targetPid: 0,
        status: 'refused',
        reason: 'This instance is shutting down.',
        createdAt: Date.now()
      })
    }
    this.pending.clear()
  }

  /** Subscribe to requests addressed to this process. */
  onRequest(listener: (request: HandoffRequest) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  /**
   * Ask the target process to release one thread's run.
   *
   * Never rejects: a timeout or an unreadable request becomes a `refused` ack so
   * callers have exactly one failure shape to handle.
   */
  async request(
    targetPid: number,
    projectId: string,
    threadId: string,
    operation: HandoffRequest['operation'] = 'release-run',
    lockToken?: string
  ): Promise<HandoffAck> {
    const requestId = `${this.localPid}-${Date.now()}-${(this.sequence += 1)}`
    const request: HandoffRequest = {
      requestId,
      requesterPid: this.localPid,
      targetPid,
      projectId,
      threadId,
      createdAt: Date.now(),
      ...(operation === 'release-run' ? {} : { operation }),
      ...(lockToken ? { lockToken } : {})
    }
    try {
      this.writeFile(`${requestId}${REQUEST_SUFFIX}`, request)
    } catch (error) {
      Logger.dev('Cross-instance handoff request could not be written:', error)
      return {
        requestId,
        requesterPid: this.localPid,
        targetPid,
        status: 'refused',
        reason: 'The transfer request could not be delivered.',
        createdAt: Date.now()
      }
    }
    return new Promise<HandoffAck>((resolve) => {
      const finish = (ack: HandoffAck): void => {
        const pending = this.pending.get(requestId)
        if (!pending) return
        this.pending.delete(requestId)
        clearTimeout(pending.timer)
        // The last reason to keep looking may have just gone away.
        this.refreshPoll()
        resolve(ack)
      }
      const timer = setTimeout(() => {
        finish({
          requestId,
          requesterPid: this.localPid,
          targetPid,
          status: 'refused',
          reason: 'The instance running this thread did not respond in time.',
          createdAt: Date.now()
        })
        this.removeFile(`${requestId}${REQUEST_SUFFIX}`)
      }, HANDOFF_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(requestId, { resolve: finish, timer })
      // A verdict is outstanding, and the poll is what bounds the wait.
      this.refreshPoll()
      // The ack may have landed between the write and this registration.
      this.drainAck(requestId)
    })
  }

  /** Answer a request (from a `request` listener) and retire its file. */
  async respond(
    request: HandoffRequest,
    status: HandoffAck['status'],
    reason?: string,
    details?: HandoffReleaseDetails
  ): Promise<void> {
    const ack: HandoffAck = {
      requestId: request.requestId,
      requesterPid: request.requesterPid,
      targetPid: request.targetPid,
      status,
      ...(reason ? { reason } : {}),
      ...(details ? { details } : {}),
      createdAt: Date.now()
    }
    try {
      this.writeFile(`${request.requestId}${ACK_SUFFIX}`, ack)
    } catch (error) {
      Logger.dev('Cross-instance handoff ack could not be written:', error)
    }
    this.removeFile(`${request.requestId}${REQUEST_SUFFIX}`)
  }

  private startWatcher(): void {
    if (this.watcher) return
    try {
      // The event is only a wake-up call: the directory is re-read whole, so an
      // event naming a file that has already been replaced still delivers the
      // request or ack that is really there. A pass also re-decides whether the
      // backstop poll has anything left to watch.
      this.watcher = watch(this.dir, { persistent: false }, () => {
        this.drain()
        this.syncPoll()
      })
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = null
      })
    } catch (error) {
      Logger.dev('Cross-instance handoff watcher unavailable:', error)
      this.watcher = null
    }
  }

  /** Consume everything currently in the directory, newest events or not. */
  private drain(): void {
    let files: string[]
    try {
      files = readdirSync(this.dir)
    } catch {
      // The directory is gone (config root moved, temp dir removed): the poll
      // covers it once it exists again.
      return
    }
    for (const file of files) this.consume(file)
  }

  /** One poll pass: deliver whatever the watcher missed, then retire leftovers. */
  private poll(): void {
    this.drain()
    this.sweepStale()
    this.syncPoll()
  }

  /**
   * Tell the bus whether another instance is alive to exchange hand-offs with.
   *
   * The interval above is a backstop for a watch event that never arrived, and
   * the only traffic this directory carries comes from a peer process: with this
   * process alone there is no request to miss and no ack to wait for, so the
   * interval is cleared and the bus goes back to being purely event driven. The
   * caller owns the answer because the bus deliberately knows nothing about the
   * instance registry.
   */
  setPeerInstancesPresent(present: boolean): void {
    if (this.peerInstancesPresent === present) return
    this.peerInstancesPresent = present
    this.refreshPoll()
  }

  /**
   * Whether a hand-off this process sent is still waiting for its verdict.
   *
   * The wait is bounded by `HANDOFF_TIMEOUT_MS`, and it only starts while the user
   * is moving a run between instances, but an exit taken inside it loses the
   * transfer and leaves the peer waiting out its timeout. The residency check
   * reads this so a process holding an unanswered hand-off stays alive until the
   * answer lands.
   */
  hasPendingHandoff(): boolean {
    return this.pending.size > 0
  }

  /**
   * Whether the backstop poll has work to do: an ack this process is waiting
   * for, a peer that can write a request at any moment, or files still on disk
   * to consume or retire. With none of the three, a pass would only learn that
   * the directory is still empty.
   */
  private shouldPoll(): boolean {
    if (!this.started) return false
    if (this.pending.size > 0) return true
    if (this.peerInstancesPresent) return true
    return this.trafficOnDisk
  }

  /** Re-read what the directory holds, then arm or clear the poll to match. */
  private syncPoll(): void {
    try {
      this.trafficOnDisk = readdirSync(this.dir).length > 0
    } catch {
      // The directory is gone (config root moved, temp dir removed): nothing is
      // waiting, and whatever created it will write to it again.
      this.trafficOnDisk = false
    }
    this.refreshPoll()
  }

  private refreshPoll(): void {
    if (this.shouldPoll()) this.armPoll()
    else this.disarmPoll()
  }

  private armPoll(): void {
    if (this.pollTimer || !this.started) return
    this.pollTimer = setInterval(() => this.poll(), HANDOFF_POLL_MS)
    this.pollTimer.unref?.()
    // A pass right now rather than after the first interval, so whatever is
    // already waiting is delivered the moment the poll is armed. The timer is
    // assigned first, so the pass below cannot arm a second one.
    this.poll()
  }

  private disarmPoll(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private consume(file: string): void {
    if (!file.endsWith('.json')) return
    if (file.endsWith(REQUEST_SUFFIX)) {
      this.consumeRequest(file)
      return
    }
    if (file.endsWith(ACK_SUFFIX)) {
      this.consumeAck(file)
    }
  }

  private consumeRequest(file: string): void {
    const request = this.readFile<HandoffRequest>(file)
    if (!request || !isHandoffRequest(request)) return
    if (request.targetPid !== this.localPid) return
    // With nobody listening yet there is nobody to answer, and a request marked
    // as delivered here would never be offered again: leave it on disk for the
    // next pass instead. This is the window between the bus starting and the
    // service registering its listener, which is also where a request that was
    // already waiting when this instance launched is picked up.
    if (this.requestListeners.size === 0) return
    if (this.seenRequests.has(request.requestId)) return
    this.seenRequests.add(request.requestId)
    if (this.seenRequests.size > 512) {
      const oldest = this.seenRequests.values().next().value
      if (oldest) this.seenRequests.delete(oldest)
    }
    for (const listener of this.requestListeners) {
      try {
        listener(request)
      } catch (error) {
        Logger.error('Cross-instance handoff listener failed:', error)
      }
    }
  }

  private consumeAck(file: string): void {
    const ack = this.readFile<HandoffAck>(file)
    if (!ack || !isHandoffAck(ack)) return
    if (ack.requesterPid !== this.localPid) return
    // An ack that arrives before its waiter registered is left on disk for the
    // requester's own drain, which runs the moment the waiter exists.
    if (!this.pending.has(ack.requestId)) return
    this.pending.get(ack.requestId)?.resolve(ack)
    this.removeFile(file)
  }

  /** Read one ack file directly, covering a verdict that landed pre-registration. */
  private drainAck(requestId: string): void {
    const file = `${requestId}${ACK_SUFFIX}`
    const ack = this.readFile<HandoffAck>(file)
    if (!ack || !isHandoffAck(ack) || ack.requesterPid !== this.localPid) return
    this.pending.get(requestId)?.resolve(ack)
    this.removeFile(file)
  }

  private sweepStale(): void {
    const cutoff = Date.now() - HANDOFF_TTL_MS
    let files: string[]
    try {
      files = readdirSync(this.dir)
    } catch {
      return
    }
    for (const file of files) {
      try {
        if (statSync(join(this.dir, file)).mtimeMs < cutoff) this.removeFile(file)
      } catch {
        // Already gone   nothing to sweep.
      }
    }
  }

  private writeFile(name: string, value: unknown): void {
    const tmp = join(this.dir, `.${name}.tmp`)
    const target = join(this.dir, name)
    writeFileSync(tmp, JSON.stringify(value), 'utf8')
    renameSync(tmp, target)
  }

  private readFile<T>(name: string): T | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T
    } catch {
      return null
    }
  }

  private removeFile(name: string): void {
    try {
      rmSync(join(this.dir, name), { force: true })
    } catch {
      // Best effort   the sweep retires anything left behind.
    }
  }
}

function isHandoffRequest(value: unknown): value is HandoffRequest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<HandoffRequest>
  return (
    typeof candidate.requestId === 'string' &&
    typeof candidate.requesterPid === 'number' &&
    typeof candidate.targetPid === 'number' &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.threadId === 'string' &&
    (candidate.operation === undefined ||
      candidate.operation === 'release-run' ||
      candidate.operation === 'release-idle-codex-thread') &&
    (candidate.lockToken === undefined || typeof candidate.lockToken === 'string')
  )
}

function isHandoffAck(value: unknown): value is HandoffAck {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<HandoffAck>
  return (
    typeof candidate.requestId === 'string' &&
    typeof candidate.requesterPid === 'number' &&
    (candidate.status === 'accepted' ||
      candidate.status === 'refused' ||
      candidate.status === 'not-owner')
  )
}

/** Singleton shared by the main process lifecycle. */
export const instanceHandoffBus = new InstanceHandoffBus()
