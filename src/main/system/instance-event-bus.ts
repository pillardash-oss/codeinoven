/**
 * Cross-instance live stream: one process's harness events, every instance's
 * windows.
 *
 * Two CodeInOven instances share one config root, so they share the thread table
 * and the mirrored conversation, while each process receives only its own harness
 * stream. Everything the app already had for that situation is an *invalidation*:
 * `instanceRegistry` writes "thread X changed" into the heartbeat entry and a
 * sibling re-reads the shared rows. That is the right shape for row and mirror
 * freshness, and the wrong shape for a run: a token stream cannot ride a
 * coalesced file write, so a window in instance B could only ever poll the
 * durable log and could never render the same conversation instance A renders.
 *
 * This bus is the missing half: a small pub-sub over local sockets, where the
 * owning process announces the render-only agent events it already broadcasts to
 * its own windows, and every sibling delivers them to its windows through the
 * same renderer pipeline. It is what makes the two windows feel like one chat
 * room instead of two views of a database.
 *
 * Design constraints, in order of importance:
 *
 * 1. Never a correctness dependency. Every frame is an observation of a run
 *    whose durable trace (`turn-stream` log) and mirror are shared on disk, so a
 *    dropped frame delays freshness and never changes state. There is no ack, no
 *    replay and no ordering guarantee beyond what one socket preserves.
 * 2. Never a background cost while alone. The listener and the peer sockets only
 *    exist while the instance registry proves another live instance is running;
 *    membership loss closes both, so a single instance carries no server, no
 *    timer and no socket.
 * 3. Never on the blocking path. Publishing is a socket write of a line per
 *    event; a backed-up socket drops the frame instead of queueing without bound,
 *    because the durable log is what heals the window.
 * 4. Never actionable. Permission, question, descriptor and catalog events stay
 *    with the process that owns the harness process: a sibling window cannot
 *    answer for a session it does not run, so carrying them would only let the UI
 *    offer an action that cannot work.
 *
 * The link also carries the shared-thread invalidations (a row, read flag or
 * mirror that moved, or a thread that was deleted), the same batch the registry
 * entry publishes. The two paths are one source seen twice: the entry is the
 * durable fallback   it works before a link exists and for a peer built before
 * this channel   and the link is the immediate one that a filesystem watch that
 * stopped delivering can never take away. Both carry the batch id, and the
 * registry dedupes by it, so a batch that arrives twice applies once.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, RemoteAgentEventPayload } from '../../lib/types'
import { getConfigRoot } from '../../lib/utils'
import { instanceRegistry, type CrossInstanceThreadEvent } from './instance-registry'
import { Logger } from './logger'

/**
 * A Unix socket path must fit in `sun_path` (104 bytes on macOS, 108 on Linux).
 * A deep config root is rare but real, so a long derived path falls back to a
 * short hashed name in the OS temp directory. Both sides derive the endpoint
 * from the same directory and pid, so they always agree.
 */
const MAX_SOCKET_PATH_BYTES = 100
/** Bytes one link may buffer before a frame is dropped instead of written. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024
/** Longest frame this bus will assemble from one peer, so a bad peer cannot grow it. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024
/** First wait after a failed dial, before the delay starts doubling. */
const REDIAL_BASE_DELAY_MS = 250
/**
 * Longest wait between dials while a live peer's endpoint is still missing.
 *
 * There is deliberately no attempt cap: a sibling's endpoint only starts
 * listening once its own feature boot finishes, and this app's cold start runs
 * well past any small budget of one-second attempts. A cap is what used to leave
 * two windows permanently unlinked   both listening, neither connected   after
 * one slow start, with no later signal to try again.
 */
const REDIAL_MAX_DELAY_MS = 5_000

/**
 * The agent events a sibling window is allowed to render.
 *
 * These are pure observations of a run: streaming parts, the completion of a
 * message, provider telemetry, and session lifecycle. Everything else an agent
 * event can carry is either actionable in the owning process (permissions,
 * questions, image descriptors) or app-level state each process derives for
 * itself (catalogs), so it never crosses the boundary.
 */
