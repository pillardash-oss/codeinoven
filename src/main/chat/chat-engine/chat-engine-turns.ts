import { isAbsolute, join, resolve } from 'path'
import { Logger } from '../../system/logger'
import { warmOpenCodeInstallation } from '../../agents/opencode-installation'
import { LATE_CLAIM_REOPEN_WINDOW_MS } from '../../storage/checkpoint-manager'
import { updateRetryWakeWindow } from '../thread-events'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import type { AuxiliaryModelCandidate, HarnessDriver } from '../../drivers/driver.interface'
import {
  continuationRequestPrompt,
  pendingContinuationRequest,
  type PendingContinuationRequest
} from '../../../lib/pending-request'
import type { RankingQueueHead } from '../../database/repositories/model-ranking-snapshot-repo'
import { instanceRegistry } from '../../system/instance-registry'
import type {
  AgentAccountUsage,
  AgentEvent,
  AgentProviderIssue,
  AgentSessionStatus,
  PromptProjectReference,
  ThreadStatus,
  Thread
} from '../../../lib/types'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID } from '../../../lib/types'
import { foldTurnStreamDetailed } from '../turn-stream'
import { auxiliarySelectionFor } from '../../../lib/auxiliary-agents'
import { classifyProviderIssue, isUsageResetWaitIssue } from '../../../lib/provider-issue'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc/browser'
import { GenerationClock, generatedTokens } from '../../../lib/usage-rate'
import { ASSISTANT_CWD_DIR, BROWSER_CWD_DIR, CHATS_CWD_DIR } from '../../../lib/project-artifacts'
import type { AuxiliaryRoute, SessionInfo, CompletedTurnFold } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import {
  CONTINUATION_REQUEST_PAGE_MESSAGES,
  SPEC_GENERATION_MAX_ATTEMPTS,
  isIdleSignalEvent,
  isTerminalSubagentPatch
} from './chat-engine-constants'
import {
  UNBOUNDED_MUTATING_TOOLS,
  changedPathsFromTool,
  normalizedToolName
} from './chat-engine-changes'
import { turnStreamPath } from './chat-engine-pure'
import { toolActionLabelForPart } from '../../../lib/tool-action-label'
import { ChatEngine, isTurnBoundaryPrompt } from '../chat-engine'

/** ChatEngine turns: one concern, moved verbatim from the composition root. */
export class ChatEngineTurns {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Join the OpenCode install probe and converge the driver map on its result.
   *
   * A driver is acquired for every turn and account-scoped read, so this is
   * where installation readiness is awaited: by the time the driver is returned
   * the probe has settled and `refreshOpenCodeHarness` has swapped the map (or
   * recorded a pending swap because a turn still owns the harness). Once the
   * probe has settled, `warmOpenCodeInstallation` answers from memory, so later
   * acquisitions pay nothing.
   */
  async resolveOpenCodeTransport(): Promise<void> {
    await warmOpenCodeInstallation().catch((error: unknown) => {
      Logger.dev('opencode install detection failed (non-fatal):', error)
      return null
    })
    this.host.refreshOpenCodeHarness()
  }

  allDrivers(): HarnessDriver[] {
    return [...new Set([...this.host.drivers.values(), ...this.host.state.accountDrivers.values()])]
  }

  setPrototypePreviewRegistrar(
    registrar: ((previewSlug: string, canonicalRoot: string) => Promise<void>) | null
  ): void {
    this.host.state.prototypePreviewRegistrar = registrar
  }

  markEngineeringLifecycleFailure(projectId: string, threadId: string, error: unknown): void {
    const state = this.host.state.engineeringLifecycleEngine.get(projectId, threadId)
    if (!state?.activeStage || state.selection === 'none') return
    this.host.state.engineeringLifecycleEngine.fail(projectId, threadId, rawErrorMessage(error))
  }

  /** Whether the thread's Engineering lifecycle currently has an active stage
   *  selection or Auto Pilot   the legacy `engineeringMode` settings flag was
   *  scrubbed and the lifecycle is the single source of truth. */
  engineeringLifecycleActive(projectId: string, threadId: string): boolean {
    const lifecycle = this.host.state.engineeringLifecycleEngine.get(projectId, threadId)
    return (
      lifecycle !== null && (lifecycle.selection !== 'none' || lifecycle.startedAt !== undefined)
    )
  }

  /**
   * Redeem one banked rate-limit reset credit for the thread's harness.
   * Destructive and irreversible   it immediately resets the account's usage
   * windows and consumes one banked credit. Only Codex currently supports
   * this; other harnesses return null.
   */
  async activateBankedReset(
    projectId: string,
    threadId: string
  ): Promise<AgentAccountUsage | null> {
    const projectIdSafe = validateEntityId(projectId, 'Project ID')
    await this.host.threadCreation?.awaitReady(threadId)
    const thread = await this.host.threadManager.getThread(projectIdSafe, threadId)
    if (!thread) return null
    const harnessId = thread.settings?.harnessId
    if (!harnessId) return null
    const accountId = (
      await this.host.state.accountRegistry.resolveForProvider(
        harnessId,
        thread.settings?.providerId,
        thread.settings?.accountId
      )
    ).id
    const { driver, projectPath } = await this.host.resolve(
      projectIdSafe,
      harnessId,
      threadId,
      accountId
    )
    if (!driver.activateBankedReset) return null
    const telemetry = await driver.activateBankedReset(projectPath)
    if (!telemetry) return null
    const providerId = thread.settings?.providerId ?? harnessId
    return { harnessId, providerId, accountId, ...telemetry }
  }

  /**
   * A local working directory for an app-wide harness discovery pass.
   *
   * Discovery only needs a writable cwd for the harness CLI: the models a
   * harness reports do not depend on the project's files. A remote (Oven)
   * project's path exists only on the Oven, so resolving it here pointed every
   * harness at a directory this machine cannot create and forced the bundled
   * fallback catalog on the whole app.
   */
  async discoveryWorkingDirectory(projectId: string): Promise<string> {
    const project = await this.host.state.projectManager.getProject(projectId)
    // A missing project row must never fail an app-wide pass: a cold data root
    // requests the inbox catalog before its hidden row is written, and discovery
    // needs nothing from the project anyway.
    if (project?.source === 'local' && project.path) {
      return this.resolveProjectPath(projectId)
    }
    return this.ephemeralWorkingDirectory()
  }

  /**
   * Resolve a driver's default provider/model for tool discovery. Prefers the
   * already-discovered provider catalog (kept fresh by the provider TTL and
   * invalidated on explicit refresh) so a repeat Tools-tab load never spawns a
   * harness CLI subprocess; falls back to live `driver.listProviders` when the
   * catalog has no entry, or whenever the caller forces a refresh.
   */
  async resolveDriverDefaultModel(
    driverId: string,
    projectPath: string,
    projectId: string,
    force: boolean
  ): Promise<{ providerId?: string; modelId?: string }> {
    if (!force) {
      const catalogs =
        this.host.state.sharedProviderCatalog?.catalogs ??
        (await this.host.listProviderSnapshot(projectId))
      const known = catalogs.find(
        (catalog) => catalog.harnessId === driverId && catalog.models.length > 0
      )
      if (known) return { providerId: known.id, modelId: known.models[0]?.id }
    }
    const driver = this.host.drivers.get(driverId)
    if (!driver) return {}
    const catalogs = await driver.listProviders(projectPath)
    const provider = catalogs.find((catalog) => catalog.models.length > 0)
    return { providerId: provider?.id, modelId: provider?.models[0]?.id }
  }

