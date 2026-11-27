/**
 * The app's one long-lived Pi host.
 *
 * Every thread used to start its own `pi --mode rpc` process, which pays a Node
 * boot, the extension load and a provider registry read per thread. This
 * supervisor starts a single host instead, hands it every session, and keeps the
 * mapping the rest of main needs: which host owns which session, and how to move
 * one when a host dies.
 *
 * The transport is injected so the supervisor can be driven by a real utility
 * process in the app and by a test double everywhere else. It owns four rules
 * and nothing else: one session on one host at a time, a crash loses no session
 * (the transcript is on disk and the session resumes on the replacement), a host
 * that has no sessions is stopped rather than left resident, and a host that is
 * spending a whole core on its own sessions may open a temporary host whose
 * sessions are drained back into the primary once that host has room again.
 *
 * One host stays the goal, because it is the cheapest arrangement in RAM, and
 * nothing in that arrangement is capped: the primary carries every session the
 * app has, however many that is. A second host is a loan taken against the
 * primary host's own CPU, never the machine's (another process cannot free a CPU
 * some other program is using) and never the session count (a session costs one
 * heap either way, and the host it runs on is the one already loaded).
 */
import { SessionOwnership, resumeRequest, type TransferableSession } from './pi-session-transfer'
import {
  hostHasRoom,
  hostIsSaturated,
  holdsAdmission,
  type AdmissionDecision
} from '../../lib/resource-admission'
import { Logger } from '../system/logger'
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
   * The primary host's own CPU use, as a percentage of one core, over a short
   * window. This is what decides whether new work lands on a second process.
   *
   * Null means no reading: nothing is known to be saturated, so new work stays
   * on the primary and a borrowed host's sessions go home. A sampler that
   * cannot answer must never cost the user another process.
   *
   * Injected rather than imported so the supervisor has no dependency on the
   * process metrics and a test drives the placement arithmetic directly.
   */
  readHostCpu?: (pid: number) => number | null
  /**
   * The device reading that may only ever refuse a second process.
   *
   * A saturated host is a reason to open one, but a machine short on memory is
   * the case where another process makes the machine worse instead of better,
   * so the work stays on the saturated primary. It is never a reason to open a
   * host, and it is never consulted again for a session that has a home.
   */
  readPressure?: () => Promise<AdmissionDecision>
  /**
   * How often a temporary host is re-read for its chance to rejoin.
   *
   * The timer only exists while a temporary host does, and it goes as soon as
   * the last one is drained, so an idle app holds no supervision loop.
   */
  rebalanceIntervalMs?: number
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
  readonly #readHostCpu: ((pid: number) => number | null) | null
  readonly #readPressure: (() => Promise<AdmissionDecision>) | null
  readonly #rebalanceIntervalMs: number
  /** The rejoin check, alive only while a temporary host is. */
  #rebalanceTimer: NodeJS.Timeout | null = null
  /** One rejoin at a time, so two ticks cannot move the same session twice. */
  #rebalancing = false
  readonly #ownership = new SessionOwnership()
  /** Every running host. More than one when a device cap or a move needs it. */
  readonly #hosts = new Map<string, LiveHost>()
  /** Which host runs which session. */
  readonly #sessionHost = new Map<string, string>()
  /**
   * Sessions with a turn in flight.
   *
   * A host keeps a finished session resident so the next prompt on that thread is
   * instant, so "how many sessions this process holds" and "how many threads are
   * working" are different numbers. The task manager reports the second one: a
   * row that counted resident sessions read as work that had already finished.
   * The driver reports each turn's start and settlement here.
   */
  readonly #busySessions = new Set<string>()
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
    this.#readHostCpu = options.readHostCpu ?? null
    this.#readPressure = options.readPressure ?? null
    this.#rebalanceIntervalMs = Math.max(250, options.rebalanceIntervalMs ?? 5_000)
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

  /** How many sessions one host process carries, or 0 for an unknown pid. */
  sessionsOn(pid: number): number {
    for (const host of this.#hosts.values()) {
      if (host.transport.pid === pid) return this.#sessionsOn(host.id).length
    }
    return 0
  }

  /**
   * How many sessions on one host are mid-turn, or 0 for an unknown pid.
   *
   * This is what a host's row reports, because it answers what the process is
   * doing rather than what it is keeping warm.
   */
  busyOn(pid: number): number {
    for (const host of this.#hosts.values()) {
      if (host.transport.pid !== pid) continue
      let busy = 0
      for (const sessionId of this.#busySessions) {
        if (this.#sessionHost.get(sessionId) === host.id) busy += 1
      }
      return busy
    }
    return 0
  }

  /**
   * Report that a session's turn started or settled.
   *
   * The driver owns what a turn is; this only remembers it, so the host's row can
   * tell work in flight from a session kept warm for the next prompt. A session
   * with no host is ignored, which is what a locally spawned CLI child is.
   */
  noteSessionBusy(sessionId: string, busy: boolean): void {
    const known = this.#busySessions.has(sessionId)
    if (!known && !busy) return
    if (busy) this.#busySessions.add(sessionId)
    else this.#busySessions.delete(sessionId)
    if (known === busy) return
    this.#hostsChanged()
  }

  /** Start the primary host if it is not running. */
  async start(): Promise<number> {
    return this.#ensurePrimary().transport.pid
  }

  /**
   * Create a session, on the primary host unless that host is saturated and a
   * temporary one is warranted.
   *
   * One host keeps RAM low, so a second process is opened only for the one
   * reason a second process can fix: this host's own CPU is a whole core busy.
   * Neither how many sessions it carries nor how busy the machine is decides
   * that.
   */
  async createSession(request: HostCreateRequest): Promise<HostSessionState> {
    const primary = this.#ensurePrimary()
    const host = await this.#hostForNewSession(primary)
    this.#ownership.claim(request.sessionId, host.id)
    try {
      const response = await this.#request(host, request.sessionId, request.command)
      const state = this.#stateOf(response)
      const parentSessionId = request.parentSessionId ?? request.command.parentSessionId
      this.#mountSession(request.sessionId, host.id)
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
      // The host this create asked for holds nothing now: a process started for
      // a session that never landed is one more Pi host in the task manager,
      // and no other path ever stops an empty one.
      this.#stopHostIfEmpty(host.id)
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
    this.#unmountSession(sessionId)
    this.#sessions.delete(sessionId)
    if (this.#sessionsOn(host.id).length === 0) this.#stopHost(host.id)
  }

  /**
   * Move a session to a host of its own.
   *
   * The order matters: the source releases the session before the target claims
   * it, so two hosts never write one transcript. The target is always a new
   * process, because a move that stays on the same process is not a move. A
   * temporary host drains the other way, into the primary, through the same
   * release-then-claim pair (see {@link rebalance}), but a move never hands a
   * session back out of the host it was moved to: the target is that session's
   * home, and the supervisor adopts it as the primary rather than opening yet
   * another process beside it.
   */
  async moveToNewHost(sessionId: string): Promise<HostSessionState> {
    const known = this.#sessions.get(sessionId)
    const source = this.#hostForSession(sessionId)
    if (known === undefined || source === null) throw new Error(`Unknown session: ${sessionId}`)
    // Read the live session before it is disposed: the model and transcript it
    // reports now are what the target has to resume, and the create-time record
    // may predate a model switch made by the driver.
    const record = await this.#liveRecord(source, sessionId, known)
    await this.#releaseFrom(source, sessionId)
    const target = this.#spawnHost()
    try {
      const state = await this.#resumeOn(target, sessionId, record)
      // The move empties its source first, so the spawn above may have seen no
      // primary at all and armed nothing. The process it just made is the app's
      // only host in that case, and the check has to exist for it: the tick
      // adopts it as the primary rather than leaving the app without one.
      if (target.id !== this.#primaryId) this.#armRebalance()
      return state
    } catch (error) {
      // This process exists only for the move, so a failed resume leaves nothing
      // worth keeping. The primary is not this move's to stop, and rebalance
      // never reaches here.
      this.#stopHost(target.id)
      throw error
    }
  }

  /**
   * Drain the sessions a temporary host borrowed back into the primary.
   *
   * A temporary host is a loan, not a home: once the primary host is no longer
   * loaded with its own work, its borrowed sessions resume here and the emptied
   * process stops, which returns the app to the one-host arrangement that costs
   * the least RAM.
   *
   * Only the primary host's own CPU decides when that is. A device reading is
   * never consulted: moving sessions home removes a process, so the machine
   * being busy elsewhere is neither a reason to wait nor a reason to move.
   *
   * Three things hold a session where it is. The primary host can still be
   * loaded with its own sessions, in which case the loan is still earning its
   * place. A session with a turn or a checkpoint in flight stays, because a move
   * is a resume and the answer would lose its process midway. And a session with
   * no transcript cannot be resumed anywhere, so it is left alone. A move that
   * fails leaves that one session on its temporary host and the rest still
   * rejoin on the next tick.
   */
  async rebalance(): Promise<void> {
    if (this.#rebalancing) return
    if (this.#secondaries().length === 0) {
      this.#disarmRebalance()
      return
    }
    this.#rebalancing = true
    try {
      // A primary that exited took its sessions with it, and the hosts left are
      // the app's only home: the oldest is adopted instead of a third process
      // being opened beside it, which turns the rest of this tick into a plain
      // drain into that host.
      const primary = this.#ensurePrimary()
      if (!hostHasRoom(this.#hostCpu(primary))) return
      for (const donor of this.#secondaries()) {
        for (const sessionId of this.#sessionsOn(donor.id)) {
          if (!this.#hosts.has(donor.id)) break
          const record = this.#sessions.get(sessionId)
          if (record === undefined) continue
          if (this.#requestInFlight(donor, sessionId)) continue
          const state = await this.#idleState(donor, sessionId)
          if (state === null) continue
          try {
            await this.#releaseFrom(donor, sessionId)
            await this.#resumeOn(primary, sessionId, this.#transferable(state, record))
          } catch (error) {
            Logger.dev('Host rebalance: session stayed on its temporary host', {
              sessionId,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        }
      }
    } finally {
      this.#rebalancing = false
      // A drain is also the moment a host with nothing left on it goes: the loan
      // is repaid, and an empty process is a Pi host the app has no work for.
      this.#stopEmptySecondaries()
      if (this.#secondaries().length === 0) this.#disarmRebalance()
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

  /**
   * Running hosts changed: a host started, died, or was stopped, or the set of
   * sessions one of them carries changed.
   */
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
    this.#disarmRebalance()
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

  /** Every host that is not the primary, which is every temporary host. */
  #secondaries(): LiveHost[] {
    return [...this.#hosts.values()].filter((host) => host.id !== this.#primaryId)
  }

  /**
   * Where a new session lands.
   *
   * The primary carries every session the app has; how many that is never moves
   * a session off it. A second process is opened for one reason alone: this host
   * is spending a whole core on its own sessions, so its event loop is what new
   * work would queue behind. The machine's CPU is not a reason, because
   * offloading a session from a host that is idle moves no work off whatever is
   * pinning the machine; it only adds a second process to it. The device reading
   * is allowed to refuse the spawn when memory cannot carry one, and to nothing
   * else.
   */
  async #hostForNewSession(primary: LiveHost): Promise<LiveHost> {
    if (!hostIsSaturated(this.#hostCpu(primary))) return primary
    if (await this.#deviceRefusesNewProcess()) return primary
    return this.#temporary()
  }

  /**
   * The primary host's own CPU, or null when it was never read.
   *
   * A reader that throws costs a placement decision, never the session: an
   * unreadable host is an unsaturation host, and the work stays where it is.
   */
  #hostCpu(host: LiveHost): number | null {
    if (this.#readHostCpu === null) return null
    const pid = host.transport.pid
    if (pid <= 0) return null
    try {
      return this.#readHostCpu(pid)
    } catch (error) {
      Logger.dev('Host placement: the host CPU reading failed', error)
      return null
    }
  }

  /** Whether the machine is too short on memory to carry one more process. */
  async #deviceRefusesNewProcess(): Promise<boolean> {
    const decision = await this.#readDevice()
    return decision !== null && holdsAdmission(decision)
  }

  /**
   * The one temporary host, started only when none is running.
   *
   * A loan is a single process: another one relieves nothing the first already
   * relieved, and every extra host is another heap for the same machine.
   */
  #temporary(): LiveHost {
    return this.#secondaries()[0] ?? this.#spawnHost()
  }

  /** The device reading, or null when no sampler is wired or it cannot answer. */
  async #readDevice(): Promise<AdmissionDecision | null> {
    if (this.#readPressure === null) return null
    try {
      return await this.#readPressure()
    } catch (error) {
      Logger.dev('Host placement: device reading failed, so nothing refuses the host', error)
      return null
    }
  }

  /** Start the rejoin check, which exists only while a temporary host does. */
  #armRebalance(): void {
    if (this.#rebalanceTimer !== null) return
    if (this.#secondaries().length === 0) return
    const timer = setInterval(() => void this.rebalance(), this.#rebalanceIntervalMs)
    timer.unref?.()
    this.#rebalanceTimer = timer
  }

  #disarmRebalance(): void {
    if (this.#rebalanceTimer === null) return
    clearInterval(this.#rebalanceTimer)
    this.#rebalanceTimer = null
  }

  /** The live record a target host needs, falling back to the create-time one. */
  async #liveRecord(
    source: LiveHost,
    sessionId: string,
    known: TransferableSession
  ): Promise<TransferableSession> {
    const live = await this.#request(source, sessionId, { type: 'get_state' })
    return live.ok && live.data !== undefined
      ? this.#transferable(live.data as HostSessionState, known)
      : known
  }

  /**
   * A session that can be picked up right now, or null when it cannot.
   *
   * A turn or a checkpoint in flight is what makes a move unsafe here, and a
   * session with no transcript has nothing for another host to resume.
   */
  async #idleState(host: LiveHost, sessionId: string): Promise<HostSessionState | null> {
    let response: HostResponseEnvelope
    try {
      response = await this.#request(host, sessionId, { type: 'get_state' })
    } catch {
      return null
    }
    if (!response.ok || response.data === undefined) return null
    const state = response.data as HostSessionState
    if (state.isStreaming || state.isCompacting) return null
    if (typeof state.sessionFile !== 'string' || state.sessionFile.length === 0) return null
    return state
  }

  #requestInFlight(host: LiveHost, sessionId: string): boolean {
    for (const pending of host.waiting.values()) {
      if (pending.sessionId === sessionId) return true
    }
    return false
  }

  /** Release a session from its host, stopping that host if this emptied it. */
  async #releaseFrom(source: LiveHost, sessionId: string): Promise<void> {
    await this.#request(source, sessionId, { type: 'dispose_session' })
    this.#ownership.release(sessionId, source.id)
    this.#unmountSession(sessionId)
    if (this.#sessionsOn(source.id).length === 0) this.#stopHost(source.id)
  }

  /** Claim a session on a target host and resume its transcript there. */
  async #resumeOn(
    target: LiveHost,
    sessionId: string,
    record: TransferableSession
  ): Promise<HostSessionState> {
    this.#ownership.claim(sessionId, target.id)
    try {
      const response = await this.#request(
        target,
        sessionId,
        resumeRequest(record, `resume-${sessionId}`).command
      )
      const state = this.#stateOf(response)
      this.#mountSession(sessionId, target.id)
      this.#sessions.set(sessionId, this.#transferable(state, record))
      return state
    } catch (error) {
      try {
        this.#ownership.release(sessionId, target.id)
      } catch {
        // The claim above is what created this ownership; a release that finds
        // nobody only happens if it was already given back.
      }
      throw error
    }
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

  /**
   * The primary host, adopted when one already runs and started only when none
   * does.
   *
   * A process that is already up is always the cheaper home. After a move the
   * session's new host is the only one left, and spawning a second process
   * beside it left the app carrying two hosts for good, one of them holding a
   * session nothing would ever drain. Adopting the oldest live host keeps the
   * app at one process whatever order the moves arrived in.
   */
  #ensurePrimary(): LiveHost {
    const primary = this.#primary()
    if (primary !== null) return primary
    const oldest = this.#hosts.values().next().value
    if (oldest !== undefined) {
      this.#primaryId = oldest.id
      this.#hostsChanged()
      return oldest
    }
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
    // Every host that is not the primary is a loan in one form or another, and a
    // loan is only safe while something watches to take it back. Arming at the
    // spawn rather than at the call sites is what keeps a host opened by a move
    // supervised: the drain used to exist only for hosts a session had already
    // landed on, so a move's process was never drained by anything.
    if (this.#primaryId !== null && this.#primaryId !== host.id) this.#armRebalance()
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
    if (this.#secondaries().length === 0) this.#disarmRebalance()
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
      this.#busySessions.delete(sessionId)
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

  /**
   * Record which host runs a session, and tell every listener.
   *
   * A host's task-manager row carries how many sessions it is carrying, so this
   * mapping is part of what the row says. The row is written the moment the
   * process appears, which is before the session that asked for it has landed,
   * so a change here that nobody hears is a count frozen at zero for the life of
   * that host.
   */
  #mountSession(sessionId: string, hostId: string): void {
    this.#sessionHost.set(sessionId, hostId)
    this.#hostsChanged()
  }

  /** Drop a session's host mapping and tell every listener, if it had one. */
  #unmountSession(sessionId: string): void {
    // A session that left its host cannot be working on it, and a mark left
    // behind would count against whichever host picks it up next.
    this.#busySessions.delete(sessionId)
    if (this.#sessionHost.delete(sessionId)) this.#hostsChanged()
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

  /**
   * Stop a host that holds nothing and that no session is being landed on.
   *
   * Empty is both halves: no mounted session, and no claimed one, because a
   * create claims its host before the session is mounted and stopping that host
   * would kill the create in flight. Nothing else in the supervisor stops an
   * empty host: a drain empties a host by moving its sessions out, so a host
   * that started empty stays resident for the life of the app.
   */
  #stopHostIfEmpty(hostId: string): void {
    if (this.#sessionsOn(hostId).length > 0) return
    if (this.#ownership.ownedBy(hostId).length > 0) return
    this.#stopHost(hostId)
  }

  /** Stop every temporary host that came up empty, leaving the primary alone. */
  #stopEmptySecondaries(): void {
    for (const host of this.#secondaries()) this.#stopHostIfEmpty(host.id)
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
    if (this.#secondaries().length === 0) this.#disarmRebalance()
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
