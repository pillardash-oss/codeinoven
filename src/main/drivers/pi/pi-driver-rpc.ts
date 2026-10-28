import { buildProcessEnvironmentAsync, OWNED_SESSION_MARKER } from '../cli-environment'
import { prepareHarnessInvocation, resolveHarnessRuntime } from '../harness-runtime'
import { PiRpcClient } from '../pi-rpc-client'
import { SpawnAdmission } from '../spawn-admission'
import type { AgentMessage } from '../../../lib/types'
import { Logger } from '../../system/logger'
import type { DevStepClock } from '../../system/dev-timing'
import type { PersistentCliSession } from '../persistent-cli-driver'
import type { PreparedUtilityRuntime } from '../driver.interface'
import type { ChildProcess } from 'node:child_process'

/**
 * How long an idle thread may keep its pi process resident. Every live harness
 * process owns its own heap (tens to hundreds of megabytes) for as long as it
 * exists, and a thread that is not running a turn does not need one: the next
 * turn spawns a fresh process and resumes the persisted native transcript
 * (see `resumeNativePiSession`), the same path an app restart and a crash use.
 * Nothing is evicted while a turn, a worker, or a pending card still owns the
 * session.
 *
 * The window is deliberately longer than a user's think time. Five minutes
 * evicted the process of the thread the user was reading, so the follow-up they
 * sent after any pause paid a full spawn, an extension reload and a transcript
 * resume before the prompt could even reach pi: measured at roughly a second of
 * pure loss per pause, and invisible to the user as anything but "it is slow
 * again". A resident process is not wasted work; it is the thing that makes a
 * follow-up instant, and it is still released once the thread has genuinely
 * been left alone.
 */
const PI_SESSION_IDLE_DISPOSE_MS = 30 * 60_000

/** Cadence of the idle sweep. One timer serves every session of the driver. */
const PI_SESSION_IDLE_SWEEP_MS = 60_000

/** Everything the RPC process lifecycle needs from the driver. */
export interface PiRpcSessionsHost {
  readonly id: string
  readonly accountEnvironment: NodeJS.ProcessEnv
  requireSession(projectPath: string, sessionId: string): Promise<PersistentCliSession>
  isTitleSession(sessionId: string): boolean
  utilityRuntime(sessionId: string): PreparedUtilityRuntime | undefined
  resolveRuntimePlaceholders(value: string, runtime: PreparedUtilityRuntime): string
  workspaceTemporaryEnvironment(
    projectPath: string
  ): Promise<{ TMPDIR: string; TEMP: string; TMP: string }>
  observeHarnessProcess(
    sessionId: string,
    process: ChildProcess,
    command: string,
    projectPath: string
  ): void
  materializeCoreToolsExtension(sessionId: string, bundledRuntime: boolean): Promise<string | null>
  materializeProvidersExtension(sessionId: string): Promise<string | null>
  providerExtensionEnv(sessionId: string): Record<string, string> | undefined
  forgetCioSession(sessionId: string): void
  resumeNativeSession(projectPath: string, sessionId: string, client: PiRpcClient): Promise<void>
  syncNativeSessionId(projectPath: string, sessionId: string): Promise<void>
  /** Start the session's turn state from its mirrored messages. */
  initializeTurnState(sessionId: string, messages: AgentMessage[]): void
  hasActiveTurn(sessionId: string): boolean
  endActiveTurn(sessionId: string): void
  clearPageCompaction(sessionId: string): void
  resetSubagentWatch(sessionId: string): void
  publishWatchLists(): void
  /** Settle every child transcript of a session whose process died. */
  failChildStreams(sessionId: string): void
  hasLiveChildSession(sessionId: string): boolean
  hasPendingUiRequest(sessionId: string): boolean
  forgetUsage(sessionId: string): void
  finishTurn(session: PersistentCliSession): Promise<void>
  handleRpcEvent(
    record: Record<string, unknown>,
    sessionId: string,
    projectPath: string
  ): Promise<void>
  handleUiRequest(record: Record<string, unknown>, sessionId: string): void
  handleExtensionStatus(record: Record<string, unknown>, sessionId: string): void
}

