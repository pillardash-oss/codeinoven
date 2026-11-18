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
  HostRequestEnvelope,
  HostResponseEnvelope,
  HostSessionListEntry,
  HostSessionState
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
  command: HostCreateSessionCommand
}

export interface SupervisorOptions {
  /** Requests that never answer are failed instead of hanging a caller forever. */
  requestTimeoutMs?: number
}

interface LiveHost {
  /** Stable id for this host, derived from its pid and start order. */
  readonly id: string
  readonly transport: HostTransport
  /** Requests waiting for a response line, by request id. */
  waiting: Map<string, (response: HostResponseEnvelope) => void>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

export class PiHostSupervisor {
  readonly #spawn: HostSpawner
  readonly #timeoutMs: number
  readonly #ownership = new SessionOwnership()
  /** Every running host. More than one when a device cap or a move needs it. */
  readonly #hosts = new Map<string, LiveHost>()
  /** Which host runs which session. */
  readonly #sessionHost = new Map<string, string>()
  #primaryId: string | null = null
  #sequence = 0
  #hostSequence = 0
  /** Where each session runs, so a move can resume it rather than rebuild it. */
  readonly #sessions = new Map<string, TransferableSession>()

  constructor(spawn: HostSpawner, options: SupervisorOptions = {}) {
    this.#spawn = spawn
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
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

  /** Create a session on the primary host, starting one if needed. */
  async createSession(request: HostCreateRequest): Promise<HostSessionState> {
    const host = this.#ensurePrimary()
    this.#ownership.claim(request.sessionId, host.id)
    try {
      const response = await this.#request(host, request.sessionId, request.command)
      const state = this.#stateOf(response)
      this.#sessionHost.set(request.sessionId, host.id)
      this.#sessions.set(request.sessionId, this.#transferable(state))
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
    const record = this.#sessions.get(sessionId)
    const source = this.#hostForSession(sessionId)
    if (record === undefined || source === null) throw new Error(`Unknown session: ${sessionId}`)
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
      this.#sessions.set(sessionId, this.#transferable(state))
      return state
    } catch (error) {
      this.#ownership.release(sessionId, target.id)
      this.#stopHost(target.id)
      throw error
    }
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
    return host
  }

  #onExit(host: LiveHost): void {
    for (const [id, resolve] of host.waiting) {
      resolve({ type: 'response', id, ok: false, error: 'Host exited' })
    }
    host.waiting.clear()
    this.#hosts.delete(host.id)
    if (this.#primaryId === host.id) this.#primaryId = null
    // A dead host's sessions lose their process but not their transcript: they
    // are dropped from the host map so a later request can be resumed elsewhere.
    for (const sessionId of this.#sessionsOn(host.id)) {
      this.#ownership.release(sessionId, host.id)
      this.#sessionHost.delete(sessionId)
    }
  }

  #consume(host: LiveHost, line: string): void {
    let envelope: { type?: string; id?: string }
    try {
      envelope = JSON.parse(line) as { type?: string; id?: string }
    } catch {
      return
    }
    if (envelope.type !== 'response' || typeof envelope.id !== 'string') return
    const response = envelope as HostResponseEnvelope
    const waiting = host.waiting.get(response.id)
    if (waiting === undefined) return
    host.waiting.delete(response.id)
    waiting(response)
  }

  #stopHost(hostId: string): void {
    const host = this.#hosts.get(hostId)
    if (host === undefined) return
    this.#hosts.delete(hostId)
    if (this.#primaryId === hostId) this.#primaryId = null
    for (const [, resolve] of host.waiting) {
      resolve({ type: 'response', id: 'stopped', ok: false, error: 'Host stopped' })
    }
    host.waiting.clear()
    host.transport.stop()
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
      const timer = setTimeout(() => {
        host.waiting.delete(id)
        reject(new Error(`Host did not answer ${command.type} in ${this.#timeoutMs} ms`))
      }, this.#timeoutMs)
      timer.unref?.()
      host.waiting.set(id, (response) => {
        clearTimeout(timer)
        resolve(response)
      })
      host.transport.send(JSON.stringify(request))
    })
  }

  #stateOf(response: HostResponseEnvelope): HostSessionState {
    if (!response.ok) throw new Error(response.error)
    return response.data as HostSessionState
  }

  #transferable(state: HostSessionState): TransferableSession {
    return {
      sessionId: state.sessionId,
      cwd: state.cwd,
      agentDir: state.agentDir,
      sessionPath: state.sessionFile ?? ''
    }
  }
}
