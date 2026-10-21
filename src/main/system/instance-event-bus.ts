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
 */

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, RemoteAgentEventPayload } from '../../lib/types'
import { getConfigRoot } from '../../lib/utils'
import { instanceRegistry } from './instance-registry'
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
/** How long to wait before re-dialling a peer whose endpoint was not listening yet. */
const REDIAL_DELAY_MS = 1_000
/** Attempts per peer between membership changes, so a wedged peer is not dialled forever. */
const MAX_DIAL_ATTEMPTS = 20

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

/** One frame on the wire. Line-delimited JSON, one message per line. */
interface InstanceBusFrame {
  v: 1
  from: number
  /** Monotonic per publisher, so a frame seen twice is never applied twice. */
  seq: number
  projectId: string
  threadId: string
  event: AgentEvent
}

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
  /** Dial attempts per peer since the last membership change. */
  private readonly dialAttempts = new Map<number, number>()
  private redialTimer: ReturnType<typeof setTimeout> | null = null
  /** Frames this process has published, so a frame cannot be applied twice. */
  private sequence = 0
  /** Highest frame sequence already applied, per publishing pid. */
  private readonly lastSeqByPid = new Map<number, number>()
  private readonly listeners = new Set<(payload: RemoteAgentEventPayload) => void>()
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
    for (const pid of [...this.peers.keys()]) this.forgetPeer(pid)
    this.dropLinks()
    this.dialAttempts.clear()
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
    if (this.links.size === 0) {
      // A peer can appear after this process settled in: the membership push
      // reconciles, and the dial is throttled, so this cannot become a dial storm
      // on a per-token path.
      this.reconcilePeers()
      if (this.links.size === 0) return
    }
    const owner =
      'sessionId' in event ? (this.resolveSessionOwner?.(event.sessionId) ?? null) : null
    this.sequence += 1
    const frame: InstanceBusFrame = {
      v: 1,
      from: this.localPid,
      seq: this.sequence,
      projectId: owner?.projectId ?? '',
      threadId: owner?.threadId ?? '',
      event
    }
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
      this.dialAttempts.clear()
      return
    }
    for (const pid of peers) {
      // A pid that came back after being forgotten starts its attempts afresh.
      if (!this.peers.has(pid) && !this.dialAttempts.has(pid)) this.dialAttempts.set(pid, 0)
    }
    for (const pid of [...this.dialAttempts.keys()]) {
      if (!peers.includes(pid) && !this.peers.has(pid)) this.dialAttempts.delete(pid)
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

  /** Connect to one peer, unless it is already connected or being retried. */
  private dial(pid: number): void {
    if (!this.started) return
    if (this.peers.has(pid)) return
    const attempts = this.dialAttempts.get(pid) ?? 0
    if (attempts >= MAX_DIAL_ATTEMPTS) return
    this.dialAttempts.set(pid, attempts + 1)
    const endpoint = instanceBusEndpoint(this.directory, pid)
    let socket: Socket
    try {
      socket = createConnection(endpoint)
    } catch {
      this.scheduleRedial()
      return
    }
    socket.unref()
    socket.setNoDelay(true)
    socket.on('connect', () => {
      this.peers.set(pid, socket)
      this.attachLink(socket)
    })
    socket.on('error', () => {
      // Expected while a peer is starting or already gone: the peer list is the
      // truth, and the next membership push (or the redial below) tries again.
      this.forgetPeer(pid)
      this.scheduleRedial()
    })
    socket.on('close', () => this.forgetPeer(pid))
  }

  /** Retry the peer list once after a delay, so a peer that is still booting connects. */
  private scheduleRedial(): void {
    if (!this.started || this.redialTimer) return
    this.redialTimer = setTimeout(() => {
      this.redialTimer = null
      this.reconcilePeers()
    }, REDIAL_DELAY_MS)
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
    const payload = parseFrame(line, this.localPid)
    if (!payload) return
    // One link per peer pair is the rule, so a repeat should be impossible; this
    // is the guard that keeps a duplicate from duplicating streamed text if two
    // links ever do form (a stale endpoint from an earlier run, a reconnection
    // that overlaps its predecessor).
    if (payload.seq > 0) {
      const last = this.lastSeqByPid.get(payload.from) ?? 0
      if (payload.seq <= last) return
      this.lastSeqByPid.set(payload.from, payload.seq)
    }
    for (const listener of this.listeners) {
      try {
        listener(payload)
      } catch (error) {
        Logger.error('Cross-instance event listener failed:', error)
      }
    }
  }
}

/**
 * Decode one frame, rejecting anything this build cannot trust: a foreign or
 * missing version, our own echo, an event type that must not cross the boundary,
 * or a payload that is not a complete event.
 */
function parseFrame(line: string, localPid: number): RemoteAgentEventPayload | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const frame = value as Partial<InstanceBusFrame>
  if (frame.v !== 1) return null
  if (typeof frame.from !== 'number' || frame.from === localPid) return null
  if (!frame.event || typeof frame.event !== 'object') return null
  const event = frame.event as AgentEvent
  if (typeof event.type !== 'string' || !isRemoteRenderEvent(event)) return null
  return {
    projectId: typeof frame.projectId === 'string' ? frame.projectId : '',
    threadId: typeof frame.threadId === 'string' ? frame.threadId : '',
    event,
    from: frame.from,
    seq: typeof frame.seq === 'number' ? frame.seq : 0
  }
}

/** Singleton shared by the main process lifecycle. */
export const instanceEventBus = new InstanceEventBus()
