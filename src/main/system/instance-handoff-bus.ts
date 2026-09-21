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
 * The bus is deliberately dumb: it carries identifiers and a verdict, never turn
 * state. `active_turns` stays the single source of truth for who owns a turn,
 * and the transfer service re-reads it on both sides.
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
import { Logger } from './logger'

/** How long a requester waits for the target's verdict before giving up. */
const HANDOFF_TIMEOUT_MS = 30_000
/** Files older than this are leftovers from a crashed process. */
const HANDOFF_TTL_MS = 5 * 60_000
/** How often leftovers are swept. */
const SWEEP_INTERVAL_MS = 60_000

const REQUEST_SUFFIX = '.req.json'
const ACK_SUFFIX = '.ack.json'

export interface HandoffRequest {
  requestId: string
  requesterPid: number
  targetPid: number
  projectId: string
  threadId: string
  createdAt: number
}

export interface HandoffAck {
  requestId: string
  requesterPid: number
  targetPid: number
  status: 'accepted' | 'refused'
  reason?: string
  createdAt: number
}

interface PendingRequest {
  resolve: (ack: HandoffAck) => void
  timer: ReturnType<typeof setTimeout>
}

export class InstanceHandoffBus {
  private readonly dir: string
  private watcher: FSWatcher | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private sequence = 0
  private started = false
  private readonly requestListeners = new Set<(request: HandoffRequest) => void>()
  private readonly pending = new Map<string, PendingRequest>()
  /** Request ids already delivered to listeners, so a repeat watch event is inert. */
  private readonly seenRequests = new Set<string>()

  constructor(directory = join(getConfigRoot(), 'instances', 'handoffs')) {
    this.dir = directory
  }

  start(): void {
    if (this.started) return
    this.started = true
    try {
      mkdirSync(this.dir, { recursive: true })
      this.sweepStale()
    } catch (error) {
      // The bus is best effort: a failure to start only means transfer is
      // unavailable until the next launch, never that the app cannot run.
      Logger.dev('Cross-instance handoff directory unavailable:', error)
    }
    this.startWatcher()
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  stop(): void {
    this.started = false
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.watcher?.close()
    this.watcher = null
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve({
        requestId,
        requesterPid: process.pid,
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
  async request(targetPid: number, projectId: string, threadId: string): Promise<HandoffAck> {
    const requestId = `${process.pid}-${Date.now()}-${(this.sequence += 1)}`
    const request: HandoffRequest = {
      requestId,
      requesterPid: process.pid,
      targetPid,
      projectId,
      threadId,
      createdAt: Date.now()
    }
    try {
      this.writeFile(`${requestId}${REQUEST_SUFFIX}`, request)
    } catch (error) {
      Logger.dev('Cross-instance handoff request could not be written:', error)
      return {
        requestId,
        requesterPid: process.pid,
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
        resolve(ack)
      }
      const timer = setTimeout(() => {
        finish({
          requestId,
          requesterPid: process.pid,
          targetPid,
          status: 'refused',
          reason: 'The instance running this thread did not respond in time.',
          createdAt: Date.now()
        })
        this.removeFile(`${requestId}${REQUEST_SUFFIX}`)
      }, HANDOFF_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(requestId, { resolve: finish, timer })
      // The ack may have landed between the write and this registration.
      this.drainAck(requestId)
    })
  }

  /** Answer a request (from a `request` listener) and retire its file. */
  async respond(
    request: HandoffRequest,
    status: 'accepted' | 'refused',
    reason?: string
  ): Promise<void> {
    const ack: HandoffAck = {
      requestId: request.requestId,
      requesterPid: request.requesterPid,
      targetPid: request.targetPid,
      status,
      ...(reason ? { reason } : {}),
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
      this.watcher = watch(this.dir, { persistent: false }, (_eventType, filename) => {
        try {
          const name = filename?.toString()
          const files = name
            ? [name]
            : readdirSync(this.dir).filter((candidate) => candidate.endsWith('.json'))
          for (const file of files) this.consume(file)
        } catch {
          // A read racing a directory change is harmless: the next event or
          // the sweep covers whatever it missed.
        }
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
    if (request.targetPid !== process.pid) return
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
    if (ack.requesterPid !== process.pid) return
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
    if (!ack || !isHandoffAck(ack) || ack.requesterPid !== process.pid) return
    this.pending.get(requestId)?.resolve(ack)
    this.removeFile(file)
  }

  private sweepStale(): void {
    const cutoff = Date.now() - HANDOFF_TTL_MS
    for (const file of readdirSync(this.dir)) {
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
    typeof candidate.threadId === 'string'
  )
}

function isHandoffAck(value: unknown): value is HandoffAck {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<HandoffAck>
  return (
    typeof candidate.requestId === 'string' &&
    typeof candidate.requesterPid === 'number' &&
    (candidate.status === 'accepted' || candidate.status === 'refused')
  )
}

/** Singleton shared by the main process lifecycle. */
export const instanceHandoffBus = new InstanceHandoffBus()