/**
 * The pi RPC process lifecycle: one resident `pi --mode rpc` child per session,
 * its spawn admission, its bootstrap, its teardown, and the idle sweep that
 * releases a process the user has stopped using.
 */
export class PiRpcSessions {
  private readonly rpcClients = new Map<string, PiRpcClient>()
  /**
   * In-flight session bootstraps, keyed by session id.
   *
   * A bootstrap spawns the process and then REPLACES its session (`new_session`,
   * plus the native-transcript `switch_session` when one is resumed). Pi disposes
   * the replaced session   invalidating the extension context bound to it   as
   * soon as the replacement runs, so a command dispatched into that window lands
   * on a session that is about to be torn down: its run then dies mid-flight
   * with "This extension ctx is stale after session replacement or reload",
   * which reaches the user as a failed turn. Publishing the client before its
   * bootstrap finished made that reachable whenever two callers met a cold
   * session at once (a second send, a steered message, a warm-up racing the
   * turn), because the second caller found the client in `rpcClients` and
   * dispatched immediately. Every caller now awaits the one bootstrap.
   */
  private readonly rpcClientBootstraps = new Map<string, Promise<PiRpcClient>>()
  private readonly sessionProjects = new Map<string, string>()
  /**
   * Last activity per live RPC session (any RPC record, prompt, steer, or
   * abort). Feeds the idle sweep that disposes resident harness processes, so
   * a thread that finished its work stops holding a process and its heap.
   */
  private readonly sessionActivityAt = new Map<string, number>()
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null
  private readonly compactionReadySessions = new Set<string>()
  /**
   * Admission for pi process spawns, so a turn never races the app's own
   * background one-shot sessions. See `SpawnAdmission`.
   */
  private readonly spawnAdmission = new SpawnAdmission()
  /**
   * Model/thinking-level last applied to each session's live pi RPC process.
   * Pi's own interactive mode only sends `set_model`/`set_thinking_level`
   * when the user actually changes them (see interactive-mode.js), never
   * before every prompt   re-sending them unconditionally on every turn adds
   * two blocking RPC round-trips with no progress signal, which is what left
   * follow-up turns stuck on the bare spinner. Cleared whenever the RPC
   * client is disposed so a freshly spawned process still gets an explicit
   * set_model on its first turn.
   */
  private readonly appliedPiSettings = new Map<
    string,
    { provider: string; modelId: string; thinkingLevel: string }
  >()
  /**
   * Sessions whose live RPC process was started by loading the previously
   * persisted native pi transcript (`switch_session`). The chat engine's
   * resume decision reads `loadMessages` before this process exists; this set
   * records the outcome for observability and cleanup.
   */
  private readonly resumedNativeSessions = new Set<string>()

  constructor(private readonly host: PiRpcSessionsHost) {}

  client(sessionId: string): PiRpcClient | undefined {
    return this.rpcClients.get(sessionId)
  }

  hasClient(sessionId: string): boolean {
    return this.rpcClients.has(sessionId)
  }

  clientIds(): string[] {
    return [...this.rpcClients.keys()]
  }

  clientEntries(): IterableIterator<[string, PiRpcClient]> {
    return this.rpcClients.entries()
  }

  projectOf(sessionId: string): string | undefined {
    return this.sessionProjects.get(sessionId)
  }

  projectEntries(): IterableIterator<[string, string]> {
    return this.sessionProjects.entries()
  }

  lastSessionProject(): string | undefined {
    return [...this.sessionProjects.values()][0]
  }

  appliedSettings(
    sessionId: string
  ): { provider: string; modelId: string; thinkingLevel: string } | undefined {
    return this.appliedPiSettings.get(sessionId)
  }