const REMOTE_RENDER_EVENT_TYPES: ReadonlySet<AgentEvent['type']> = new Set<AgentEvent['type']>([
  'message.part.updated',
  'message.part.delta',
  'message.completed',
  'usage.updated',
  'session.status',
  'session.idle',
  'session.error',
  'thread.error',
  'artifact.rendered'
])

/** Whether a remote window may render this event. */
export function isRemoteRenderEvent(event: AgentEvent): boolean {
  return REMOTE_RENDER_EVENT_TYPES.has(event.type)
}

/** What a frame carries, so one link can serve both live channels. */
type InstanceBusFrameKind = 'agent' | 'threads'

interface InstanceBusFrameBase {
  v: 1
  /**
   * Absent on a frame from a publisher built before this field existed, and such
   * a publisher only ever sent agent events, so a missing kind reads as `agent`.
   */
  kind: InstanceBusFrameKind
  from: number
  /** Monotonic per publisher, so a frame seen twice is never applied twice. */
  seq: number
}

/** One render-only agent event, addressed by the conversation that owns it. */
interface AgentEventFrame extends InstanceBusFrameBase {
  kind: 'agent'
  projectId: string
  threadId: string
  event: AgentEvent
}

/** One batch of shared-thread invalidations, exactly as the registry publishes it. */
interface ThreadChangeFrame extends InstanceBusFrameBase {
  kind: 'threads'
  batch: CrossInstanceThreadEvent
}

/** One frame on the wire. Line-delimited JSON, one message per line. */
type InstanceBusFrame = AgentEventFrame | ThreadChangeFrame

/** A frame body: what the caller supplies, before the envelope is added. */
type InstanceBusFrameBody =
  | Pick<AgentEventFrame, 'kind' | 'projectId' | 'threadId' | 'event'>
  | Pick<ThreadChangeFrame, 'kind' | 'batch'>

export interface InstanceEventBusOptions {
  /** Where the endpoint files live. Defaults to `<config root>/instances/bus`. */
  directory?: string
  /** The process this bus speaks for. */
  localPid?: number
  /**
   * Every live instance pid, this one included; `null` when the registry cannot
   * be read. Narrow port so a test can stand two peers up without a registry.
   */
  liveInstancePids?: () => number[] | null
  /** Fires when the membership of live instances changes. */
  subscribeToMembership?: (listener: () => void) => () => void
  /**
   * Redial pacing. A port so a test can prove a slow peer is still reached in a
   * fraction of a second instead of waiting out the production delays.
   */
  redial?: { baseDelayMs?: number; maxDelayMs?: number }
}

/** Short stable digest of a directory, for the endpoints that must stay short. */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

/**
 * The endpoint one process listens on and its peers dial.
 *
 * Deterministic from the pair (directory, pid), which is why no discovery channel
 * is needed: the instance registry already tells every process which pids are
 * alive, and this turns one of them into an address.
 */