  async shouldRotateForImplementation(
    projectId: string,
    threadId: string,
    status: ThreadStatus,
    engineeringActive: boolean,
    wasPlanningSession: boolean
  ): Promise<boolean> {
    if (engineeringActive || (!wasPlanningSession && status !== 'awaiting_approval')) {
      return false
    }
    const workflow = await this.host.state.specEngine.getWorkflowState(projectId, threadId)
    if (
      workflow?.stage !== 'spec_approved' ||
      !workflow.activeSpecId ||
      !workflow.activeSpecVersion
    ) {
      return false
    }
    const active = await this.host.state.specEngine.getVersion(
      projectId,
      threadId,
      workflow.activeSpecId,
      workflow.activeSpecVersion
    )
    return active?.status === 'approved'
  }

  /** A project is doing live work   reset its idle/released state. */
  markProjectActive(projectId: string): void {
    this.host.state.projectIdleSince.delete(projectId)
    this.host.state.releasedProjects.delete(projectId)
  }

  /** Record a project path before a driver call can lazily allocate resources. */
  trackProjectResourcePath(projectId: string, projectPath: string): void {
    const paths = this.host.state.projectResourcePaths.get(projectId) ?? new Set<string>()
    paths.add(projectPath)
    this.host.state.projectResourcePaths.set(projectId, paths)
    this.markProjectActive(projectId)
  }

  async validateProjectReferences(
    projectId: string,
    references: PromptProjectReference[] | undefined,
    scopeBucketId?: string
  ): Promise<PromptProjectReference[]> {
    if (references === undefined || references.length === 0) return []
    if (!Array.isArray(references) || references.length > 20) {
      throw new TypeError('Project references must be an array of at most 20 paths')
    }
    const project = await this.host.state.projectManager.getProject(projectId)
    if (project?.id === INBOX_PROJECT_ID) return []
    const validated = references.map((reference, index): PromptProjectReference => {
      if (typeof reference !== 'object' || reference === null || Array.isArray(reference)) {
        throw new TypeError(`Project reference ${index + 1} must be an object`)
      }
      const id = validateEntityId(reference.id, `Project reference ${index + 1} ID`, 256)
      const name = validateBoundedString(
        reference.name,
        `Project reference ${index + 1} name`,
        1,
        255
      )
      const path = validateBoundedString(
        reference.path,
        `Project reference ${index + 1} path`,
        1,
        4_096
      )
      if (reference.kind !== 'file' && reference.kind !== 'directory') {
        throw new TypeError(`Project reference ${index + 1} kind must be file or directory`)
      }
      return { id, name, path, kind: reference.kind }
    })
    return this.host.state.projectFilesService.validatePromptReferences(
      projectId,
      validated,
      scopeBucketId
    )
  }

  // ─── Thread auto-titling ──────────────────────────────────────────────────

  /**
   * A local working directory for one disposable harness turn.
   *
   * An Oven project's path lives on the Oven, so resolving it on this machine
   * points at a directory that does not exist here (and that `/home` famously
   * refuses to create on macOS). A turn that never reads the project's files
   * (one-shot titles, app-wide discovery) runs under `eph-cwd`, in a per-thread
   * subdirectory when a thread owns it.
   */
  async ephemeralWorkingDirectory(threadId?: string): Promise<string> {
    const relative = threadId ? join(ChatEngine.EPH_CWD_DIR, threadId) : ChatEngine.EPH_CWD_DIR
    await this.host.storage.ensureDirectory(relative)
    return this.host.storage.resolve(relative)
  }

  /**
   * Resolve the user-assigned auxiliary model for threads running
   * `threadHarnessId`, or null when nothing is assigned. A null result keeps
   * the caller on its harness-native cheap-model behaviour, so an unconfigured
   * app behaves exactly as before. A configured assignment that cannot be
   * resolved (harness no longer installed, account signed out) also returns
   * null after logging, which routes the caller to its own fallback instead of
   * failing the background job.
   */
  async resolveAuxiliaryRoute(target: {
    /** Harness the owning thread runs on; the assignment is keyed by it. */
    threadHarnessId: string
    threadId?: string
    projectId?: string
    /** Explicit working directory; grading runs outside any thread. */
    projectPath?: string
  }): Promise<AuxiliaryRoute | null> {
    const config = await this.host.storage.getConfig()
    const selection = auxiliarySelectionFor(config.auxiliaryAgents, target.threadHarnessId)
    if (!selection) return null
    try {
      const account = await this.host.state.accountRegistry.resolveForProvider(
        selection.harnessId,
        selection.providerId,
        selection.accountId
      )
      if (target.projectPath !== undefined) {
        const driver = await this.host.driverForAccount(selection.harnessId, account.id)
        return this.host.units['runtime-agents'].buildAuxiliaryRoute(
          selection,
          account.id,
          driver,
          target.projectPath
        )
      }
      if (!target.projectId) return null
      const { driver, projectPath } = await this.host.resolve(
        target.projectId,
        selection.harnessId,
        target.threadId,
        account.id
      )
      return this.host.units['runtime-agents'].buildAuxiliaryRoute(
        selection,
        account.id,
        driver,
        projectPath
      )
    } catch (error) {
      Logger.dev('Auxiliary agent assignment could not be resolved; keeping the local fallback', {
        threadHarnessId: target.threadHarnessId,
        auxiliaryHarnessId: selection.harnessId,
        auxiliaryProviderId: selection.providerId,
        auxiliaryModelId: selection.modelId,
        error: rawErrorMessage(error)
      })
      return null
    }
  }

  /**
   * Tell the app that this process's set of running threads may have changed.
   *
   * A sibling instance has no harness for these turns and receives none of their
   * stream, so the only way a window there can label one of them precisely is if
   * this process says so. The shared `active_turns` ledger stays the truth: this
   * is the invalidation that makes a sibling re-read it. Change-guarded, because
   * one turn emits several lifecycle transitions and a sibling pays for every
   * announcement with a read of that ledger.
   */
  announceTurnActivityChange(): void {
    const running = new Set<string>()
    for (const [sessionId, status] of this.host.sessionStatuses) {
      if (status.state !== 'working') continue
      const session = this.host.sessionRegistry.get(sessionId)
      // A temporary (side) chat is this process's own: it has no thread row and
      // no sibling can open or resume it, so announcing its parent thread as
      // running would claim work that exists nowhere else.
      if (!session || session.ephemeral) continue
      running.add(`${session.projectId}:${session.threadId}`)
    }
    const signature = [...running].sort().join(',')
    if (signature === this.host.state.localRunSignature) return
    this.host.state.localRunSignature = signature
    instanceRegistry.publishTurnActivity()
  }

  /**
   * The process running a turn on any thread of the workflow, or `null` when the
   * whole group is idle. This is the "driving right now" signal, independent of
   * the durable ownership row.
   */
  async workflowActiveTurnOwner(
    projectId: string,
    coordinatorThreadId: string,
    threads?: Thread[]
  ): Promise<number | null> {
    for (const member of await this.host.units['runtime-workflows'].workflowGroup(
      projectId,
      coordinatorThreadId,
      threads
    )) {
      const owner = await this.host.checkpointManager.activeTurnOwnerPid(projectId, member.id)
      if (owner !== null) return owner
    }
    return null
  }

