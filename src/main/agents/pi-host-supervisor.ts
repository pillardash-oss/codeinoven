/**
 * The app's one long-lived Pi host.
 *
 * Every thread used to start its own `pi --mode rpc` process, which pays a Node
 * boot, the extension load and a provider registry read per thread. This
 * supervisor starts a single host instead, hands it every session, and keeps the
 * mapping the rest of main needs: which host owns which session, and how to move
 * one when a host fills up or dies.
 *
 * The transport is injected so the supervisor can be driven by a real utility
 * process in the app and by a test double everywhere else. It owns three rules
 * and nothing else: one session on one host at a time, a crash loses no session
 * (the transcript is on disk and the session resumes on the replacement), and a
 * host that has no sessions is stopped rather than left resident.
 */
import { SessionOwnership, resumeRequest, type TransferableSession } from './pi-session-transfer'
import type {
  HostCommand,
  HostCreateSessionCommand,
  HostNoticeEnvelope,
  HostRequestEnvelope,
  HostResponseEnvelope,
  HostSessionListEntry,
  HostSessionState,
  HostUiRequest,
  HostUiResponse
} from '../drivers/pi/session-host/protocol'

/** One running host process, addressed by lines. */
export interface HostTransport {
  readonly pid: number
  send(line: string): void
  onLine(listener: (line: string) => void): void
  onExit(listener: (code: number | null) => void): void
  /** Stop the host. Sessions it owned must already be spoken for elsewhere. */
  stop(): void
}

/** How the supervisor starts a host: a utility process in the app, a child in tests. */
export type HostSpawner = () => HostTransport

export interface HostCreateRequest {
  /** The app's session key. Stable across hosts. */
  sessionId: string
  /** Set for a sub-agent session: the session that spawned it. */
  parentSessionId?: string
  command: HostCreateSessionCommand
}

export interface SupervisorOptions {
  /** Requests that never answer are failed instead of hanging a caller forever. */
  requestTimeoutMs?: number
  /**
   * Sessions one host may hold before the next one lands on a second host.
   *
   * This is the app's soft cap: the device decides how many sessions one process
   * carries, and past it the supervisor scales out instead of refusing work.
   */
  maxSessionsPerHost?: number
}

interface LiveHost {
  /** Stable id for this host, derived from its pid and start order. */
  readonly id: string
  readonly transport: HostTransport
  /** Requests waiting for a response line, by request id. */
  waiting: Map<string, PendingRequest>
}