export function instanceBusEndpoint(directory: string, pid: number): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cio-instance-bus-${shortHash(directory)}-${pid}`
  }
  const endpoint = join(directory, `${pid}.sock`)
  if (Buffer.byteLength(endpoint) <= MAX_SOCKET_PATH_BYTES) return endpoint
  return join(tmpdir(), `cio-instance-bus-${shortHash(directory)}-${pid}.sock`)
}

export class InstanceEventBus {
  readonly localPid: number
  private readonly directory: string
  private readonly liveInstancePids: () => number[] | null
  private readonly subscribeToMembership: (listener: () => void) => () => void
  private server: Server | null = null
  private stopMembership: (() => void) | null = null
  private started = false
  /** Every open link to a sibling: a connection this process dialled, or one dialled to it. */
  private readonly links = new Set<Socket>()
  /** Links this process dialled, by peer pid, so a peer is dialled once. */
  private readonly peers = new Map<number, Socket>()
  /** Peers with a dial in flight, so two reconciles never dial one peer twice. */
  private readonly dialing = new Set<number>()
  /** Consecutive failed dials per peer, which is what paces the next one. */
  private readonly dialFailures = new Map<number, number>()
  /** Earliest moment the next dial may run, per peer. */
  private readonly nextDialAt = new Map<number, number>()
  private redialTimer: ReturnType<typeof setTimeout> | null = null
  /** When the armed redial fires, so an earlier one can replace a later one. */
  private redialAt = 0
  private readonly redialBaseDelayMs: number
  private readonly redialMaxDelayMs: number
  /** Frames this process has published, so a frame cannot be applied twice. */
  private sequence = 0
  /** Highest frame sequence already applied, per publishing pid. */
  private readonly lastSeqByPid = new Map<number, number>()
  private readonly listeners = new Set<(payload: RemoteAgentEventPayload) => void>()
  private readonly threadChangeListeners = new Set<(batch: CrossInstanceThreadEvent) => void>()
  /**
   * Resolves a session id to the conversation that owns it. The sender knows
   * this, and shipping it with each frame is what lets a sibling window bind a
   * session it has not seen yet instead of dropping the first second of a turn.
   */
  private resolveSessionOwner:
    ((sessionId: string) => { projectId: string; threadId: string } | null) | null = null

  constructor(options: InstanceEventBusOptions = {}) {
    this.directory = options.directory ?? join(getConfigRoot(), 'instances', 'bus')
    this.localPid = options.localPid ?? process.pid
    this.redialBaseDelayMs = options.redial?.baseDelayMs ?? REDIAL_BASE_DELAY_MS
    this.redialMaxDelayMs = options.redial?.maxDelayMs ?? REDIAL_MAX_DELAY_MS
    this.liveInstancePids = options.liveInstancePids ?? (() => instanceRegistry.liveInstancePids())
    this.subscribeToMembership =
      options.subscribeToMembership ??
      ((listener) => instanceRegistry.onLiveInstanceSetChanged(listener))
  }

  /** Start serving this process and dial the instances already running. */
  start(): void {
    if (this.started) return
    this.started = true
    this.stopMembership = this.subscribeToMembership(() => this.reconcilePeers())
    this.reconcilePeers()
  }

  /** Stop serving, close every peer socket, and retire this process's endpoint. */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.stopMembership?.()
    this.stopMembership = null
    this.lastSeqByPid.clear()
    if (this.redialTimer) {
      clearTimeout(this.redialTimer)
      this.redialTimer = null
    }
    this.redialAt = 0
    for (const pid of [...this.peers.keys()]) this.forgetPeer(pid)
    this.dropLinks()
    this.dialing.clear()
    this.dialFailures.clear()
    this.nextDialAt.clear()
    this.closeServer()
    if (process.platform !== 'win32') {
      try {
        rmSync(instanceBusEndpoint(this.directory, this.localPid), { force: true })
      } catch {
        // Best effort: a leftover endpoint is replaced by the next listen.
      }
    }
  }

  /** Subscribe to the events other instances publish. */
  onRemoteEvent(listener: (payload: RemoteAgentEventPayload) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Subscribe to shared-thread invalidations other instances publish. */
  onRemoteThreadChange(listener: (batch: CrossInstanceThreadEvent) => void): () => void {
    this.threadChangeListeners.add(listener)
    return () => this.threadChangeListeners.delete(listener)
  }

  /** Whether at least one sibling link is open right now. */
  get hasConnectedPeers(): boolean {
    return this.links.size > 0
  }

  /** Whether this process is serving its endpoint, which it only does beside a sibling. */
  get isServing(): boolean {
    return this.server !== null
  }

  /**
   * Teach the bus how to name the conversation a session belongs to.
   *
   * Optional: without it frames still address the conversation by session id, and
   * a window that already bound that session renders them.
   */
  setSessionOwnerResolver(
    resolver: (sessionId: string) => { projectId: string; threadId: string } | null
  ): void {
    this.resolveSessionOwner = resolver
  }

  /**
   * Announce one agent event this process broadcast to its own windows.
   *
   * Filtered here rather than at the call sites so the rule that decides what may
   * cross the process boundary lives in one place.
   */
  publishAgentEvent(event: AgentEvent): void {
    if (!this.started) return
    if (!isRemoteRenderEvent(event)) return
    const owner =
      'sessionId' in event ? (this.resolveSessionOwner?.(event.sessionId) ?? null) : null
    this.publishFrame({
      kind: 'agent',
      projectId: owner?.projectId ?? '',
      threadId: owner?.threadId ?? '',
      event
    })
  }

  /**
   * Announce one batch of shared-thread invalidations over the live link.
   *
   * The batch is the same object the registry published to its entry, so a
   * sibling that also receives it through the file applies it once: the registry
   * dedupes by batch id, and this path goes through that same dedupe.
   */
  publishThreadChange(batch: CrossInstanceThreadEvent): void {
    if (!this.started) return
    if (!batch || typeof batch.id !== 'string' || batch.id.length === 0) return
    if (
      batch.rows.length === 0 &&
      batch.drafts.length === 0 &&
      batch.messages.length === 0 &&
      batch.deleted.length === 0
    ) {
      return
    }
    this.publishFrame({ kind: 'threads', batch })
  }

  /**
   * Write one frame to every open link, or drop it when there is nobody to write
   * to. Losing a frame is always safe: both channels heal from shared state.
   */
  private publishFrame(body: InstanceBusFrameBody): void {
    if (this.links.size === 0) {
      // A peer can appear after this process settled in: the membership push
      // reconciles, and the dial is paced, so this cannot become a dial storm on
      // a per-token path.
      this.reconcilePeers()
      if (this.links.size === 0) return
    }
    this.sequence += 1
    const envelope = { v: 1 as const, from: this.localPid, seq: this.sequence }
    const frame: InstanceBusFrame =
      body.kind === 'agent'
        ? {
            ...envelope,
            kind: 'agent',
            projectId: body.projectId,
            threadId: body.threadId,
            event: body.event
          }
        : { ...envelope, kind: 'threads', batch: body.batch }
    this.pushToLinks(`${JSON.stringify(frame)}\n`)
  }

  /** Arm the listener and dial every live peer, or stand down when alone. */
  private reconcilePeers(): void {
    if (!this.started) return
    const live = this.liveInstancePids()
    if (live === null) return
    const peers = live.filter((pid) => pid !== this.localPid)
    if (peers.length === 0) {
      // Nobody to exchange frames with: drop the server and every socket so a
      // lone instance carries no listener and no open connection.
      this.closeServer()
      for (const pid of [...this.peers.keys()]) this.forgetPeer(pid)
      this.dropLinks()
      this.dialing.clear()
      this.dialFailures.clear()
      this.nextDialAt.clear()
      return
    }
    for (const pid of [...this.dialFailures.keys()]) {
      // A pid that is gone keeps no history: if it comes back it is a new process
      // and deserves an immediate dial rather than the delays of its predecessor.
      if (!peers.includes(pid) && !this.peers.has(pid) && !this.dialing.has(pid)) {
        this.dialFailures.delete(pid)
        this.nextDialAt.delete(pid)
      }
    }
    this.ensureServer()
    for (const pid of peers) {
      // Exactly one direction per pair: the lower pid dials and the other side
      // answers on the same link. Two links would deliver every frame twice, and
      // duplicate text deltas would duplicate the text in the receiving cache.
      if (this.localPid < pid) this.dial(pid)
    }
  }

  private ensureServer(): void {
    if (this.server) return
    const endpoint = instanceBusEndpoint(this.directory, this.localPid)
    if (process.platform !== 'win32') {
      try {
        mkdirSync(this.directory, { recursive: true })
        // A previous run that was killed leaves its endpoint behind, and
        // listening on an existing path fails with EADDRINUSE.
        rmSync(endpoint, { force: true })
      } catch (error) {
        Logger.dev('Cross-instance bus directory unavailable:', error)
      }
    }
    try {
      const server = createServer((socket) => this.attachLink(socket))
      server.on('error', (error) => {
        Logger.dev('Cross-instance bus listener error:', error)
        this.closeServer()
      })
      // The bus must never keep the process alive on its own.
      server.unref()
      server.listen(endpoint, () => undefined)
      this.server = server
    } catch (error) {
      Logger.dev('Cross-instance bus listener unavailable:', error)
      this.server = null
    }
  }

  private closeServer(): void {
    const server = this.server
    if (!server) return
    this.server = null
    try {
      server.close()
    } catch {
      // Already closed.
    }
  }

  /** Close every open link to a sibling. */
  private dropLinks(): void {
    for (const socket of [...this.links]) {
      this.links.delete(socket)
      socket.destroy()
    }
  }

  /** Connect to one peer, unless it is already connected, dialling, or waiting. */
  private dial(pid: number): void {
    if (!this.started) return
    if (this.peers.has(pid) || this.dialing.has(pid)) return
    const wait = (this.nextDialAt.get(pid) ?? 0) - Date.now()
    if (wait > 0) {
      this.scheduleRedial(wait)
      return
    }
    const endpoint = instanceBusEndpoint(this.directory, pid)
    let socket: Socket
    try {
      socket = createConnection(endpoint)
    } catch {
      this.retryDialLater(pid)
      return
    }
    this.dialing.add(pid)
    socket.unref()
    socket.setNoDelay(true)
    socket.on('connect', () => {
      this.dialing.delete(pid)
      this.dialFailures.delete(pid)
      this.nextDialAt.delete(pid)
      this.peers.set(pid, socket)
      this.attachLink(socket)
    })
    socket.on('error', () => {
      // Expected while a peer is starting or already gone: the peer list is the
      // truth, and the paced retry below is what turns a slow feature boot into
      // a link instead of a pair that listens forever and never connects.
      this.dialing.delete(pid)
      this.forgetPeer(pid)
      socket.destroy()
      this.retryDialLater(pid)
    })
    socket.on('close', () => {
      this.dialing.delete(pid)
      if (this.peers.get(pid) !== socket) return
      this.forgetPeer(pid)
      this.retryDialLater(pid)
    })
  }

  /**
   * Wait before dialling this peer again, doubling up to the ceiling.
   *
   * The retry never gives up while the peer is registered: its endpoint appears
   * when its own feature boot finishes, which can be tens of seconds after this
   * process first saw the pid. The ceiling keeps that recovery to one cheap
   * connect attempt every few seconds, and every dial failure re-arms this same
   * timer, so nothing here relies on a later publish or membership change.
   */
  private retryDialLater(pid: number): void {
    if (!this.started) return
    const failures = (this.dialFailures.get(pid) ?? 0) + 1
    this.dialFailures.set(pid, failures)
    const delay = Math.min(this.redialBaseDelayMs * 2 ** (failures - 1), this.redialMaxDelayMs)
    this.nextDialAt.set(pid, Date.now() + delay)
    this.scheduleRedial(delay)
  }

  /** Arm one redial, keeping the earliest of anything already scheduled. */
  private scheduleRedial(delayMs = this.redialBaseDelayMs): void {
    if (!this.started) return
    const delay = Math.max(0, delayMs)
    const at = Date.now() + delay
    if (this.redialTimer) {
      if (this.redialAt <= at) return
      clearTimeout(this.redialTimer)
    }
    this.redialAt = at
    this.redialTimer = setTimeout(() => {
      this.redialTimer = null
      this.redialAt = 0
      this.reconcilePeers()
    }, delay)
    this.redialTimer.unref?.()
  }

  private forgetPeer(pid: number): void {
    const socket = this.peers.get(pid)
    this.peers.delete(pid)
    // A restarted peer publishes from its own sequence again, so what this
    // process remembers of the previous one must go with the old link.
    this.lastSeqByPid.delete(pid)
    if (!socket) return
    this.links.delete(socket)
    socket.removeAllListeners('close')
    socket.destroy()
  }

  /**
   * Write one frame to every open link, dropping it rather than buffering forever.
   *
   * A dialled connection and an accepted one are the same link, and both carry
   * frames in both directions: whichever process managed to dial first is enough
   * for the pair to exchange events, and each frame is written once per link
   * instead of once per direction.
   */
  private pushToLinks(line: string): void {
    for (const socket of this.links) {
      if (socket.writableLength > MAX_BUFFERED_BYTES) continue
      socket.write(line)
    }
  }

  /** Read frames a peer sends, and let the same link carry ours back. */
  private attachLink(socket: Socket): void {
    if (this.links.has(socket)) return
    socket.unref()
    socket.setNoDelay(true)
    this.links.add(socket)
    socket.on('close', () => {
      this.links.delete(socket)
      // Nothing left to receive from, so what this process remembers of the
      // previous publisher must not outlive its link.
      if (this.links.size === 0) this.lastSeqByPid.clear()
    })
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > MAX_FRAME_BYTES) {
        // A peer that cannot stay inside the frame budget is dropped, not
        // trusted: the shared durable log still carries its thread's truth.
        socket.destroy()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) this.deliver(line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => socket.destroy())
  }

  /** Hand one received frame to local consumers, if it is well formed. */
  private deliver(line: string): void {
    const frame = parseFrame(line, this.localPid)
    if (!frame) return
    // One link per peer pair is the rule, so a repeat should be impossible; this
    // is the guard that keeps a duplicate from duplicating streamed text if two
    // links ever do form (a stale endpoint from an earlier run, a reconnection
    // that overlaps its predecessor).
    if (frame.seq > 0) {
      const last = this.lastSeqByPid.get(frame.from) ?? 0
      if (frame.seq <= last) return
      this.lastSeqByPid.set(frame.from, frame.seq)
    }
    if (frame.kind === 'agent') {
      for (const listener of this.listeners) {
        try {
          listener(frame.payload)
        } catch (error) {
          Logger.error('Cross-instance event listener failed:', error)
        }
      }
      return
    }
    for (const listener of this.threadChangeListeners) {
      try {
        listener(frame.batch)
      } catch (error) {
        Logger.error('Cross-instance thread listener failed:', error)
      }
    }
  }
}

/** What the wire held, once its envelope proves it is ours to read. */
type ParsedFrame =
  | { kind: 'agent'; from: number; seq: number; payload: RemoteAgentEventPayload }
  | { kind: 'threads'; from: number; seq: number; batch: CrossInstanceThreadEvent }

/** A frame as received, before any field is trusted. */
interface RawFrame {
  v?: unknown
  kind?: unknown
  from?: unknown
  seq?: unknown
  projectId?: unknown
  threadId?: unknown
  event?: unknown
  batch?: unknown
}

/**
 * Decode one frame, rejecting anything this build cannot trust: a foreign or
 * missing version, our own echo, a kind it does not serve, an event type that
 * must not cross the boundary, or a payload that is not complete.
 */
function parseFrame(line: string, localPid: number): ParsedFrame | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const frame = value as RawFrame
  if (frame.v !== 1) return null
  if (typeof frame.from !== 'number' || frame.from === localPid) return null
  const from = frame.from
  const seq = typeof frame.seq === 'number' ? frame.seq : 0
  // A publisher built before frames carried a kind only ever sent agent events.
  if (frame.kind === 'threads') {
    const batch = parseThreadBatch(frame.batch)
    return batch ? { kind: 'threads', from, seq, batch } : null
  }
  if (frame.kind !== undefined && frame.kind !== 'agent') return null
  if (!frame.event || typeof frame.event !== 'object') return null
  const event = frame.event as AgentEvent
  if (typeof event.type !== 'string' || !isRemoteRenderEvent(event)) return null
  return {
    kind: 'agent',
    from,
    seq,
    payload: {
      projectId: typeof frame.projectId === 'string' ? frame.projectId : '',
      threadId: typeof frame.threadId === 'string' ? frame.threadId : '',
      event,
      from,
      seq
    }
  }
}

/** The shape a thread batch must have before the registry is asked to apply it. */
function parseThreadBatch(value: unknown): CrossInstanceThreadEvent | null {
  if (!value || typeof value !== 'object') return null
  const batch = value as Partial<CrossInstanceThreadEvent>
  if (typeof batch.id !== 'string' || batch.id.length === 0) return null
  if (typeof batch.emittedAt !== 'number') return null
  if (
    !Array.isArray(batch.rows) ||
    !Array.isArray(batch.messages) ||
    !Array.isArray(batch.deleted)
  ) {
    return null
  }
  // A peer built before drafts travelled in a batch simply sends none, and the
  // registry's validator drops anything it cannot read anyway.
  return {
    id: batch.id,
    emittedAt: batch.emittedAt,
    rows: batch.rows,
    drafts: Array.isArray(batch.drafts) ? batch.drafts : [],
    messages: batch.messages,
    deleted: batch.deleted
  }
}

/** Singleton shared by the main process lifecycle. */
export const instanceEventBus = new InstanceEventBus()