  setAppliedSettings(
    sessionId: string,
    settings: { provider: string; modelId: string; thinkingLevel: string }
  ): void {
    this.appliedPiSettings.set(sessionId, settings)
  }

  markNativeSessionResumed(sessionId: string): void {
    this.resumedNativeSessions.add(sessionId)
  }

  markCompactionReady(sessionId: string): void {
    this.compactionReadySessions.add(sessionId)
  }

  isCompactionReady(sessionId: string): boolean {
    return this.compactionReadySessions.has(sessionId)
  }

  clearCompactionReady(sessionId: string): void {
    this.compactionReadySessions.delete(sessionId)
  }

  async ensureClient(
    projectPath: string,
    sessionId: string,
    steps?: DevStepClock
  ): Promise<PiRpcClient> {
    // The in-flight bootstrap wins over the published client: `rpcClients` holds
    // the client from the moment it is spawned (Pi's events, UI requests, exit
    // handling and the task manager all need that reference), but the client is
    // only safe to dispatch into once its session replacement has completed.
    const bootstrap = this.rpcClientBootstraps.get(sessionId)
    if (bootstrap) return bootstrap
    const existing = this.rpcClients.get(sessionId)
    if (existing) return existing
    const started = this.startClient(projectPath, sessionId, steps)
    this.rpcClientBootstraps.set(sessionId, started)
    try {
      return await started
    } finally {
      if (this.rpcClientBootstraps.get(sessionId) === started) {
        this.rpcClientBootstraps.delete(sessionId)
      }
    }
  }

  /**
   * The session's live client, once any in-flight bootstrap has settled. A
   * caller that must dispatch a session-bound command (a steered message, a
   * re-prompt) sees the client only after its replacement finished; a bootstrap
   * that failed leaves the caller with whatever the map holds, let it fail its
   * own way rather than surfacing the bootstrap error twice.
   */
  async settledClient(sessionId: string): Promise<PiRpcClient | undefined> {
    const bootstrap = this.rpcClientBootstraps.get(sessionId)
    if (!bootstrap) return this.rpcClients.get(sessionId)
    try {
      return await bootstrap
    } catch {
      return this.rpcClients.get(sessionId)
    }
  }

  /**
   * Spawn this session's Pi process and bootstrap the session itself. Never call
   * this directly   `ensureClient` owns the one-bootstrap-per-session rule.
   *
   * The spawn is admitted first: a user's turn takes a slot immediately, while a
   * disposable one-shot session (title, summary, verdict) waits for an idle
   * machine and then starts alone. Four one-shot sessions once spawned beside a
   * real turn and turned its 1.5 s pi start into 5.4 s.
   */
  private async startClient(
    projectPath: string,
    sessionId: string,
    steps?: DevStepClock
  ): Promise<PiRpcClient> {
    const finishAdmissionWait = steps?.begin('spawnAdmission')
    const releaseSpawn = await this.spawnAdmission.enter(
      this.host.isTitleSession(sessionId) ? 'background' : 'interactive'
    )
    finishAdmissionWait?.()
    try {
      return await this.launchClient(projectPath, sessionId, steps)
    } finally {
      releaseSpawn()
    }
  }