/** One request in flight, so a long one can be kept alive by its own activity. */
interface PendingRequest {
  resolve(response: HostResponseEnvelope): void
  /** Push the deadline out by one more window; only a compaction ever does. */
  touch(): void
  /** Session the request belongs to, or null for a host-wide command. */
  readonly sessionId: string | null
  readonly compaction: boolean
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

export class PiHostSupervisor {
  readonly #spawn: HostSpawner
  readonly #timeoutMs: number
  readonly #maxSessionsPerHost: number
  readonly #ownership = new SessionOwnership()
  /** Every running host. More than one when a device cap or a move needs it. */
  readonly #hosts = new Map<string, LiveHost>()
  /** Which host runs which session. */
  readonly #sessionHost = new Map<string, string>()
  #primaryId: string | null = null
  #sequence = 0
  #hostSequence = 0
  readonly #uiListeners: ((sessionId: string, request: HostUiRequest) => void)[] = []
  readonly #noticeListeners: ((
    sessionId: string | undefined,
    notice: HostNoticeEnvelope
  ) => void)[] = []
  readonly #eventListeners: ((sessionId: string, event: Record<string, unknown>) => void)[] = []
  readonly #lostListeners: ((sessionId: string) => void)[] = []
  readonly #hostsChangedListeners: (() => void)[] = []
  /** Where each session runs, so a move can resume it rather than rebuild it. */
  readonly #sessions = new Map<string, TransferableSession>()

  constructor(spawn: HostSpawner, options: SupervisorOptions = {}) {
    this.#spawn = spawn
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#maxSessionsPerHost = Math.max(1, options.maxSessionsPerHost ?? 8)
  }

  /** The primary host's pid, or null when nothing is running. */
  pid(): number | null {
    return this.#primary()?.transport.pid ?? null
  }

  /** Every running host's pid, so main can list them as separate services. */
  pids(): number[] {
    return [...this.#hosts.values()].map((host) => host.transport.pid)
  }

  /** The host running a session, by pid, or null when it is not hosted yet. */
  hostOf(sessionId: string): number | null {
    const hostId = this.#sessionHost.get(sessionId)
    if (hostId === undefined) return null
    return this.#hosts.get(hostId)?.transport.pid ?? null
  }

  /** Session keys hosted right now, across every host. */
  sessions(): string[] {
    return [...this.#sessionHost.keys()]
  }

  /** Start the primary host if it is not running. */
  async start(): Promise<number> {
    return this.#ensurePrimary().transport.pid
  }

  /**
   * Create a session, on the primary host while it has room and on a new host
   * once it does not. A full host never refuses a session and never grows past
   * the cap, which is what keeps one process from carrying the whole machine.
   */
  async createSession(request: HostCreateRequest): Promise<HostSessionState> {
    const primary = this.#ensurePrimary()
    const host =
      this.#sessionsOn(primary.id).length >= this.#maxSessionsPerHost ? this.#spawnHost() : primary
    this.#ownership.claim(request.sessionId, host.id)
    try {
      const response = await this.#request(host, request.sessionId, request.command)
      const state = this.#stateOf(response)
      const parentSessionId = request.parentSessionId ?? request.command.parentSessionId
      this.#sessionHost.set(request.sessionId, host.id)
      this.#sessions.set(
        request.sessionId,
        this.#transferable(state, {
          sessionId: request.sessionId,
          cwd: state.cwd,
          agentDir: state.agentDir,
          sessionPath: state.sessionFile ?? '',
          ...(request.command.extensionPaths === undefined
            ? {}
            : { extensionPaths: request.command.extensionPaths }),
          ...(request.command.tools === undefined ? {} : { tools: request.command.tools }),
          ...(state.model === undefined ? {} : { model: state.model }),
          ...(parentSessionId === undefined ? {} : { parentSessionId })
        })
      )
      return state
    } catch (error) {
      this.#ownership.release(request.sessionId, host.id)
      throw error
    }
  }

  /** Send a command to a session and answer with its response. */
  async request(sessionId: string, command: HostCommand): Promise<HostResponseEnvelope> {
    const host = this.#hostForSession(sessionId) ?? this.#ensurePrimary()
    return this.#request(host, sessionId, command)
  }

  /** Drop a session from its host and stop a host left holding nothing. */
  async disposeSession(sessionId: string): Promise<void> {
    const host = this.#hostForSession(sessionId)
    if (host === null) return
    await this.#request(host, sessionId, { type: 'dispose_session' })
    this.#ownership.release(sessionId, host.id)
    this.#sessionHost.delete(sessionId)
    this.#sessions.delete(sessionId)
    if (this.#sessionsOn(host.id).length === 0) this.#stopHost(host.id)
  }

  /**
   * Move a session to a host of its own.
   *
   * The order matters: the source releases the session before the target claims
   * it, so two hosts never write one transcript. The target is always a new
   * process, because a move that stays on the same process is not a move.
   */
  async moveToNewHost(sessionId: string): Promise<HostSessionState> {
    const known = this.#sessions.get(sessionId)
    const source = this.#hostForSession(sessionId)
    if (known === undefined || source === null) throw new Error(`Unknown session: ${sessionId}`)
    // Read the live session before it is disposed: the model and transcript it
    // reports now are what the target has to resume, and the create-time record
    // may predate a model switch made by the driver.
    const live = await this.#request(source, sessionId, { type: 'get_state' })
    const record =
      live.ok && live.data !== undefined
        ? this.#transferable(live.data as HostSessionState, known)
        : known
    await this.#request(source, sessionId, { type: 'dispose_session' })
    this.#ownership.release(sessionId, source.id)
    this.#sessionHost.delete(sessionId)
    if (this.#sessionsOn(source.id).length === 0) this.#stopHost(source.id)

    const target = this.#spawnHost()
    this.#ownership.claim(sessionId, target.id)
    try {
      const response = await this.#request(
        target,
        sessionId,
        resumeRequest(record, `resume-${sessionId}`).command
      )
      const state = this.#stateOf(response)
      this.#sessionHost.set(sessionId, target.id)
      this.#sessions.set(sessionId, this.#transferable(state, record))
      return state
    } catch (error) {
      try {
        this.#ownership.release(sessionId, target.id)
      } catch {
        // The claim above is what created this ownership; a release that finds
        // nobody only happens if it was already given back.
      }
      this.#stopHost(target.id)
      throw error
    }
  }

  /**
   * Listen to the dialogs hosted sessions are blocked on, so main can draw the
   * same permission and question cards it draws for an RPC process.
   */
  /** Listen to the events every hosted session streams, keyed by session. */
  onEvent(listener: (sessionId: string, event: Record<string, unknown>) => void): () => void {
    this.#eventListeners.push(listener)
    return () => {
      const index = this.#eventListeners.indexOf(listener)
      if (index >= 0) this.#eventListeners.splice(index, 1)
    }
  }

  /** Unsolicited host-level messages, such as a session that failed to load. */
  onNotice(
    listener: (sessionId: string | undefined, notice: HostNoticeEnvelope) => void
  ): () => void {
    this.#noticeListeners.push(listener)
    return () => {
      const index = this.#noticeListeners.indexOf(listener)
      if (index >= 0) this.#noticeListeners.splice(index, 1)
    }
  }

  onUiRequest(listener: (sessionId: string, request: HostUiRequest) => void): () => void {
    this.#uiListeners.push(listener)
    return () => {
      const index = this.#uiListeners.indexOf(listener)
      if (index >= 0) this.#uiListeners.splice(index, 1)
    }
  }

  /**
   * Sessions whose host disappeared without disposing them.
   *
   * A crash is not a disposal: the session's transcript is still on disk and it
   * can be resumed, but everything the caller was waiting on in that process is
   * gone. The driver listens here so a crashed host settles its turn immediately
   * instead of leaving the thread working until the next request fails.
   */
  onSessionLost(listener: (sessionId: string) => void): () => void {
    this.#lostListeners.push(listener)
    return () => {
      const index = this.#lostListeners.indexOf(listener)
      if (index >= 0) this.#lostListeners.splice(index, 1)
    }
  }

  /** Running hosts changed: a host started, died, or was stopped. */
  onHostsChanged(listener: () => void): () => void {
    this.#hostsChangedListeners.push(listener)
    return () => {
      const index = this.#hostsChangedListeners.indexOf(listener)
      if (index >= 0) this.#hostsChangedListeners.splice(index, 1)
    }
  }

  /** Answer a dialog the host forwarded. Never answered by the host itself. */
  async respondToUi(sessionId: string, requestId: string, response: HostUiResponse): Promise<void> {
    await this.request(sessionId, { type: 'ui_response', requestId, response })
  }

  /** What every running host reports it is running, as each host sees it. */
  async listSessions(): Promise<HostSessionListEntry[]> {
    const entries: HostSessionListEntry[] = []
    for (const host of this.#hosts.values()) {
      const response = await this.#request(host, null, { type: 'list_sessions' })
      if (response.ok && Array.isArray(response.data)) {
        entries.push(...(response.data as HostSessionListEntry[]))
      }
    }
    return entries
  }

  /** Stop every host. Sessions end; their transcripts stay on disk. */
  stop(): void {
    for (const hostId of [...this.#hosts.keys()]) this.#stopHost(hostId)
  }

  /**
   * Stop one host by its OS pid, which is what the task manager offers.
   *
   * Only that process goes. Its sessions lose their host exactly as they would
   * if it crashed, so each of their clients is told now and the turns that were
   * running fail visibly instead of waiting on a process that no longer exists;
   * every other host keeps working. A pid that is not a live host is ignored,
   * because a row can outlive the process it describes by one refresh.
   */
  stopHost(pid: number): void {
    for (const [hostId, host] of [...this.#hosts]) {
      if (host.transport.pid !== pid) continue
      for (const sessionId of this.#stopHost(hostId)) {
        for (const listener of this.#lostListeners) listener(sessionId)
      }
      return
    }
  }

  #primary(): LiveHost | null {
    return this.#primaryId === null ? null : (this.#hosts.get(this.#primaryId) ?? null)
  }

  #hostForSession(sessionId: string): LiveHost | null {
    const hostId = this.#sessionHost.get(sessionId)
    if (hostId === undefined) return null
    return this.#hosts.get(hostId) ?? null
  }

  #sessionsOn(hostId: string): string[] {
    const sessionIds: string[] = []
    for (const [sessionId, owner] of this.#sessionHost) {
      if (owner === hostId) sessionIds.push(sessionId)
    }
    return sessionIds
  }

  #ensurePrimary(): LiveHost {
    const primary = this.#primary()
    if (primary !== null) return primary
    const host = this.#spawnHost()
    this.#primaryId = host.id
    return host
  }

  #spawnHost(): LiveHost {
    this.#hostSequence += 1
    const transport = this.#spawn()
    const host: LiveHost = {
      id: `host-${this.#hostSequence}-${transport.pid}`,
      transport,
      waiting: new Map()
    }
    transport.onLine((line) => this.#consume(host, line))
    transport.onExit(() => this.#onExit(host))
    this.#hosts.set(host.id, host)
    this.#hostsChanged()
    return host
  }

  #onExit(host: LiveHost): void {
    for (const [id, pending] of host.waiting) {
      pending.resolve({ type: 'response', id, ok: false, error: 'Host exited' })
    }
    host.waiting.clear()
    this.#hosts.delete(host.id)
    if (this.#primaryId === host.id) this.#primaryId = null
    // A dead host's sessions lose their process but not their transcript: they
    // are dropped from the host map so a later request can be resumed elsewhere.
    for (const sessionId of this.#releaseSessions(host)) {
      for (const listener of this.#lostListeners) listener(sessionId)
    }
    this.#hostsChanged()
  }

  /**
   * Drop every session a host owns, without throwing out of an exit listener.
   *
   * Ownership and the session map can diverge (a rejected create, a probe that
   * disposes twice), and an exception here would escape into the transport's
   * exit callback with nobody to catch it. The caller needs the session ids so
   * it can report the loss, so the ids are collected first and the release is
   * best effort per session.
   */
  #releaseSessions(host: LiveHost): string[] {
    const sessionIds = this.#sessionsOn(host.id)
    for (const sessionId of sessionIds) {
      try {
        this.#ownership.release(sessionId, host.id)
      } catch {
        // Already released by an earlier failure path; the mapping is what has
        // to go, and it goes below.
      }
      this.#sessionHost.delete(sessionId)
    }
    return sessionIds
  }

  #hostsChanged(): void {
    for (const listener of this.#hostsChangedListeners) listener()
  }

  #consume(host: LiveHost, line: string): void {
    let envelope: { type?: string; id?: string; sessionId?: unknown }
    try {
      envelope = JSON.parse(line) as { type?: string; id?: string; sessionId?: unknown }
    } catch {
      return
    }
    // A checkpoint summarizes a large transcript page by page, which legitimately
    // runs for many minutes and reports each step as a status line. Those lines
    // are the request's liveness: without them a fixed deadline kills a working
    // compaction at the same age a hung one would reach. Only a compaction is
    // extended, because every other command answers in milliseconds and a dead
    // one must still surface as a failure.
    if (typeof envelope.sessionId === 'string') {
      for (const pending of host.waiting.values()) {
        if (pending.compaction && pending.sessionId === envelope.sessionId) pending.touch()
      }
    }
    if (envelope.type === 'event') {
      const event = envelope as { sessionId?: unknown; event?: unknown }
      if (
        typeof event.sessionId === 'string' &&
        typeof event.event === 'object' &&
        event.event !== null
      ) {
        for (const listener of this.#eventListeners) {
          listener(event.sessionId, event.event as Record<string, unknown>)
        }
      }
      return
    }
    if (envelope.type === 'ui_request') {
      const request = envelope as { sessionId?: unknown; request?: unknown }
      if (typeof request.sessionId === 'string' && request.request !== undefined) {
        for (const listener of this.#uiListeners) {
          listener(request.sessionId, request.request as HostUiRequest)
        }
      }
      return
    }
    if (envelope.type === 'host_notice') {
      const notice = envelope as HostNoticeEnvelope
      for (const listener of this.#noticeListeners) {
        listener(notice.sessionId, notice)
      }
      return
    }
    if (envelope.type !== 'response' || typeof envelope.id !== 'string') return
    const response = envelope as HostResponseEnvelope
    const waiting = host.waiting.get(response.id)
    if (waiting === undefined) return
    host.waiting.delete(response.id)
    waiting.resolve(response)
  }

  /** Stop one host, answering with the sessions it had to drop. */
  #stopHost(hostId: string): string[] {
    const host = this.#hosts.get(hostId)
    if (host === undefined) return []
    this.#hosts.delete(hostId)
    if (this.#primaryId === hostId) this.#primaryId = null
    for (const [, pending] of host.waiting) {
      pending.resolve({ type: 'response', id: 'stopped', ok: false, error: 'Host stopped' })
    }
    host.waiting.clear()
    // A deliberate stop is not a crash: the caller either emptied the host or
    // is shutting the app down, and the sessions' clients are being disposed by
    // that caller. Releasing here keeps ownership and the map from drifting.
    const released = this.#releaseSessions(host)
    host.transport.stop()
    this.#hostsChanged()
    return released
  }

  #request(
    host: LiveHost,
    sessionId: string | null,
    command: HostCommand
  ): Promise<HostResponseEnvelope> {
    this.#sequence += 1
    const id = `req-${this.#sequence}`
    const request: HostRequestEnvelope = {
      type: 'request',
      id,
      ...(sessionId === null ? {} : { sessionId }),
      command
    }
    return new Promise((resolve, reject) => {
      const compaction = command.type === 'compact'
      const timer = setTimeout(() => {
        host.waiting.delete(id)
        reject(new Error(`Host did not answer ${command.type} in ${this.#timeoutMs} ms`))
      }, this.#timeoutMs)
      timer.unref?.()
      host.waiting.set(id, {
        sessionId,
        compaction,
        touch: () => {
          if (compaction) timer.refresh()
        },
        resolve: (response) => {
          clearTimeout(timer)
          resolve(response)
        }
      })
      host.transport.send(JSON.stringify(request))
    })
  }

  #stateOf(response: HostResponseEnvelope): HostSessionState {
    if (!response.ok) throw new Error(response.error)
    return response.data as HostSessionState
  }

  #transferable(state: HostSessionState, previous?: TransferableSession): TransferableSession {
    const extensionPaths = previous?.extensionPaths
    const tools = previous?.tools
    const parentSessionId = previous?.parentSessionId
    const model = state.model ?? previous?.model
    return {
      sessionId: state.sessionId,
      cwd: state.cwd,
      agentDir: state.agentDir,
      sessionPath: state.sessionFile ?? previous?.sessionPath ?? '',
      // These three are not part of the host's session state: the host reports
      // where and how it runs, not what the app loaded into it. They are carried
      // from the record so a moved session keeps its extensions, its tools, and
      // the parent a sub-agent belongs to.
      ...(extensionPaths === undefined ? {} : { extensionPaths }),
      ...(tools === undefined ? {} : { tools }),
      ...(model === undefined ? {} : { model }),
      ...(parentSessionId === undefined ? {} : { parentSessionId })
    }
  }
}