  // ─── Driver resolution ────────────────────────────────────────────────────

  /** Resolve a driver and the working directory for a project- or thread-scoped operation. */
  async resolve(
    projectId: string,
    driverId: string,
    threadId?: string,
    accountId?: string
  ): Promise<{ driver: HarnessDriver; projectPath: string }> {
    const projectPath = threadId
      ? await this.host.resolveThreadPath(projectId, threadId)
      : await this.resolveProjectPath(projectId)
    const driver = await this.host.driverForAccount(driverId, accountId)
    this.trackProjectResourcePath(projectId, projectPath)

    // Installation/version probes belong to the explicit Settings harness check.
    // Thread operations call the driver directly so a transient probe cannot
    // block history, prompts, commands, or other live session traffic.
    return { driver, projectPath }
  }

  /**
   * The directory a thread's teardown runs against.
   *
   * Deleting a thread is cleanup, not execution, so it never fails closed. The
   * scope resolver stays the authority for every turn, file surface, and Git
   * operation, but a thread whose managed checkout is unhealthy (or whose board
   * entry disappears between reads) must still be deletable. Refusing here
   * leaves a conversation the user cannot remove and an eviction candidate that
   * is re-picked on every create without ever making room. The persisted
   * compatibility directory is exactly the path this thread's harness session
   * was opened with, and the two teardown calls that use it, abort and session
   * removal, are already best-effort.
   */
  async resolveTeardownPath(thread: Thread): Promise<string> {
    try {
      return await this.host.resolveThreadPath(thread.projectId, thread.id)
    } catch (error) {
      // The fallback is expected behavior for an unhealthy checkout, so it logs
      // one concise dev line with the reason instead of a failure-looking stack.
      Logger.dev('Thread teardown fell back to the persisted directory', {
        threadId: thread.id,
        scopeBucketId: thread.scopeBucketId,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
    const persisted = thread.workingDirectory.trim()
    const projectPath = await this.resolveProjectPath(thread.projectId)
    if (!persisted) return projectPath
    return isAbsolute(persisted) ? resolve(persisted) : resolve(projectPath, persisted)
  }

  async resolveProjectPath(projectId: string): Promise<string> {
    const project = await this.host.state.projectManager.getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)

    let projectPath = project.path
    // A hidden inbox project has no folder of its own. Its project-level work
    // (quota reads, grading judges, heartbeats) shares this neutral root, while
    // each chat thread resolves to `chats-cwd/<threadId>/` through
    // `resolveThreadPath` so conversations never share a directory.
    if (!projectPath && project.hidden && project.id === INBOX_PROJECT_ID) {
      await this.host.storage.ensureDirectory(CHATS_CWD_DIR)
      projectPath = this.host.storage.resolve(CHATS_CWD_DIR)
    }
    // The assistant space is hidden too, and its tasks are conversations rather
    // than files in a project. Its root is a neutral app-storage directory so a
    // session never runs against a real project folder.
    if (!projectPath && project.hidden && project.id === ASSISTANT_SPACE_ID) {
      await this.host.storage.ensureDirectory(ASSISTANT_CWD_DIR)
      projectPath = this.host.storage.resolve(ASSISTANT_CWD_DIR)
    }
    // The global browser is hidden too, and its tabs are web pages rather than
    // files: the container's own root is a neutral app-storage directory, and
    // each tab's agent session narrows it to `browser-cwd/<threadId>` through
    // `resolveThreadPath` so a conversation never runs against a real project
    // folder.
    if (!projectPath && project.hidden && project.id === GLOBAL_BROWSER_PROJECT_ID) {
      await this.host.storage.ensureDirectory(BROWSER_CWD_DIR)
      projectPath = this.host.storage.resolve(BROWSER_CWD_DIR)
    }
    if (!projectPath) throw new Error(`Project has no working directory: ${projectId}`)
    return projectPath
  }

  /**
   * Neutral working directory for auxiliary disposable sessions (grading
   * judges and quota reads) so they never depend on where a conversation
   * lived: the project row may be gone long before its snapshots are.
   */
  async auxiliaryWorkingDirectory(): Promise<string> {
    try {
      return await this.resolveProjectPath(INBOX_PROJECT_ID)
    } catch {
      await this.host.storage.ensureDirectory(CHATS_CWD_DIR)
      return this.host.storage.resolve(CHATS_CWD_DIR)
    }
  }

  /**
   * Whether the user has interacted with the app recently enough to be
   * considered "active". When the user is active, pending questions will not
   * auto-answer   the countdown is paused until they become inactive.
   *
   * This is app-wide activity, not attention to any one card: the pause holds
   * while the user works anywhere in the app, and is released only once they
   * stop. The card then gets a fresh window of its own, so an abandoned request
   * still closes without a countdown ever running under an active user.
   */
  isUserActive(): boolean {
    return (
      Date.now() - this.host.state.lastUserActivityAt < ChatEngine.USER_ACTIVITY_GRACE_PERIOD_MS
    )
  }

  /** Process an event from a driver: apply permission policy, then broadcast. */
  handleDriverEvent(driverId: string, event: AgentEvent, sourceDriver?: HarnessDriver): void {
    // A driver finished enriching its catalog in the background (e.g. Cline's
    // remote list). Re-merge every project we already exposed a catalog for and
    // push the fresher result so open pickers update without re-opening.
    if (event.type === 'catalog.updated') {
      void this.host.units['providers-catalog'].rebroadcastUpdatedCatalogs()
      return
    }
    // `providerCatalog.updated` is a chat-engine broadcast, never a driver event.
    if (event.type === 'providerCatalog.updated') return
    // A transport swap deferred because a turn owned the harness converges the
    // moment that harness goes idle, so a settled install probe is honored
    // without waiting for the next turn or an app restart.
    if (
      driverId === 'opencode' &&
      this.host.state.openCodeHarnessSwapPending &&
      (event.type === 'session.idle' ||
        (event.type === 'session.status' && event.status.state === 'idle'))
    ) {
      this.host.refreshOpenCodeHarness()
    }
    // A tool call carries the friendly action it performed, snapshotted here, at
    // ingest, so every reader downstream (the live trace, the durable stream
    // log, the transcript mirror) shows one label instead of re-deriving it from
    // a harness's own tool name. A thread recorded before the field existed has
    // no label and keeps rendering its title or tool name, which costs nothing.
    if (event.type === 'message.part.updated' && event.part.type === 'tool') {
      event.part = toolActionLabelForPart(event.part)
    }
    // Any live harness activity means the session's project is doing work
    // keep its idle-server clock reset until the stream goes quiet.
    const eventOwner = this.host.sessionRegistry.get(event.sessionId)
    if (eventOwner) {
      this.host.state.projectIdleSince.delete(eventOwner.projectId)
      this.host.state.releasedProjects.delete(eventOwner.projectId)
      // Live traffic is the only proof of life the silence watchdog has, and its
      // timer is armed once from the session's `working` status. Without this
      // reset the watchdog fires a fixed window later   even while the harness
      // streams parts, tool calls and questions   and a probe that answers for
      // the wrong process then kills a turn that was demonstrably alive.
      // Lifecycle signals are excluded: they arm or clear the watchdog themselves.
      if (
        event.type !== 'session.status' &&
        event.type !== 'session.idle' &&
        event.type !== 'session.error'
      ) {
        this.host.units['turns-sessions'].resetSessionWatchdog(event.sessionId)
      }
      this.host.units['brainstorm'].forwardBrainstormTrace(eventOwner, event)
      this.host.units['spec'].forwardInitialSpecTrace(eventOwner, event)
      this.host.units['assignment'].forwardAssignmentDraftTrace(eventOwner, event)
    }
    if (eventOwner && (event.type === 'message.completed' || event.type === 'usage.updated')) {
      const selection = this.host.state.sessionModelIds.get(event.sessionId)
      // Attribute the event to the session's own harness and provider. A live
      // streamed assistant row is built from part events, which carry no
      // provenance, so without this stamp the row stays unattributed until the
      // turn lands in the persisted mirror. The context meter only counts usage
      // reported by the thread's current harness and provider, so an
      // unattributed row is invisible to it for the whole run.
      event.harnessId ??= driverId
      // What one reported count covers, declared by the owning driver. A count
      // that spans a turn or the whole harness session must never be divided by
      // one message's generation window, so consumers need to know its scope.
      event.tokenUsageScope ??=
        this.host.units['turns-dispatch'].driverForRuntime(driverId, eventOwner.accountId)
          ?.capabilities.tokenUsageScope ?? 'message'
      if (selection) event.providerId ??= selection.providerId
      if (event.contextWindow === undefined && selection) {
        const contextWindow = this.host.units['transcripts'].modelContextWindow(
          eventOwner.projectId,
          selection.providerId,
          selection.modelId
        )
        if (contextWindow !== undefined) event.contextWindow = contextWindow
      }
      if (
        (event.type === 'message.completed' || event.type === 'usage.updated') &&
        (event.tokens?.total ?? 0) > 0
      ) {
        eventOwner.hasReportedTokenUsage = true
      }
      if (
        event.type === 'message.completed' &&
        !event.compaction &&
        event.contextUsed === undefined &&
        event.error === undefined &&
        eventOwner.hasReportedTokenUsage !== true &&
        eventOwner.estimatedContextUsed !== undefined
      ) {
        // Some drivers declare `contextUsage: true` yet carry providers that
        // report no token usage at all (e.g. OpenCode gateways like Console
        // Go). Only for those sessions is the composed request estimate from
        // dispatch the only signal available   flagged as estimated so
        // consumers never mistake it for reported. Sessions whose provider
        // does report usage (pi mirrors per-turn token totals) never get the
        // text-layer estimate: it measures the composed send, not the
        // harness transcript, and would report a fraction of the real
        // occupancy. Failed turns are skipped too   a rejected request says
        // nothing about occupancy and must not clobber the last reading.
        event.contextUsed = eventOwner.estimatedContextUsed
        event.contextEstimated = true
      }
    }
    const streamedMessageId =
      event.type === 'message.part.updated'
        ? event.part.messageID
        : event.type === 'message.part.delta'
          ? event.messageId
          : undefined
    if (
      streamedMessageId &&
      this.host.state.outboundMessageIdsBySession.get(event.sessionId)?.has(streamedMessageId)
    ) {
      return
    }
    // Delta events can be the first signal of generated output (some drivers
    // stream text purely as deltas, and pi streams tool-call arguments this
    // way). Count the streamed characters as generation progress: a request
    // that emits only a tool call would otherwise show no window at all.
    if (event.type === 'message.part.delta' && streamedMessageId) {
      this.host.state.generationClock.noteDelta(
        GenerationClock.key(event.sessionId, streamedMessageId),
        Date.now(),
        event.partId,
        event.delta.length
      )
    }
    // A harness that reports accounting before its turn closes (opencode's
    // per-step totals) teaches the clock the same way the renderer already
    // learns it, so the two processes keep one view of the message.
    if (event.type === 'usage.updated' && generatedTokens(event.tokens) > 0) {
      this.host.state.generationClock.noteReported(
        GenerationClock.key(event.sessionId, event.messageId),
        generatedTokens(event.tokens),
        Date.now(),
        event.tokenUsageScope ?? 'message'
      )
    }
    if (
      eventOwner &&
      !eventOwner.ephemeral &&
      event.type === 'message.part.updated' &&
      event.part.type === 'compaction' &&
      event.part.summary?.trim()
    ) {
      // Make completed summaries available to database-only forks immediately,
      // including compactions that finish after the outer turn has settled.
      void this.host.threadManager
        .upsertMessages(eventOwner.projectId, eventOwner.threadId, [
          {
            id: event.part.messageID,
            role: 'assistant',
            origin: 'compaction',
            visibility: 'working_trace',
            createdAt: Date.now(),
            parts: [event.part]
          }
        ])
        .catch((error) => Logger.error('Compaction summary persistence failed:', error))
    }
    void this.host.units['messages-write'].recordDriverEvent(driverId, event)
    // Durably persist the working-trace part stream to the thread's SSE log so a
    // mid-turn/restart reopen can rehydrate the full trace (tools, reasoning,
    // sub-agents) even if the harness session is no longer reachable. Ephemeral
    // isolated workers are excluded   they are forwarded as spec/brainstorm
    // traces through their own paths.
    if (
      eventOwner &&
      !eventOwner.ephemeral &&
      (event.type === 'message.part.updated' || event.type === 'message.part.delta')
    ) {
      void this.host
        .persistTurnStreamEvent(eventOwner, event)
        .catch((error) => Logger.dev('Turn stream write failed:', error))
    }
    const coordinatorSpecSession = eventOwner
      ? this.host.state.activeInitialSpecSessions.get(
          this.host.units['spec'].initialSpecKey(eventOwner.projectId, eventOwner.threadId)
        )
      : undefined
    const coordinatorIdleSignal =
      event.type === 'session.idle' ||
      (event.type === 'session.status' && event.status.state === 'idle')
    if (
      eventOwner &&
      !eventOwner.ephemeral &&
      coordinatorIdleSignal &&
      coordinatorSpecSession?.threadSessionId === event.sessionId &&
      !this.host.state.userAbortedInitialSpecOperations.has(
        this.host.units['spec'].initialSpecKey(eventOwner.projectId, eventOwner.threadId)
      )
    ) {
      const status: AgentSessionStatus = {
        state: 'working',
        startedAt: coordinatorSpecSession.startedAt,
        activity: {
          kind: 'spec_generation',
          label: `Formulating specification · attempt ${coordinatorSpecSession.attempt}/${SPEC_GENERATION_MAX_ATTEMPTS}`,
          attempt: coordinatorSpecSession.attempt,
          maxAttempts: SPEC_GENERATION_MAX_ATTEMPTS,
          updatedAt: Date.now()
        }
      }
      this.host.sessionStatuses.set(event.sessionId, status)
      void this.host.threadManager
        .setStatus(eventOwner.projectId, eventOwner.threadId, 'planning')
        .catch((error) => Logger.error('Specification coordinator status repair failed:', error))
      this.host.broadcast({ type: 'session.status', sessionId: event.sessionId, status })
      return
    }
    const stoppedSessionEvent =
      this.host.state.userAbortedSessions.has(event.sessionId) ||
      this.host.state.stoppedAssignmentSessions.has(event.sessionId)
    const stoppedSessionTerminalEvent =
      event.type === 'session.idle' ||
      event.type === 'session.error' ||
      (event.type === 'session.status' && event.status.state === 'idle') ||
      // A delegated worker's terminal card patch must still land on a stopped
      // thread, or the card it closes   and the trace row that mirrors it
      // keeps spinning after the stop that produced it.
      isTerminalSubagentPatch(event)
    if (stoppedSessionEvent && !stoppedSessionTerminalEvent) return
    // A settle is only the turn's end when the driver has released the turn. A
    // driver that still registers the turn is going to resume it: pi's page
    // checkpoint aborts the run, compacts and re-prompts it inside the same
    // logical turn, and codex holds its turn across the retry gaps. Honoring
    // this idle ended the turn mid-flight, tearing down the turn's utility
    // gateway (handoff clear + cleanup) while the resumed run was still calling
    // `cio_util_*`. Nothing downstream may see it: not the status map, the
    // watchdog, the retry scheduler, the completion waiters, or the renderers.
    // The driver's own terminal idle arrives after it clears the registration,
    // so ignoring this one costs nothing, and the watchdog still recovers a
    // registration a driver never releases (it probes the live harness and
    // fails the session when the process is gone).
    const idleEvent = isIdleSignalEvent(event)
    if (idleEvent && this.driverHoldsTurn(event.sessionId, driverId, sourceDriver)) {
      Logger.dev('Ignored an idle from a driver that still holds the turn:', {
        sessionId: event.sessionId,
        driverId
      })
      return
    }
    this.host.units['runtime-connectivity'].updateCompletionWaiter(event)
    this.host.units['assignment-workers'].observeChildSession(driverId, event)

    if (event.type === 'session.status') {
      // A terminal status carrying a usage/rate-limit reset is the unified
      // will-retry wait, not an error. Some harnesses (pi's `agent_settled`)
      // report the exhausted usage window through `session.status` instead of
      // `session.error`, and that path never reached the provider-failure
      // pipeline   the card counted down but no scheduler record existed, so
      // nothing resumed at zero and the thread sat on an error status.
      if (
        event.status.state === 'error' &&
        eventOwner &&
        !eventOwner.ephemeral &&
        !this.host.state.userAbortedSessions.has(event.sessionId) &&
        (isUsageResetWaitIssue(event.status.issue) || event.status.issue.kind === 'network')
      ) {
        this.host.units['runtime-connectivity'].enterRetryWait(
          event.sessionId,
          event.status.issue,
          event.status.issue.message
        )
        return
      }
      const currentStatus = this.host.sessionStatuses.get(event.sessionId)
      if (
        event.status.state === 'idle' &&
        this.host.units['turns-dispatch'].isAutomaticRetryWaitActive(event.sessionId)
      )
        return
      if (event.status.state !== 'idle' || currentStatus?.state !== 'error') {
        this.host.sessionStatuses.set(event.sessionId, event.status)
      }
      if (
        event.status.state === 'waiting' &&
        eventOwner &&
        !eventOwner.ephemeral &&
        (event.status.issue.retryable || isUsageResetWaitIssue(event.status.issue))
      ) {
        const retryAt = event.status.issue.retryAt
        const hasFiniteRetryAt = typeof retryAt === 'number' && Number.isFinite(retryAt)
        if (hasFiniteRetryAt) {
          updateRetryWakeWindow(event.sessionId, retryAt)
        } else {
          updateRetryWakeWindow(event.sessionId, null)
        }
        // Ethos: usage-limit expiry must surface as Waiting to retry, not Working.
        // Persist working-paused for every retryable waiting signal, even when
        // retryAt is missing or beyond the 6h wake window, or when the harness
        // owns its own retry   the persisted pause makes the stopped state visible.
        void this.host.threadManager
          .setStatus(eventOwner.projectId, eventOwner.threadId, 'working-paused', { read: false })
          .catch((error) => Logger.error('Retry-paused status update failed:', error))
        // Record the wait in the retry scheduler for every harness   including
        // harnesses that schedule their own retry (OpenCode). Their native
        // resume emits `working` and clears the record; the recorded wait keeps
        // the thread retryable after an app restart.
        void this.host.units['runtime-connectivity']
          .scheduleAutomaticRetry(event.sessionId, event.status.issue)
          .catch((error) => Logger.dev('Retry scheduling failed for waiting session:', error))
      }
      if (event.status.state === 'working' || event.status.state === 'idle') {
        updateRetryWakeWindow(event.sessionId, null)
      }
      if (
        event.status.state === 'waiting' ||
        event.status.state === 'idle' ||
        event.status.state === 'error'
      ) {
        this.host.units['turns-sessions'].clearSessionWatchdog(event.sessionId)
      } else if (event.status.state === 'working') {
        this.host.handledIdleSessions.delete(event.sessionId)
        this.host.units['lifecycle'].startSessionWatchdog(event.sessionId)
      }
      // A working or idle session resolved its reset   drop any pending
      // auto-resume record for it (a re-reported error re-tracks it).
      if (event.status.state === 'working' || event.status.state === 'idle') {
        this.host.state.retryScheduler?.clear(event.sessionId)
        this.host.state.retryScheduler?.resumed(event.sessionId)
      }
    } else {
      if (
        (event.type === 'message.part.updated' || event.type === 'message.part.delta') &&
        !isTerminalSubagentPatch(event)
      ) {
        this.host.handledIdleSessions.delete(event.sessionId)
      }
    }

    // A `message.completed` that arrives after the session's idle was already
    // handled belongs to work outside the finished turn (e.g. a Codex
    // collaboration sub-agent reporting late). It must not resurrect the
    // settled thread back to `executing`: markSessionWorking would flip the
    // status without arming any watchdog, leaving the thread stuck forever.
    // A genuinely new turn re-arms through its own part events or an
    // authoritative `session.status working` before any such completion.
    const idleAlreadyHandled =
      event.type === 'message.completed' && this.host.handledIdleSessions.has(event.sessionId)
    const confirmsActiveWork =
      !idleAlreadyHandled &&
      ((event.type === 'message.part.updated' && !isTerminalSubagentPatch(event)) ||
        event.type === 'message.part.delta' ||
        (event.type === 'message.completed' && !event.error) ||
        (event.type === 'session.status' && event.status.state === 'working'))
    if (eventOwner && confirmsActiveWork)
      this.host.units['turns-sessions'].markSessionWorking(event.sessionId)

    // Stamp thinking start time on reasoning parts that lack it.
    // Stamp tool start/end times on tool parts as their state transitions.
    // Count streamed output characters as generation progress, so a driver that
    // publishes part snapshots instead of deltas still gets a real window.
    if (event.type === 'message.part.updated') {
      const part = event.part
      if (part.type === 'reasoning' || part.type === 'text') {
        this.host.state.generationClock.noteSnapshot(
          GenerationClock.key(event.sessionId, part.messageID),
          Date.now(),
          part.id,
          part.text.length + (part.type === 'reasoning' ? (part.summary?.length ?? 0) : 0)
        )
      }
      if (part.type === 'reasoning' && !part.time?.start) {
        const now = Date.now()
        part.time = { ...part.time, start: now }
        let perSession = this.host.state.reasoningTimes.get(event.sessionId)
        if (!perSession) {
          perSession = new Map()
          this.host.state.reasoningTimes.set(event.sessionId, perSession)
        }
        perSession.set(part.id, { start: now })
      }
      if (part.type === 'tool') {
        const childOwner = this.host.state.childSessionOwners.get(event.sessionId)
        const session =
          this.host.sessionRegistry.get(event.sessionId) ??
          (childOwner
            ? [...this.host.sessionRegistry.values()].find(
                (candidate) =>
                  candidate.activeTurnId &&
                  candidate.projectId === childOwner.projectId &&
                  candidate.threadId === childOwner.threadId
              )
            : undefined)
        if (session && !session.activeTurnId) {
          // A harness can settle a turn while the model is still working (e.g.
          // pi reported a usage-reset settle that proved premature), which
          // finalizes the checkpoint before the last edits landed. A later
          // file-mutating tool claim then arrives with no active turn
          // re-open the just-completed checkpoint so the late work is captured
          // in the same turn's card instead of vanishing.
          const latePaths = changedPathsFromTool(session.projectPath, part)
          const unboundedLate = UNBOUNDED_MUTATING_TOOLS.has(normalizedToolName(part.tool))
          if (latePaths.length > 0 || unboundedLate) {
            const owner = session
            void this.reopenSettledTurnForLateClaim(owner, latePaths, unboundedLate).then(() => {
              if (owner.activeTurnId)
                this.host.units['utilities-tools'].recordToolChangeSources(owner, part)
            })
          }
        }
        if (session?.activeTurnId) {
          // Every tool can hide a write, including code-mode wrappers. Filesystem
          // evidence must not depend on recognizing its name or command syntax.
          session.unboundedToolObserved = true
          this.host.units['utilities-tools'].trackUnboundedToolWindow(session, part)
          const precisePaths = this.host.units['utilities-tools'].recordToolChangeSources(
            session,
            part
          )
          if (precisePaths.length > 0) {
            session.changedPaths ??= new Set()
            session.preciseChangedPaths ??= new Map()
            const claimedAt = Date.now()
            for (const path of precisePaths) {
              // A path the user saved through the in-app editor during this
              // turn is the user's edit   the agent must not claim it even
              // when a tool event names the same file.
              if (session.userTouchedPaths?.has(path)) continue
              session.changedPaths.add(path)
              if (!UNBOUNDED_MUTATING_TOOLS.has(normalizedToolName(part.tool))) {
                session.preciseChangedPaths.set(path, claimedAt)
              }
            }
            // Scanner: at end of each file-related tool call, validate the
            // claimed paths actually changed vs the turn's before snapshot. This
            // keeps live tracking accurate and prevents a fork from keeping a
            // file it only touched but didn't change.
            if (part.state.status === 'completed' || part.state.status === 'error') {
              void this.host.units['utilities-tools']
                .scanLivePathsAfterTool(session)
                .catch((error) => Logger.dev('live scan after tool failed:', error))
            }
          }
        }
        let perSession = this.host.state.toolTimes.get(event.sessionId)
        if (!perSession) {
          perSession = new Map()
          this.host.state.toolTimes.set(event.sessionId, perSession)
        }
        const existing = perSession.get(part.id)
        const now = Date.now()
        if (part.state.status === 'running' || part.state.status === 'pending') {
          if (!existing) {
            perSession.set(part.id, { start: now })
            if (!part.state.time?.start) {
              part.state.time = { ...part.state.time, start: now }
            }
          }
        } else if (part.state.status === 'completed' || part.state.status === 'error') {
          const start = existing?.start ?? part.state.time?.start ?? now
          const end = now
          perSession.set(part.id, { start, end })
          part.state.time = { start, end }
          // Steer-undo window: the last in-flight tool of the turn just ended,
          // so any held steer can now reach the harness. A tool that just
          // completed may belong to a sub-agent's child session rather than
          // the thread's own session   resolve to the root before checking.
          const rootSteerSessionId = this.host.units['turns-steer'].rootSessionIdForSteer(
            event.sessionId
          )
          if (
            this.host.state.heldSteers.has(rootSteerSessionId) &&
            !this.host.units['utilities-tools'].hasInFlightTool(rootSteerSessionId)
          ) {
            void this.host.units['turns-steer'].flushHeldSteers(rootSteerSessionId, 'mid-turn')
          }
        }
        if (part.state.status === 'error') {
          void this.host.units['utilities-tools']
            .nudgeUnavailableToolCall(driverId, event.sessionId, part)
            .catch((error) => Logger.dev('Unavailable-tool search nudge failed:', error))
        }
      }
    }

    // Stamp thinking and tool end times for the message when it completes.
    if (event.type === 'message.completed' || event.type === 'session.idle') {
      const now = Date.now()
      const sessionTimes = this.host.state.reasoningTimes.get(event.sessionId)
      if (sessionTimes) {
        for (const entry of sessionTimes) {
          if (!entry[1].end) entry[1].end = now
        }
      }
      const sessionToolTimes = this.host.state.toolTimes.get(event.sessionId)
      if (sessionToolTimes) {
        for (const entry of sessionToolTimes) {
          if (!entry[1].end) entry[1].end = now
        }
      }
      // Close the generation window at this request boundary and record what
      // the harness reported, so a message that spans several requests sums the
      // generation time of all of them instead of only the first.
      if (event.type === 'message.completed') {
        const clockKey = GenerationClock.key(event.sessionId, event.messageId)
        if ((event.tokens?.output ?? 0) > 0) {
          this.host.state.generationClock.noteReported(
            clockKey,
            generatedTokens(event.tokens),
            now,
            event.tokenUsageScope ?? 'message'
          )
        }
        this.host.state.generationClock.completeRequest(clockKey, now)
      } else {
        this.host.state.generationClock.settleSession(event.sessionId, now)
      }
    }

    // Permission events go through the policy filter before reaching the UI.
    if (event.type === 'permission.asked') {
      void this.host.units['permissions']
        .handlePermissionAsked(driverId, event, sourceDriver)
        .catch((error) => Logger.error('Permission request registration failed:', error))
      return
    }
    if (event.type === 'permission.replied') {
      const pending = this.host.state.pendingPermissions.get(event.requestId)
      if (pending) {
        this.host.state.pendingPermissions.delete(event.requestId)
        // An ephemeral side chat has no thread status to restore; only a real
        // thread turn resumes through this path.
        if (!pending.session.ephemeral) {
          void this.host.threadManager
            .setStatus(pending.session.projectId, pending.session.threadId, pending.resumeStatus)
            .catch((error) => Logger.error('Permission resolution status update failed:', error))
        }
      }
    }
    if (event.type === 'question.asked') {
      void this.host.units['questions-ask']
        .handleQuestionAsked(driverId, event)
        .catch((error) => Logger.error('Question request registration failed:', error))
      return
    }
    if (event.type === 'question.resolved') {
      this.host.units['questions'].finalizePendingQuestion(
        event.requestId,
        event.resolution,
        event.answers
      )
      return
    }

    // Terminal events trigger state transitions.
    if (idleEvent) {
      const currentStatus = this.host.sessionStatuses.get(event.sessionId)
      // A usage-limit reset wait is not really idle: keep the waiting card and
      // suppress this trailing idle broadcast so the card survives until the
      // auto-resume (or native harness retry) drives the session again.
      const resetWaitIdle =
        currentStatus?.state === 'waiting' &&
        (isUsageResetWaitIssue(currentStatus.issue) || currentStatus.issue.kind === 'network')
      if (currentStatus?.state !== 'error' && !resetWaitIdle) {
        this.host.sessionStatuses.set(event.sessionId, { state: 'idle' })
      }
      // The turn just ended. Drivers that report idle through the dedicated
      // `session.idle` event (claude-code among them) never pass through the
      // `session.status` branch above, so the turn watchdog armed at the
      // `working` status must be cleared here. Without this.host, the watchdog
      // fires minutes after a successful turn and misreports the finished
      // session as "went idle without completing the turn".
      this.host.units['turns-sessions'].clearSessionWatchdog(event.sessionId)
      this.host.units['turns-sessions'].handleSessionIdleSignal(event.sessionId)
      if (resetWaitIdle) return
      if (eventOwner) {
        void this.host.units['runtime-connectivity']
          .detectTextualUsageLimitWait(driverId, event.sessionId, eventOwner)
          .catch((error) => Logger.dev('Textual usage-limit detection failed:', error))
      }
    }
    if (event.type === 'session.error') {
      // A deliberate user stop must never surface as a session error.
      if (!this.host.state.userAbortedSessions.has(event.sessionId)) {
        const issue: AgentProviderIssue =
          event.issue ??
          this.host.units['providers-accounts'].fallbackProviderIssue(
            driverId,
            event.error ?? 'Agent session failed',
            event.rawError
          )
        if (isUsageResetWaitIssue(issue) || issue.kind === 'network') {
          // Unified contract: a usage/rate-limit reset is a scheduled wait, not
          // a failure. Re-surface the reset-wait as a `waiting` card and let
          // the scheduler resume the thread once the reset passes.
          this.host.units['runtime-connectivity'].enterRetryWait(
            event.sessionId,
            issue,
            event.error
          )
          return
        }
        // A scheduled usage-reset wait must survive its own teardown noise.
        // Harnesses that emit a structured limit outcome (will-retry card
        // above) can still exit non-zero afterwards, and that trailing generic
        // "process exited" failure classifies as unknown. It arrived AFTER the
        // wait was entered, so honoring it here would flip the visible
        // will-retry card into a red error badge milliseconds later.
        //
        // A transient connection wait has no schedule behind it, so the same
        // trailing failure must NOT be swallowed when it classifies to a real
        // provider verdict (sign-in required, billing). Otherwise an expired
        // credential left the thread parked on a connection card that offered
        // no way to reauthenticate, while the actionable 401 was discarded.
        if (
          this.host.units['turns-dispatch'].isAutomaticRetryWaitActive(event.sessionId) &&
          !event.issue
        ) {
          const activeWait = this.host.sessionStatuses.get(event.sessionId)
          const activeIssue = activeWait?.state === 'waiting' ? activeWait.issue : undefined
          const teardownKind = classifyProviderIssue(event.error ?? '')
          if (isUsageResetWaitIssue(activeIssue) || teardownKind === 'unknown') {
            Logger.dev(
              'Ignored provider teardown failure trailing an active usage-reset wait:',
              event.error
            )
            return
          }
        }
        this.host.sessionStatuses.set(event.sessionId, { state: 'error', issue })
        updateRetryWakeWindow(event.sessionId, null)
        this.host.units['turns-sessions'].clearSessionWatchdog(event.sessionId)
        this.host.units['questions'].clearPendingQuestionsForSession(event.sessionId)
        this.host.units['permissions'].clearPendingPermissionsForSession(event.sessionId)
        void this.host.handleProviderFailure(event.sessionId, issue, event.error)
      }
    }
    if (event.type === 'message.completed' && event.error) {
      // Compaction is best-effort maintenance: a failed compaction must never
      // mark the whole session as errored. The conversation is intact, it just
      // wasn't compacted   leave the session healthy so the user can retry.
      if (event.compaction) {
        Logger.dev('compaction message errored (session stays healthy):', event.error)
      } else if (!this.host.state.userAbortedSessions.has(event.sessionId)) {
        const issue: AgentProviderIssue =
          event.issue ??
          this.host.units['providers-accounts'].fallbackProviderIssue(
            driverId,
            event.error,
            event.rawError
          )
        if (isUsageResetWaitIssue(issue) || issue.kind === 'network') {
          // The failed message still broadcasts below; the provider card is
          // replaced by the unified waiting state instead of an error.
          this.host.units['runtime-connectivity'].enterRetryWait(
            event.sessionId,
            issue,
            event.error
          )
        } else {
          this.host.sessionStatuses.set(event.sessionId, { state: 'error', issue })
          updateRetryWakeWindow(event.sessionId, null)
          this.host.units['turns-sessions'].clearSessionWatchdog(event.sessionId)
          void this.host.handleProviderFailure(event.sessionId, issue, event.error)
        }
      }
    }
    // Everything else broadcasts directly to renderers.
    this.host.broadcast(event)
  }

  /** Late tool claims (see the reopen call site) attach to the just-settled
   *  turn: re-open its recently completed checkpoint and seed the session's
   *  change tracking with the recorded paths plus the new claims, so the next
   *  idle finalization re-completes the same checkpoint with the full diff.
   *  Serialized per session via `pendingReopen` so interleaved late claims
   *  cannot race two reopens of the same row. */
  reopenSettledTurnForLateClaim(
    session: SessionInfo,
    claimedPaths: readonly string[],
    unboundedClaim = false
  ): Promise<void> {
    const run = async (): Promise<void> => {
      if (session.activeTurnId) return
      const checkpoint = await this.host.checkpointManager
        .reopenTurn(session.projectId, session.threadId, LATE_CLAIM_REOPEN_WINDOW_MS)
        .catch((error: unknown) => {
          Logger.dev('late-claim checkpoint reopen failed:', error)
          return null
        })
      if (!checkpoint || session.activeTurnId) return
      session.activeTurnId = checkpoint.id
      session.activeTurnUserMessageId = checkpoint.sourceMessageId
      session.changedPaths = new Set(checkpoint.changes.map((change) => change.path))
      session.preciseChangedPaths = new Map()
      session.changeSources = new Map(
        Object.entries(checkpoint.changeSourceRefs ?? {}).map(([path, references]) => [
          path,
          references.flatMap((reference) => {
            const source = checkpoint.toolSources?.[reference.toolPartId]
            return source
              ? [{ ...source, verification: reference.verification, window: reference.window }]
              : []
          })
        ])
      )
      session.openUnboundedTools = undefined
      session.unboundedWindowToolIds = undefined
      session.unboundedToolObserved = unboundedClaim
      session.unboundedWindowStart = undefined
      session.pendingWindowScans = undefined
      const claimedAt = Date.now()
      for (const path of claimedPaths) {
        if (session.userTouchedPaths?.has(path)) continue
        session.changedPaths.add(path)
        if (!unboundedClaim) session.preciseChangedPaths.set(path, claimedAt)
      }
    }
    const pending = (session.pendingReopen ?? Promise.resolve())
      .then(run)
      .catch((error: unknown) => {
        Logger.dev('late-claim turn reopen failed:', error)
      })
    session.pendingReopen = pending
    void pending.finally(() => {
      if (session.pendingReopen === pending) session.pendingReopen = undefined
    })
    return pending
  }

  /**
   * The completed turns of the run in flight, folded out of the durable log.
   *
   * The boundaries come from the mirror: consecutive real prompts with no
   * assistant row between them are a turn the transcript never mirrored. Anything
   * further back than the first such pair is left alone, because the provider's
   * own transcript already carries it.
   *
   * The log is read once for the whole span and folded once, then split by each
   * entry's last activity, which is the same boundary rule the newest turn's
   * fold uses: work that kept streaming after the steer belongs to the turn the
   * steer opened.
   */
  async completedTurnFolds(projectId: string, threadId: string): Promise<CompletedTurnFold[]> {
    const boundaries = await this.completedTurnBoundaries(projectId, threadId)
    const streamPath = turnStreamPath(projectId, threadId)
    const entry = this.host.units['turns-stream'].turnStreamEntry(streamPath)
    // What the log must keep: the whole run while a closed turn is unmirrored,
    // and only the newest turn once the transcript carries the rest. A narrowed
    // range re-opens the fold so the trimmed entries cannot linger in memory.
    const retainFromTs = boundaries.length > 0 ? boundaries[0].startTs : null
    if (entry.retainFromTs !== retainFromTs) {
      entry.retainFromTs = retainFromTs
      entry.foldKey = null
      entry.folded = null
    }
    if (boundaries.length === 0) return []
    const oldest = boundaries[0].startTs
    const newest = boundaries[boundaries.length - 1].endTs
    const key = `${oldest}:${newest}:${boundaries.length}`
    if (entry.completedKey === key && entry.completed) return entry.completed

    const size = await this.host.storage.rawSize(streamPath)
    if (size === null || size === 0) return []
    const hydrated = await this.host.units['thread-lifecycle'].readTurnStreamOffThread(
      streamPath,
      0,
      size,
      oldest,
      newest
    )
    if (hydrated.events.length === 0) return []
    const folded = foldTurnStreamDetailed(hydrated.events, undefined, oldest)
    if (folded.parts.length === 0) return []

    const turns: CompletedTurnFold[] = boundaries.map((boundary) => ({
      startTs: boundary.startTs,
      endTs: boundary.endTs,
      parts: []
    }))
    for (const part of folded.parts) {
      const touched = folded.lastActivityTs.get(part.id) ?? 0
      const index = boundaries.findLastIndex((boundary) => boundary.startTs <= touched)
      if (index < 0) continue
      turns[index].parts.push(part)
    }
    const kept = turns.filter((turn) => turn.parts.length > 0)
    entry.completedKey = key
    entry.completed = kept
    return kept
  }

  /**
   * The real prompts of the newest run that no assistant row separates, as the
   * spans between them: `[startTs, endTs)` per completed turn, oldest first.
   *
   * Walks the newest prompts backwards and stops at the first pair the transcript
   * already mirrors, so a settled thread resolves to nothing and costs no log
   * read at all.
   */
  async completedTurnBoundaries(
    projectId: string,
    threadId: string
  ): Promise<Array<{ startTs: number; endTs: number }>> {
    const page = await this.host.threadManager.loadMessagePage(projectId, threadId, undefined, 120)
    const messages = page.messages
    const heldSteerIds = this.host.units['messages'].heldSteerMessageIds(threadId)
    const prompts: Array<{ index: number; ts: number }> = []
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      if (!message || message.role !== 'user') continue
      if (!isTurnBoundaryPrompt(message)) continue
      if (heldSteerIds.has(message.id)) continue
      if (!message.createdAt) continue
      prompts.push({ index, ts: message.createdAt })
    }
    if (prompts.length < 2) return []
    const boundaries: Array<{ startTs: number; endTs: number }> = []
    for (let i = prompts.length - 1; i >= 1; i--) {
      const start = prompts[i - 1]
      const end = prompts[i]
      const mirrored = messages
        .slice(start.index + 1, end.index)
        .some(
          (message) =>
            message?.role === 'assistant' &&
            (message.visibility === undefined || message.visibility === 'conversation')
        )
      if (mirrored) break
      boundaries.push({ startTs: start.ts, endTs: end.ts })
    }
    return boundaries.reverse()
  }

  /**
   * The request a continuation turn has to carry on the app's own initiative
   * (the retry chip, an automatic resume after a provider reset, a recovered
   * thread), plus the prompt that relays it.
   *
   * The request the failed turn was answering travels with the nudge. A bare
   * "Continue" was trusting the harness session to still hold that request, and
   * nothing guarantees it: a provider pause that leaves the turn held, an
   * account or harness change, or a released session all leave the agent with a
   * "Continue" and no request to continue, which reads to the user as their
   * message being silently dropped. The request's files ride along as send-path
   * attachments, so a relayed screenshot reaches the agent too.
   */
  async continuationTurnRequest(
    projectId: string,
    threadId: string,
    nudge: string
  ): Promise<PendingContinuationRequest> {
    try {
      const page = await this.host.threadManager.loadMessagePage(
        projectId,
        threadId,
        undefined,
        CONTINUATION_REQUEST_PAGE_MESSAGES
      )
      const request = pendingContinuationRequest(page.messages)
      return request
        ? { ...request, text: continuationRequestPrompt(request, nudge) }
        : { text: nudge, attachments: [] }
    } catch (error) {
      // A continuation must still run when the mirror read fails: the harness
      // session usually holds the request itself.
      Logger.dev('Continuation request relay skipped:', {
        projectId,
        threadId,
        error: rawErrorMessage(error)
      })
      return { text: nudge, attachments: [] }
    }
  }

  /**
   * Window covering the graded harness's own grading route: the candidates its
   * driver discovered, plus the graded model the one-shot runner appends as the
   * settings fallback. An unknown route reports null, because a route reported
   * closed without knowing it would postpone work that can run.
   */
  nativeRouteWindowUntil(row: RankingQueueHead, native: HarnessDriver | null): number | null {
    const route = native?.auxiliaryRouteCandidates?.() ?? null
    if (!route || !native) return null
    return this.windowUntil(native, [
      ...route,
      { providerId: row.provider_id, modelId: row.model_id }
    ])
  }

  /**
   * Ask one driver about one route, treating a driver that throws as a driver
   * that knows nothing: the contract says an unknown route must keep callers
   * judging, and a planning pass must never fail the drain.
   */
  windowUntil(
    driver: HarnessDriver,
    candidates: readonly AuxiliaryModelCandidate[]
  ): number | null {
    if (!driver.auxiliaryWindowUntil) return null
    try {
      return driver.auxiliaryWindowUntil(candidates)
    } catch (error) {
      Logger.dev('Auxiliary window check failed; judging normally:', rawErrorMessage(error))
      return null
    }
  }

  /**
   * Whether the emitting driver still declares a live turn for this session.
   *
   * The turn lifecycle belongs to the driver: it registers a turn when it
   * dispatches one and clears it only when nothing can resume it. An idle that
   * arrives before that clearance is an intermediate settle, not the turn's end,
   * and the engine must not finalize on it. Mirrors the watchdog, which only
   * synthesizes a missing idle when the driver has NO registered turn, so both
   * sides of the contract ask the same question.
   */
  driverHoldsTurn(sessionId: string, driverId: string, sourceDriver?: HarnessDriver): boolean {
    const driver =
      sourceDriver ??
      this.host.units['turns-dispatch'].driverForRuntime(
        driverId,
        this.host.sessionRegistry.get(sessionId)?.accountId
      )
    if (!driver?.hasActiveTurn) return false
    try {
      return driver.hasActiveTurn(sessionId)
    } catch (error) {
      Logger.dev('Driver active-turn probe failed:', error)
      return false
    }
  }
}