  /** The spawn itself. `startClient` owns the admission slot around it. */
  private async launchClient(
    projectPath: string,
    sessionId: string,
    steps?: DevStepClock
  ): Promise<PiRpcClient> {
    const session = await this.timedStep(
      steps,
      'sessionLookup',
      this.host.requireSession(projectPath, sessionId)
    )
    this.host.initializeTurnState(sessionId, session.messages)
    const runtime = this.host.utilityRuntime(sessionId)
    const args = runtime
      ? runtime.args.map((arg) => this.host.resolveRuntimePlaceholders(arg, runtime))
      : []
    const runtimeEnv = runtime
      ? Object.fromEntries(
          Object.entries(runtime.env).map(([key, value]) => [
            key,
            this.host.resolveRuntimePlaceholders(value, runtime)
          ])
        )
      : {}
    const resolvedRuntime = await this.timedStep(
      steps,
      'harnessRuntime',
      resolveHarnessRuntime('pi', projectPath)
    )
    if (!resolvedRuntime) {
      throw new Error(
        'Pi is not installed. Install the Pi CLI globally, then retry. (npm i -g @earendil-works/pi-coding-agent)'
      )
    }
    // The single app-owned "cio-core-tools" extension composes status, usage,
    // utility gateway, and core tools into ONE module loaded through ONE
    // `--extension` flag, so pi's process boot pays a single extension load
    // instead of four. The checkpoint policy is required for every session.
    const cioCoreToolsExtensionPath = await this.timedStep(
      steps,
      'coreToolsExtension',
      this.host.materializeCoreToolsExtension(sessionId, resolvedRuntime.target.kind === 'bundled')
    )
    if (!cioCoreToolsExtensionPath) {
      throw new Error(
        'Cannot start Pi without the CodeInOven compaction extension. Retry after resolving the extension materialization error.'
      )
    }
    const extensionArgs = ['--extension', cioCoreToolsExtensionPath]
    // Custom providers (app-store entries plus, inside managed containers, the
    // harness-global models.json providers) must be registered in THIS process
    // too, or `set_model` rejects models the model picker offered.
    const providersExtensionPath = await this.timedStep(
      steps,
      'providersExtension',
      this.host.materializeProvidersExtension(sessionId)
    )
    if (providersExtensionPath) {
      extensionArgs.push('--extension', providersExtensionPath)
    }
    const invocation = await this.timedStep(
      steps,
      'harnessInvocation',
      prepareHarnessInvocation('pi', ['--mode', 'rpc', ...extensionArgs, ...args], {
        cwd: projectPath,
        env: {
          ...(await buildProcessEnvironmentAsync({
            ...process.env,
            ...this.host.accountEnvironment
          })),
          ...(this.host.providerExtensionEnv(sessionId) ?? {}),
          ...runtimeEnv,
          ...(await this.host.workspaceTemporaryEnvironment(projectPath)),
          // Session-scoped ownership marker so any daemon this Pi session spawns
          // that re-parents away from the process tree (e.g. the adb server) can
          // still be attributed back to this session by the agent process
          // service. It is the same marker every other CLI harness stamps.
          [OWNED_SESSION_MARKER]: sessionId
        }
      })
    )
    // Account environments can resolve a different executable than discovery.
    // Use the prepared invocation as the authority before starting the process.
    if (invocation.runtime.target.kind !== resolvedRuntime.target.kind) {
      const rematerialized = await this.host.materializeCoreToolsExtension(
        sessionId,
        invocation.runtime.target.kind === 'bundled'
      )
      if (!rematerialized) throw new Error('Cannot start Pi without its file-access policy')
    }
    const client = new PiRpcClient({
      invocation,
      onEvent: (record) => {
        void this.host.handleRpcEvent(record, sessionId, projectPath)
      },
      onUiRequest: (record) => {
        this.host.handleUiRequest(record, sessionId)
      },
      onExtensionStatus: (record) => {
        this.host.handleExtensionStatus(record, sessionId)
      },
      onExit: (code) => {
        this.handleExit(code, sessionId, client)
      }
    })
    this.rpcClients.set(sessionId, client)
    this.sessionProjects.set(sessionId, projectPath)
    this.touchSessionActivity(sessionId)
    this.ensureIdleSweep()
    // Register the long-lived RPC harness root with the app's process tracker
    // so it appears in the task manager and is covered by orphan reaping.
    //
    // The label is the harness command (`pi`), never `invocation.command`: a
    // bundled Pi runs on Electron's own executable, so the prepared command is
    // the app binary's path and the task manager would show a Pi root as
    // `CodeInOven-electron` instead of `pi`. `runtime.command` is the command
    // the user asked for in both the bundled and native cases, so the row reads
    // the harness that actually owns the process again.
    this.host.observeHarnessProcess(
      sessionId,
      client.process,
      invocation.runtime?.command ?? invocation.command,
      projectPath
    )
    try {
      this.compactionReadySessions.delete(sessionId)
      await this.timedStep(steps, 'newSession', client.newSession())
      if (!this.compactionReadySessions.has(sessionId)) {
        throw new Error(
          'The CodeInOven compaction extension did not load. Pi was stopped to prevent fallback to its default compaction.'
        )
      }
      // Resume the persisted native transcript BEFORE syncing the native
      // session id: `switch_session` makes the resumed session current, so the
      // sync below then records the same id the thread was already bound to.
      // A transient failure here must never block the turn.
      await this.timedStep(
        steps,
        'resumeTranscript',
        this.host.resumeNativeSession(projectPath, sessionId, client)
      )
      await this.timedStep(
        steps,
        'sessionSync',
        Promise.allSettled([
          client.setAutoRetry(true),
          // CodeInOven owns compaction for this session. Pi's own threshold is
          // `contextWindow - reserveTokens` (a flat 16k), which is far above what
          // a provider that bills the completion budget against the same window
          // actually accepts, so it never fires in time; leaving it on would race
          // our page checkpoints and could rewrite the transcript we keep. Manual
          // compaction (the `compact` RPC) is unaffected by this switch.
          client.setAutoCompaction(false),
          this.host.syncNativeSessionId(projectPath, sessionId)
        ])
      )
    } catch (error) {
      client.dispose()
      this.rpcClients.delete(sessionId)
      this.sessionProjects.delete(sessionId)
      this.host.forgetCioSession(sessionId)
      throw new Error(
        `Failed to start a Pi session: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }
    return client
  }

  /** Time one unit of the client bootstrap when a dispatch clock is present. */
  private timedStep<T>(
    steps: DevStepClock | undefined,
    step: string,
    work: Promise<T>
  ): Promise<T> {
    return steps ? steps.step(step, work) : work
  }

  /** A client's exit event; a replaced client's stale exit is ignored. */
  handleExit(code: number | null, sessionId: string, exitedClient: PiRpcClient): void {
    void code
    // A session can replace its RPC process while the old child is still
    // delivering its exit event. Never let that stale callback dispose the
    // replacement client or turn its next request into "Pi process disposed".
    if (this.rpcClients.get(sessionId) !== exitedClient) return
    this.settleDeadClient(sessionId)
  }

  /**
   * Tear down everything that belonged to a session whose RPC process is gone:
   * the client record, its nested workers, and any turn it still owned. Shared
   * by a crashed process and a deliberate harness restart so both settle the
   * same way instead of leaving a mid-turn session stuck.
   */
  settleDeadClient(sessionId: string): void {
    // Drop the dead client so the next turn spawns a fresh RPC process and
    // resumes the persisted native transcript instead of failing on a dead
    // pipe (or worse, silently continuing a context-less session).
    this.disposeClient(sessionId)
    // Nested worker sessions lived inside this process: their transcripts settle
    // as failed, or a killed session would leave their cards spinning forever.
    this.host.failChildStreams(sessionId)
    const projectPath = this.sessionProjects.get(sessionId)
    if (this.host.hasActiveTurn(sessionId)) {
      this.host.endActiveTurn(sessionId)
      // The pi process died mid-turn; persist whatever was mirrored and
      // surface the idle state so the thread does not stay "working".
      if (projectPath) {
        this.host
          .requireSession(projectPath, sessionId)
          .then((session) => void this.host.finishTurn(session))
          .catch((error) => Logger.dev('Pi exit finalization failed:', error))
      }
    }
  }

  disposeClient(sessionId: string): void {
    this.compactionReadySessions.delete(sessionId)
    this.host.clearPageCompaction(sessionId)
    this.sessionActivityAt.delete(sessionId)
    this.host.resetSubagentWatch(sessionId)
    const client = this.rpcClients.get(sessionId)
    if (client) {
      client.dispose()
      this.rpcClients.delete(sessionId)
    }
    if (this.rpcClients.size === 0) this.stopIdleSweep()
    this.resumedNativeSessions.delete(sessionId)
    this.appliedPiSettings.delete(sessionId)
    this.host.forgetUsage(sessionId)
    this.host.forgetCioSession(sessionId)
  }

  /** Release every idle client of one project (a project closed). */
  releaseProject(projectPath: string): void {
    for (const [sessionId, clientProject] of this.sessionProjects) {
      if (clientProject !== projectPath) continue
      if (this.host.hasActiveTurn(sessionId)) continue
      this.disposeClient(sessionId)
    }
  }

  /**
   * Restart every session's RPC process so the next turn spawns the Pi runtime
   * currently on disk. A session's client is long-lived (`pi --mode rpc` keeps
   * the resumed native transcript in memory), so without this an updated Pi
   * binary only reaches the app at the next launch.
   */
  restartAll(): void {
    for (const sessionId of [...this.rpcClients.keys()]) {
      Logger.info('Restarting the Pi RPC process for a harness restart', { sessionId })
      // Dispose first so the exit event the kill raises cannot re-enter the
      // teardown, then run the same settlement a crashed process gets: a turn
      // that was mid-flight must not stay "working" until the watchdog fires.
      this.rpcClients.get(sessionId)?.dispose()
      this.settleDeadClient(sessionId)
    }
  }

  /** Drop every client and its bookkeeping (driver disposal). */
  clear(): void {
    for (const client of this.rpcClients.values()) client.dispose()
    this.rpcClients.clear()
    this.rpcClientBootstraps.clear()
    this.stopIdleSweep()
  }

  /** Stamp the last activity of a live session for the idle sweep. */
  touchSessionActivity(sessionId: string): void {
    this.sessionActivityAt.set(sessionId, Date.now())
  }

  /** Arm the idle sweep with the first live client; it stops with the last one. */
  private ensureIdleSweep(): void {
    if (this.idleSweepTimer) return
    this.idleSweepTimer = setInterval(() => this.sweepIdleSessions(), PI_SESSION_IDLE_SWEEP_MS)
    // Never hold the app's event loop open for an eviction that can wait.
    if (typeof this.idleSweepTimer.unref === 'function') this.idleSweepTimer.unref()
  }

  private stopIdleSweep(): void {
    if (!this.idleSweepTimer) return
    clearInterval(this.idleSweepTimer)
    this.idleSweepTimer = null
  }

  /**
   * Dispose the harness process of every session that has been idle past the
   * eviction window. A session is skippable for as long as anything can still
   * produce output on it: a registered turn (which covers a run in progress,
   * an RPC compaction, and a pi-managed retry window, since only
   * `agent_settled` clears it), a nested worker that has not settled, or a
   * permission/question card the user has not answered yet.
   */
  private sweepIdleSessions(): void {
    const now = Date.now()
    // The same cadence lapses watch marks nobody refreshed: a closed sub-agent
    // view must stop its worker's token stream within a bounded window.
    this.host.publishWatchLists()
    for (const [sessionId] of this.rpcClients) {
      if (this.host.hasActiveTurn(sessionId)) continue
      if (this.host.hasLiveChildSession(sessionId)) continue
      if (this.host.hasPendingUiRequest(sessionId)) continue
      const idleSince = this.sessionActivityAt.get(sessionId) ?? now
      if (now - idleSince < PI_SESSION_IDLE_DISPOSE_MS) continue
      Logger.info('Evicting the harness process of an idle session', {
        sessionId,
        idleMs: now - idleSince
      })
      this.disposeClient(sessionId)
    }
  }
}
