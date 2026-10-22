/**
 * Post-paint service graph.
 *
 * Construct and register the optional services only after the primary window
 * has painted. Dynamic imports keep the heavy modules (PTY, harness services,
 * provider connection, notifications, ...) out of the module-evaluation path so
 * first paint is never blocked by their construction.
 * Hydration IPC (config/project/bounded-thread/scope reads plus `app:*`) is
 * registered before navigation, in the bootstrap. Feature IPC, chat, provider
 * catalog, file preview, and optional services are registered here after first
 * paint, in the exact order the bootstrap established.
 */

import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createThreadWorkspaceRoots } from '../editor/project-files/thread-workspace-roots'
import { appResourcesRoot, isShippedBuild } from './app-resources'
import { assistantPrimaryModel, settingsWithAssistantModel } from '../../lib/assistant-agents'
import { settingsWithAssistantTarget } from '../../lib/assistant-execution'
import { findBrowserSearchEngine } from '../../lib/browser-search-engines'
import { prototypeCdnPolicyFromConfig } from '../../lib/prototypes/prototype-cdn'
import { loadProjectWorkRoots } from '../design/work-roots-state'
import { assistantRunTitle, assistantRunPrompt } from '../../lib/assistant-run'
import type { ThreadClickedPayload } from '../../lib/ipc-contract'
import type { Database } from '../database/database'
import { StorageEngine } from '../storage/storage-engine'
import { CheckpointManager } from '../storage/checkpoint-manager'
import { Logger } from '../system/logger'
import { resolveAutoAnswerScope } from '../system/auto-answer-scope'
import {
  broadcastThreadAuthoredWorkUpdated,
  broadcastThreadUpdate,
  publishThreadMessagesChanged,
  subscribeThreadCorpus,
  setBackgroundTray,
  setNotificationService,
  setPowerWakeService
} from '../chat/thread-events'
import { setTranscriptChangeListener } from '../../lib/engines/thread-manager-transcripts'
import { instanceEventBus } from '../system/instance-event-bus'
import type { ThreadCreationCoordinator } from '../chat/thread-creation-coordinator'
import type { ThreadDeletionCoordinator } from '../chat/thread-deletion-coordinator'
import { ModelPricingService } from '../providers/model-pricing-service'
import { getActiveThreadProjects } from '../database/active-thread-report'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { ProjectRepo } from '../database/repositories/project-repo'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { startupTelemetry } from '../system/startup-telemetry'
import { BrowserService } from '../browser/browser-service'
import { BrowserDownloadManager } from '../browser/browser-service/browser-downloads'
import type { DesignService } from '../design/design-service'
import { SearchService } from '../search/search-service'
import { registerSearchSettingsIpc } from '../ipc/search-settings-ipc'
import { getLlamaServerBinary } from '../speech/backends/llama-backend'
import { sharedLlamaRuntimeService } from '../speech/llama-runtime-service'
import type { BootstrapState } from './bootstrap-state'

/**
 * Every durable transcript write announces its thread to sibling instances.
 *
 * Wired at module evaluation, not inside the post-paint boot: recovery resumes
 * turns before the service graph is up, and a message written then has to be
 * announced like any other. Two instances share the mirror, and neither receives
 * the other's writes, so this announcement is the only way a sibling window
 * learns to re-read a thread it is showing.
 */
setTranscriptChangeListener(publishThreadMessagesChanged)

/** Boot-scoped collaborators a per-window browser attach needs. */
interface BrowserAttachContext {
  state: BootstrapState
  storage: StorageEngine
  database: Database
  designService: DesignService
}

/**
 * Create (or recreate) the window-bound browser service and wire its two
 * collaborators. Called once for the first window and again for every window
 * opened after the previous one was destroyed, so parking to the menu bar and
 * reopening rebuilds exactly the same browser wiring instead of leaving a stale
 * service pointing at a dead window.
 */
async function attachBrowserService(
  context: BrowserAttachContext,
  window: BrowserWindow
): Promise<void> {
  const { state, storage, database, designService } = context
  const chatEngine = state.chatEngine
  if (!chatEngine) return
  if (state.browserService) {
    // The previous window's tabs are about to lose their views, so their stacks
    // are committed first. This await is what makes the write survive: `dispose()`
    // closes the views and nothing would be left to read a stack from afterwards.
    await state.browserService.flushTabHistory()
    state.browserService.dispose()
    state.browserService = null
  }
  // The download manager is deliberately *not* created per window. Downloads
  // belong to their project's session and keep running while no window shows
  // them, so the first attach builds it, hydrates the records an earlier run
  // left behind, and every later window reuses the same one.
  if (!state.browserDownloads) {
    state.browserDownloads = new BrowserDownloadManager({
      persistence: storage,
      window: () => (state.mainWindow?.isDestroyed() ? null : state.mainWindow)
    })
  }
  await state.browserDownloads.hydrate()
  const service = new BrowserService(window, database, storage, state.browserDownloads)
  state.browserService = service
  // Remembered permission decisions load before the service accepts browser
  // IPC, so a site is never re-prompted for a permission the user already
  // granted in this or an earlier run.
  await service.hydratePermissionMemory()
  // The stored Back/Forward stacks load before the service accepts browser IPC.
  // A tab can be shown on the very first frame the renderer is allowed to ask,
  // and a tab restored from a hibernated row has to find its history already
  // there: there is no second chance to restore it once it has loaded.
  await service.hydrateTabHistory()
  service.register()
  // The browser's native context menu is built in main, so it needs the address
  // bar's search engine. The config is read once at attach; the renderer pushes
  // later changes.
  void storage
    .getConfig()
    .then((config) =>
      service.setSearchEngine(
        findBrowserSearchEngine(config.browserSearchEngine, config.browserCustomSearchEngines)
      )
    )
    .catch(() => {})
  service.setAgentActionApprover((request) => chatEngine.requestBrowserActionApproval(request))
  chatEngine.setBrowserUtilityExecutor((operation, input, browserContext) =>
    service.executeUtility(operation, input, browserContext)
  )
  service.setTabMarkRecogniser((projectId, threadId, url) =>
    designService.observeShownFolder(projectId, threadId, url)
  )
}

/**
 * Attach every window-bound service to a newly created window.
 *
 * The core service graph boots once, headlessly if necessary, and the pieces
 * that need a window (the PTY sender, the browser, the `app:featuresReady`
 * signal) are attached here for each window. Running this on every window
 * creation is what makes reopen work: the previous window's renderer is gone,
 * so none of these can be inherited.
 */
export async function attachWindowServices(
  state: BootstrapState,
  window: BrowserWindow
): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  if (!state.chatEngine) return
  state.ptyService?.attach(window.webContents)
  await state.attachBrowserToWindow?.(window)
  if (state.featuresReady) {
    sendToRenderer(window.webContents, 'app:featuresReady')
  }
}
import { reconcileInterruptedWork, watchForInstanceTakeOver } from './interrupted-work-recovery'

declare const __CODEINOVEN_PROTOTYPE_PREVIEW_ORIGIN__: string | undefined

export interface PostPaintBootContext {
  state: BootstrapState
  storage: StorageEngine
  database: Database
  isProduction: boolean
  threadCreation: ThreadCreationCoordinator
  threadDeletion: ThreadDeletionCoordinator
  onThreadClicked: (payload: ThreadClickedPayload) => void
  /** Called once the feature graph is live so the bootstrap can re-check readiness. */
  onFeaturesReady: () => void
}

export async function bootPostPaintServices(context: PostPaintBootContext): Promise<void> {
  const { state, storage, database } = context
  if (state.chatEngine || state.featuresReady) return
  // This independent prerequisite must not hold the feature graph, a first
  // message, or terminal creation behind a download/extraction promise.
  if (process.platform === 'win32')
    void import('../drivers/windows-git-runtime')
      .then(({ startWindowsGitPreparation }) => startWindowsGitPreparation())
      .catch((error: unknown) => Logger.error('Windows Git startup preparation failed', error))
  const [
    { registerIpcHandlers },
    { ProjectManager },
    { ProjectFilesService },
    { ChatEngine },
    { ScopeManager },
    { ScopeRootResolver, scopeRootProvider },
    { ScopeWorktreeService },
    { HarnessManifestService },
    { ComputerUsePipService },
    { PowerWakeService },
    { RetrySchedulerService },
    { HeartbeatSchedulerService },
    { SpeechService },
    { registerSpeechIpc },
    { PrototypePreviewService },
    { DirectoryPreviewService },
    { ForeignRunService },
    { CrossInstanceThreadService },
    { ThreadTransferService },
    { ThreadTransferLock },
    { AssistantManager },
    { AssistantSchedulerService },
    {
      broadcastMissedRunsChanged,
      broadcastAutoAnswersChanged,
      broadcastBackgroundRunsChanged,
      broadcastSkippedRunsChanged
    },
    { SkillUpdateService },
    { SecretVault },
    { GitHubAuthService },
    { CioCleanupService },
    { broadcastCioCleanupProgress, broadcastCioCleanupState }
  ] = await Promise.all([
    import('../ipc/ipc-handlers'),
    import('../../lib/engines/project-manager'),
    import('../editor/project-files-service'),
    import('../chat/chat-engine'),
    import('../../lib/engines/scope-manager'),
    import('../workspaces/scope-root-resolver'),
    import('../git/scope-worktree-service'),
    import('../agents/harness-manifest-service'),
    import('../utilities/computer-use-pip-service'),
    import('../system/power-wake-service'),
    import('../system/retry-scheduler-service'),
    import('../system/heartbeat-scheduler-service'),
    import('../speech/speech-service'),
    import('../ipc/speech-ipc'),
    import('../prototypes/prototype-preview-service'),
    import('../preview/directory-preview-service'),
    import('../chat/foreign-run-service'),
    import('../chat/cross-instance-thread-service'),
    import('../chat/thread-transfer-service'),
    import('../system/thread-transfer-lock'),
    import('../../lib/engines/assistant-manager'),
    import('../scheduler/assistant-scheduler-service'),
    import('../scheduler/assistant-events'),
    import('../utilities/skill-updates'),
    import('../storage/secret-vault'),
    import('../git/github-auth-service'),
    import('../cio-cleanup/cio-cleanup-service'),
    import('../cio-cleanup/cio-cleanup-events')
  ])

  const projectManager = new ProjectManager(database)
  const scopeManager = new ScopeManager(database)
  const scopeWorktreeService = new ScopeWorktreeService(scopeManager, projectManager)
  const scopeRootResolver = new ScopeRootResolver(
    projectManager,
    scopeManager,
    scopeWorktreeService
  )
  const projectFilesService = new ProjectFilesService(
    projectManager,
    scopeRootProvider(scopeRootResolver),
    // Chat file trees mount on the thread's own `chats-cwd/<threadId>`
    // directory and assistant file trees on the task's
    // `assistant-cwd/<assistantId ?? threadId>` workspace; both are created on
    // demand so an empty conversation still has a browsable root.
    createThreadWorkspaceRoots(storage, database)
  )
  state.appfileProjectFiles = projectFilesService
  // CIO Cleanup resolves the same roots the app boots a session in, and reports
  // into the app-root dock exactly like the other background jobs do.
  state.cioCleanup = new CioCleanupService({
    database,
    storage,
    boards: scopeManager,
    scopeRoots: {
      resolve: async (target) => {
        const resolution = await scopeRootResolver.resolve(target)
        return resolution.ok ? { ok: true, root: resolution.root } : { ok: false }
      }
    },
    hasActiveProcesses: (projectId, scopeBucketId) =>
      state.chatEngine?.hasActiveProcessesInScope(projectId, scopeBucketId) ??
      Promise.resolve(false),
    onProgress: broadcastCioCleanupProgress,
    onStateChanged: broadcastCioCleanupState,
    onSweepComplete: () => state.designService?.reconcileHistory() ?? Promise.resolve()
  })
  state.computerUsePipService = new ComputerUsePipService(storage)
  state.harnessManifestService = new HarnessManifestService(storage)
  state.modelPricingService = new ModelPricingService(storage)
  // The OpenCode install decides which transport a turn speaks, so it is
  // warmed before the chat engine builds its driver map: the probe starts here
  // (not awaited) and the driver is swapped to the detected transport when it
  // settles, so a V2-only machine never runs a turn on the V1 transport.
  // Bounded and non-fatal: a missing binary just leaves the canonical default.
  const { warmOpenCodeInstallation } = await import('../agents/opencode-installation')
  // The install decides which OpenCode transport a turn speaks, not what the
  // workspace shows, so the probe is started here but not awaited: it runs
  // behind the visible window, and the refresh below swaps the already-built
  // driver when it settles instead of holding `features:ready` on the child
  // processes.
  const openCodeInstallationReady = warmOpenCodeInstallation().catch((error) => {
    Logger.dev('opencode install detection failed (non-fatal):', error)
    return null
  })
  state.chatEngine = new ChatEngine(
    storage,
    database,
    state.computerUsePipService,
    state.harnessManifestService,
    context.threadCreation,
    join(app.getPath('userData'), 'owned-processes.json'),
    scopeRootProvider(scopeRootResolver),
    state.modelPricingService
  )
  // Grade any ranking snapshots whose persisted close deadline elapsed while
  // the app was closed (non-fatal: a failed sweep leaves rows queued for the
  // next launch).
  void state.chatEngine
    .recoverPendingRankingGrades()
    .catch((error) => Logger.dev('Pending ranking grade recovery failed (non-fatal):', error))
  // Swap the OpenCode driver to the detected transport the moment the probe
  // settles: the map was built against the cached install, which is still
  // empty on the first launch of a session. This is the same swap the runtime
  // install/upgrade path uses, and it defers itself while a turn is active.
  void openCodeInstallationReady.then(() => state.chatEngine?.refreshOpenCodeHarness())
  // Merge the app-managed lean opencode agents into the machine-wide global
  // config. Idempotent, additive-only and non-fatal.
  const { startStartupUpdater } = await import('./startup-updater')
  await startStartupUpdater(state, storage).catch((error: unknown) =>
    Logger.error('Updater initialization failed; optional services continue', error)
  )
  // One vault and one GitHub auth for the whole app: the skill updater reads the
  // same token the IPC layer does, so a check is authenticated exactly like an
  // install instead of running against the anonymous rate limit.
  const vault = new SecretVault(storage)
  const githubAuthService = new GitHubAuthService(vault)
  const resolveProjectRoot = async (projectId: string): Promise<string> => {
    const project = await projectManager.getProject(projectId)
    if (!project?.path) throw new Error(`Project not found: ${projectId}`)
    return project.path
  }
  // A scoped utility is not only a registry entry: the app installs it into the
  // project's own `.cio/utilities`, or into the thread's folder under the config
  // root. One service owns those folders, because the IPC writes, the
  // marketplace installs and the sweep that removes a thread all have to agree
  // on where a scoped capability lives.
  const { UtilityScopeFootprintService } = await import('../utilities/utility-scope-footprint')
  const utilityFootprint = new UtilityScopeFootprintService(storage, {
    resolveProjectPath: async (projectId) => {
      const project = await projectManager.getProject(projectId).catch(() => null)
      return project?.path ?? null
    },
    listProjectPaths: async () =>
      // Read on the database worker: an install pass runs on a user's write and
      // over the background reconcile, and neither may hold the main thread on a
      // SQLite read.
      (await new ProjectRepo(database).listViaWorker())
        .filter((project) => project.source !== 'ssh' && project.path)
        .map((project) => ({ id: project.id, path: project.path }))
  })
  // Installed skills ride the app-update check cycle: the same startup,
  // six-hourly and explicit check that looks for a new build also keeps the
  // marketplace skills CodeInOven placed up to date, in small batches.
  const skillUpdateService = new SkillUpdateService({
    install: {
      storage,
      home: app.getPath('home'),
      resolveProjectPath: resolveProjectRoot,
      githubToken: () => githubAuthService.resolveToken(),
      // A managed copy the updater rewrites is a scoped install too, so a
      // project-scoped one refreshes the file the project shows.
      footprint: utilityFootprint
    },
    listProjectIds: async () => (await projectManager.listProjects()).map((project) => project.id)
  })
  state.skillUpdateService = skillUpdateService
  state.updaterService?.setCheckCycleHook((explicit) =>
    skillUpdateService.scheduleCheck({ explicit })
  )
  state.powerWakeService = new PowerWakeService(storage, database)
  state.retryScheduler = new RetrySchedulerService(storage)
  // Verified device connectivity. Built before the IPC handlers, because the
  // renderer's connection events are routed into it, and before the retry
  // scheduler starts, so a wait restored from disk is gated on a verdict
  // rather than on the operating system's guess.
  const { ConnectivityService } = await import('../system/connectivity-service')
  state.connectivity = new ConnectivityService()
  state.heartbeatScheduler = new HeartbeatSchedulerService(storage)
  state.chatEngine.attachHeartbeatScheduler(state.heartbeatScheduler)
  state.assistantManager = new AssistantManager(database)
  const assistantManager = state.assistantManager
  // Durable evidence of unattended runs, loaded before the scheduler can
  // dispatch so a run that fails at 3am is never invisible on the next launch.
  const { BackgroundRunLedger } = await import('../scheduler/background-run-ledger')
  state.backgroundRunLedger = new BackgroundRunLedger(storage)
  await state.backgroundRunLedger.load()
  // Durable record of gates the app resolved without the user. Written the
  // instant one settles, so the attention rail can explain what was asked,
  // offered and chosen even after a restart.
  const { AutoAnswerStore } = await import('../system/auto-answer-store')
  state.autoAnswerStore = new AutoAnswerStore(storage)
  await state.autoAnswerStore.load()
  // Proof a previous process shut down on purpose, so an orphaned turn is
  // settled as a clean app-closed stop rather than a crash failure. Loaded
  // before launch recovery reads it.
  const { CleanShutdownStore } = await import('../system/clean-shutdown-store')
  state.cleanShutdownStore = new CleanShutdownStore(storage)
  await state.cleanShutdownStore.load()
  state.chatEngine.attachAutoAnswerRecorder((report) => {
    const store = state.autoAnswerStore
    if (!store) return
    store.record({
      id: report.id,
      kind: report.kind,
      outcome: report.outcome,
      projectId: report.projectId,
      threadId: report.threadId,
      // File the gate under the task and assistant it actually concerns, so the
      // decision keeps surfacing after this run thread is evicted.
      ...resolveAutoAnswerScope(database, report.projectId, report.threadId),
      entries: report.entries,
      at: report.at
    })
    broadcastAutoAnswersChanged(store.list())
    state.backgroundLifecycle?.refreshTrayState()
  })
  state.assistantScheduler = new AssistantSchedulerService(storage, {
    assistants: assistantManager,
    backgroundLedger: state.backgroundRunLedger,
    // A run that failed while nobody was watching becomes unread, so its
    // persisted message reaches the badge and the panel on the next open and the
    // menu bar icon can say something needs attention.
    onRunFailed: (runThreadId) => {
      try {
        new ThreadRepo(database).markUnread(runThreadId)
        state.backgroundLifecycle?.refreshTrayState()
      } catch (error) {
        Logger.error('Could not flag a failed run as unread:', error)
      }
    },
    onTaskChanged: (task) => broadcastThreadUpdate(task),
    // Every run executes on a fresh thread: a scheduled fire and a manual
    // "Run now" both create one, so a run never lands in the task's own
    // conversation. Only an assistant's Getting started thread hosts authoring.
    createRunThread: (task, assistant) => {
      const chatEngine = state.chatEngine
      if (!chatEngine) throw new Error('The chat engine is not available')
      // A scheduled run needs a bound model; a task that was never configured
      // is skipped rather than fired with guessed settings.
      if (!task.settings) throw new Error('This task has no model configured yet.')
      // The assistant's primary model wins over whatever the thread was last set
      // to, so the models the user picked for the assistant are the models its
      // runs actually use. An assistant without a model set keeps the thread's own.
      const primary = assistantPrimaryModel(assistant?.agents)
      // The assistant's execution target is the default for every run it
      // dispatches; a task that already picked an Oven of its own keeps it.
      const targeted = settingsWithAssistantTarget(task.settings, assistant?.execution)
      const runSettings = primary ? settingsWithAssistantModel(targeted, primary) : targeted
      return chatEngine.createAssistantRunThread({
        task,
        settings: runSettings,
        title: assistantRunTitle(Date.now())
      })
    },
    dispatch: (run, task, assistant) => {
      const chatEngine = state.chatEngine
      if (!chatEngine) {
        Logger.dev('Scheduled assistant run skipped   no chat engine', { threadId: task.id })
        return
      }
      const prompt = assistantRunPrompt(task, assistant?.name)
      const runSettings = run.settings ?? task.settings
      if (!runSettings) {
        Logger.error('Assistant run has no bound settings', { taskId: task.id, runId: run.id })
        return
      }
      // The assistant's knowledge is NOT passed as prompt context: the engine composes
      // it into the run's system prompt from the assistant itself
      // (`assistantKnowledgeInstruction`), which the run thread carries through its
      // inherited `assistantId`, so it is restated every turn instead of being
      // appended to this message and kept in the harness transcript.
      return chatEngine.sendPrompt(
        run.projectId,
        run.id,
        runSettings,
        prompt,
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'internal',
        undefined,
        undefined,
        true
      )
    }
  })
  state.assistantScheduler.attachChangeListener(() => {
    broadcastMissedRunsChanged(state.assistantScheduler?.listMissedRuns() ?? [])
    broadcastBackgroundRunsChanged(state.assistantScheduler?.listBackgroundRuns() ?? [])
    broadcastSkippedRunsChanged(state.assistantScheduler?.listSkippedRuns() ?? [])
    state.backgroundLifecycle?.refreshTrayState()
  })
  // Background wake: the machine is held awake inside the lead window before a
  // due scheduled run, capped so a mis-scheduled task cannot pin it. The next
  // due moment is read lazily from the scheduler, so a change is never cached.
  state.powerWakeService.attachScheduledRunSource(
    () => state.assistantScheduler?.nextDueAt(Date.now()) ?? null
  )
  try {
    const backgroundConfig = await storage.getConfig()
    state.powerWakeService.setBackgroundPolicy({
      // The lifecycle is the authority: it also knows whether this launch opted
      // out of background work, which no config value can express.
      enabled:
        state.backgroundLifecycle?.backgroundEnabled ?? backgroundConfig.backgroundMode !== 'off',
      wakeLeadMs: state.backgroundLifecycle?.wakeLeadMs ?? backgroundConfig.backgroundWakeLeadMs,
      maxHoldMs: backgroundConfig.maxBackgroundWakeHoldMs
    })
  } catch (error) {
    Logger.error('Background wake policy could not be applied', error)
  }
  // Scheduled assistant runs fall over to the assistant's next model when the
  // current one fails, instead of waiting out the failed provider's reset.
  state.chatEngine.attachAssistantAgentsResolver((task) =>
    state.assistantManager?.resolveTaskAgents(task)
  )
  // A settled turn on an assistant task is reported to the assistant scheduler,
  // which knows whether it dispatched a run on that task and stamps the last
  // successful run once the run's turn actually completes.
  state.chatEngine.attachAssistantRunSettledRecorder((threadId, status) => {
    state.assistantScheduler?.settleRun(threadId, status)
    // A settled run's outcome now belongs in the "While you were away" list.
    broadcastBackgroundRunsChanged(state.assistantScheduler?.listBackgroundRuns() ?? [])
  })
  // Speech is an optional capability, and its resources are the first bundled
  // assets a misresolved resources root breaks. A failure here must degrade
  // dictation only: throwing past this point would abort the rest of the graph,
  // leaving every feature channel (file reads included) unregistered.
  const speechResourcesRoot = appResourcesRoot()
  const speechIsPackaged = isShippedBuild()
  const speechWorkerPath = (worker: string): string =>
    speechIsPackaged
      ? join(speechResourcesRoot, 'speech', worker)
      : join(speechResourcesRoot, 'speech/runtime/darwin-arm64', worker)
  try {
    const speechService = new SpeechService(
      {
        catalogPath: join(speechResourcesRoot, 'speech/model-catalog.json'),
        mlxWorkerPath: speechWorkerPath('mlx-worker'),
        coremlWorkerPath: speechWorkerPath('coreml-worker'),
        nativeCaptureWorkerPath: speechWorkerPath('speech-capture-worker')
      },
      undefined,
      (input) => state.chatEngine!.cleanupSpeechTranscript(input),
      (input) => state.chatEngine!.transcribeSpeechAudio(input),
      (input) => state.chatEngine!.learnSpeechLessons(input),
      (pid, command, cwd) =>
        state.chatEngine!.trackPtyProcess(undefined, undefined, undefined, pid, command, cwd)
    )
    await speechService.initialize()
    state.speechService = speechService
    state.unregisterSpeechIpc = registerSpeechIpc(
      speechService,
      () => state.mainWindow?.webContents ?? null
    )
  } catch (error) {
    state.speechService = null
    Logger.error('Speech services unavailable; dictation stays disabled', error)
  }
  // Initialize auto-evict timers from persisted sound settings
  try {
    const cfg = await storage.getConfig()
    state.speechService?.updateUnloadOptions({
      asr: cfg.sound.asrUnload,
      cleanup: cfg.sound.cleanupUnload,
      tts: cfg.sound.ttsUnload
    })
  } catch {
    // defaults already applied
  }
  // Intent search shares the one local llama.cpp runtime with speech, so both
  // draw from the same discovered/downloaded binary and the same process journal.
  state.searchService = new SearchService(database, {
    subscribeCorpus: subscribeThreadCorpus,
    summarizeThread: (input) => state.chatEngine!.summarizeSearchThread(input),
    llamaServerPath: () => getLlamaServerBinary(),
    runtimeBuild: () => sharedLlamaRuntimeService().selectedBuild(),
    registerProcess: (pid, command, cwd) =>
      sharedLlamaRuntimeService().registerServerProcess(pid, command, cwd),
    unregisterProcess: (pid) => sharedLlamaRuntimeService().unregisterServerProcess(pid)
  })
  // A runtime that will not start disables semantic search and nothing else:
  // this used to abort the whole feature boot, which left every feature channel
  // registered only because readiness was announced too early to notice. It is
  // an optional engine, so it degrades like speech does.
  try {
    await state.searchService.initialize()
    state.unregisterSearchIpc = registerSearchSettingsIpc(
      state.searchService,
      () => state.mainWindow?.webContents ?? null
    )
  } catch (error) {
    Logger.error('Semantic search unavailable; intent ranking stays disabled', error)
  }
  state.prototypePreviewService = new PrototypePreviewService()
  try {
    const startupConfig = await storage.getConfig()
    state.prototypePreviewService.setCdnPolicy(prototypeCdnPolicyFromConfig(startupConfig))
  } catch {
    // The strict policy stands until the config can be read.
  }
  await loadProjectWorkRoots(database)
  state.directoryPreviewService = new DirectoryPreviewService()
  state.chatEngine.setPrototypePreviewRegistrar(
    (previewSlug, canonicalRoot) =>
      state.prototypePreviewService?.register(previewSlug, canonicalRoot) ?? Promise.resolve()
  )
  void (async () => {
    const projects = await projectManager.listProjects()
    let registered = 0
    for (const project of projects) {
      if (project.source !== 'local' || !project.path) continue
      registered += (await state.prototypePreviewService?.registerProject(project.path)) ?? 0
    }
    Logger.dev('Prototype preview registrations restored', { registered })
  })().catch((error) => Logger.error('Prototype preview registration recovery failed:', error))
  const { resolvePrototypePreviewOrigin } = await import('../prototypes/prototype-preview-origin')
  const previewOrigin = resolvePrototypePreviewOrigin(process.env, {
    development: !context.isProduction,
    bakedOrigin: __CODEINOVEN_PROTOTYPE_PREVIEW_ORIGIN__
  })
  ipcMain.removeHandler('prototypePreview:getOrigin')
  ipcMain.handle('prototypePreview:getOrigin', async () => {
    if (previewOrigin.origin || previewOrigin.source !== 'missing' || context.isProduction) {
      return previewOrigin.origin
    }
    const service = state.prototypePreviewService
    if (!service) return null
    const port = await service.start()
    return resolvePrototypePreviewOrigin(process.env, {
      development: true,
      bakedOrigin: __CODEINOVEN_PROTOTYPE_PREVIEW_ORIGIN__,
      allocatedPort: port
    }).origin
  })
  // The browser is window-bound: it owns the WebContentsViews the window's stage
  // hosts. It is created by `attachBrowserToWindow` for the current window and
  // again for every window opened after the first one was destroyed, so a
  // reopen after parking gets exactly the same wiring as the first launch.
  // Nothing to do here when there is no window (a headless background launch);
  // the design capability reads it lazily and degrades when it is absent.
  // The design capability's `preview` operation composes the two services above:
  // the loopback static host that serves a folder and the thread's browser tab
  // that shows it. Serving must keep working with no window to host a tab, so the
  // browser is read lazily and a missing one degrades to a URL in the reply.
  //
  // The design service is the durable side of the same thing: it owns what the
  // app knows about a thread's authored work (which folder, and how to get back
  // to it after a restart) and serves the coordinator's open and thumbnail
  // actions. Both capabilities record every preview through it, so the user's
  // design or composition is not lost when the window that showed it closes.
  const { DesignService } = await import('../design/design-service')
  // One announcement, so a saved composition edit and a design restore reach an
  // open history pane the same way.
  const announceHistoryChanged = (projectId: string, directory: string): void => {
    for (const window of BrowserWindow.getAllWindows())
      sendToRenderer(window.webContents, 'design:historyChanged', projectId, directory)
  }
  const designService = new DesignService({
    database,
    onHistoryChanged: announceHistoryChanged,
    onWorkRelocated: (projectId, moves) => {
      for (const window of BrowserWindow.getAllWindows())
        sendToRenderer(window.webContents, 'design:relocated', projectId, moves)
    },
    // The agent can open a design or video session by previewing into a work
    // root with no tag, so the row's authored-work markers have to reach the
    // renderer the same way the tag path's write does, in real time.
    onThreadKindChanged: (projectId, threadId, kind, kinds) =>
      broadcastThreadAuthoredWorkUpdated(projectId, threadId, kind, kinds),
    previews: state.directoryPreviewService,
    browser: () => state.browserService
  })
  state.designService = designService
  designService.registerIpc()
  void designService.reconcileHistory()
  // What each thread decided about the experts its design or video session may
  // delegate to. One service answers it, because the playbook that names the
  // experts and the `delegate` operation that would run one have to agree: a
  // thread the user muted must be neither described as staffed nor allowed to
  // delegate, and two derivations is how those two answers drift apart.
  const { ExpertSettingsService } = await import('../design/expert-settings-service')
  const expertSettings = new ExpertSettingsService({
    database,
    config: () => storage.getConfig(),
    sessionKind: async (_projectId, threadId) => designService.authoredWorkKindFor(threadId)
  })
  expertSettings.registerIpc()
  state.chatEngine.setExpertSettings(expertSettings)
  // A tab is recognised from the page it is showing rather than from a record of who
  // opened it, so a design the agent opened itself and a tab the renderer restored
  // after a restart are designs too, and a tab that navigated away stops being one.
  // The same recognition arms a composition's playback transport, which is why it
  // answers with the folder, its kind and, for a composition, its timeline. The
  // wiring is captured once and applied to every window's browser below.
  state.attachBrowserToWindow = (window) =>
    attachBrowserService({ state, storage, database, designService }, window)
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    await state.attachBrowserToWindow(state.mainWindow)
  }
  const { createDesignPreviewExecutor } = await import('../preview/design-preview-executor')
  state.chatEngine.setDesignPreviewExecutor(
    createDesignPreviewExecutor({
      previews: state.directoryPreviewService,
      database,
      checkpoint: (projectId, threadId, input) =>
        designService.checkpoint(projectId, threadId, input, 'design'),
      browser: () => state.browserService,
      record: (input) => designService.recordPreview(input)
    })
  )
  // Generation services answer with a link and those links expire, so the design
  // capability can bring a generated image, video or sound file into the project
  // as a file the design references by relative path.
  const { createDesignMediaExecutor } = await import('../design/design-media-executor')
  state.chatEngine.setDesignMediaExecutor(createDesignMediaExecutor({ database }))
  // The engine the app was missing: it turns the prompt an agent writes into a
  // picture, a clip or a track, using the model the user assigned to that craft
  // and the provider token the user stored. The bytes land through the same
  // saver above, so generated media has one writer and one set of ceilings.
  const { MediaGenerationService } = await import('../media/media-generation-service')
  const mediaGeneration = new MediaGenerationService({
    config: () => storage.getConfig(),
    vault
  })
  const { createMediaGenerationExecutor } = await import('../media/media-generation-executor')
  state.chatEngine.setMediaGenerationExecutor(
    createMediaGenerationExecutor({
      database,
      config: () => storage.getConfig(),
      service: mediaGeneration,
      // `generate` is one operation on two capabilities, so which folder a file
      // lands in when the caller names none follows the thread's session. The
      // board answers the same question the same way, so the two cannot disagree.
      sessionKind: async (_projectId, threadId) => designService.authoredWorkKindFor(threadId)
    })
  )
  const { registerMediaGenerationIpc } = await import('../media/media-generation-ipc')
  registerMediaGenerationIpc(mediaGeneration)
  // The video capability composes the same two services: the loopback static
  // host that serves a composition folder and the thread's browser tab that
  // shows it. `capture` adds the frame render and the screenshot on top of the
  // same serve-and-show path, so the two operations cannot drift.
  const { createVideoPreviewExecutor } = await import('../video/video-preview-executor')
  const { VideoStudioService } = await import('../video/video-studio-service')
  const videoStudio = new VideoStudioService({
    database,
    previews: state.directoryPreviewService,
    speech: () => state.speechService,
    config: () => storage.getConfig(),
    onChanged: announceHistoryChanged
  })
  videoStudio.registerIpc()
  state.chatEngine.setVideoPreviewExecutor(
    createVideoPreviewExecutor({
      studio: videoStudio.execute,
      previews: state.directoryPreviewService,
      database,
      checkpoint: (projectId, threadId, input) =>
        designService.checkpoint(projectId, threadId, input, 'video'),
      browser: () => state.browserService,
      record: (input) => designService.recordPreview(input)
    })
  )
  const { createVideoCaptureExecutor } = await import('../video/video-capture-executor')
  state.chatEngine.setVideoCaptureExecutor(
    createVideoCaptureExecutor({
      previews: state.directoryPreviewService,
      database,
      browser: () => state.browserService
    })
  )
  // A previewed folder refreshes itself: the preview server reports a batched
  // change for the directory it serves, and the tab showing that origin reloads.
  // The browser is read lazily because it exists only while the app has a window,
  // and a missing one simply means there is no tab to refresh.
  state.directoryPreviewService.setChangeListener(({ url }) =>
    state.browserService?.reloadPreviewOrigin(url)
  )
  // Keep the device awake while a scheduled auto-retry is due within the wake
  // window, so a usage-limit reset fires even when the user is away.
  state.powerWakeService.attachRetryScheduler(state.retryScheduler)
  state.retryScheduler.attachChangeListener(() => {
    state.powerWakeService?.onRetryScheduleChanged()
    // A tracked provider issue (and the retry that clears it) is the durable
    // half of the thread's error card, which the icon mirrors.
    state.backgroundLifecycle?.requestTrayRefresh()
  })
  // The engine counts the working sessions but cannot name them; the shared
  // report is what the close gate lists too, so an install prompt and a quit
  // prompt describe the same work the same way.
  state.updaterService?.setChatEngine(state.chatEngine, () => getActiveThreadProjects(database))
  // Reap any harness processes orphaned by an unclean previous run before the
  // first session can spawn fresh servers, so leftover dev servers/ports are
  // reclaimed without ever touching a harness the user runs outside the app.
  try {
    const reaped = await state.chatEngine.reapOrphanProcesses()
    if (reaped.killed.length > 0 || reaped.skipped.length > 0) {
      Logger.info('Reaped orphaned harness processes from an unclean shutdown', {
        killed: reaped.killed,
        skipped: reaped.skipped
      })
    }
  } catch (error) {
    Logger.error('Orphaned harness process reaping failed at startup:', error)
  }
  registerIpcHandlers(storage, database, state.updaterService ?? undefined, state.chatEngine, {
    searchService: state.searchService ?? undefined,
    projectManager,
    projectFilesService,
    browser: () => state.browserService,
    designService: () => state.designService,
    vault,
    githubAuthService,
    skillUpdates: skillUpdateService,
    directoryPreviewService: state.directoryPreviewService,
    prototypePreviewService: state.prototypePreviewService ?? undefined,
    powerWakeService: state.powerWakeService,
    backgroundLifecycle: state.backgroundLifecycle ?? undefined,
    retryScheduler: state.retryScheduler,
    connectivity: state.connectivity ?? undefined,
    heartbeatScheduler: state.heartbeatScheduler,
    assistantManager: state.assistantManager ?? undefined,
    assistantScheduler: state.assistantScheduler ?? undefined,
    cioCleanup: state.cioCleanup ?? undefined,
    autoAnswerStore: state.autoAnswerStore ?? undefined,
    harnessManifestService: state.harnessManifestService,
    worktreeService: scopeWorktreeService,
    threadCreation: context.threadCreation,
    threadDeletion: context.threadDeletion,
    hydrationHandlersRegistered: true,
    speechService: state.speechService ?? undefined,
    utilityFootprint,
    onScopedPathResolver: (resolve) => {
      state.appfileScopedPathResolver = resolve
    }
  })
  state.chatEngine.register()
  state.harnessManifestService.register()
  state.chatEngine.attachRetryScheduler(state.retryScheduler)
  // A connection wait resumes the moment connectivity is verified back, not
  // when the renderer happens to announce a link. Registering the source here
  // is what turns a reconnection into the batch of resumes the parked threads
  // were promised.
  if (state.connectivity) state.chatEngine.attachConnectivity(state.connectivity)
  // Registered before `featuresReady`: a window hydrates the cross-instance turn
  // notice as soon as it mounts, and its invoke must not race the handler.
  state.foreignRuns = new ForeignRunService(database)
  state.foreignRuns.registerIpc()
  state.foreignRuns.start()
  // The cross-instance stream bus: it serves this process and dials its live
  // peers so a sibling window renders the same run this one renders. It arms its
  // listener only while the registry proves another instance is running.
  instanceEventBus.start()
  // Shared rows and transcripts a sibling writes into: the writer announces the
  // threads it touched, and this instance re-reads and pushes them.
  state.crossInstanceThreads = new CrossInstanceThreadService(database)
  state.crossInstanceThreads.start()
  state.threadTransfer = new ThreadTransferService(state.chatEngine, {
    // One mutex, shared through the config root database, so two instances cannot
    // both claim the same thread's transfer.
    locks: new ThreadTransferLock(database)
  })
  state.threadTransfer.registerIpc()
  state.threadTransfer.start()
  // Custom vendor artwork is read by every `VendorIcon` the first frame mounts,
  // and the renderer only invokes feature channels once `app:featuresReady` has
  // fired. Register it ahead of that signal so the gate is truthful: registering
  // it from the deferred provider block below announced readiness too early and
  // the renderer reported `No handler registered for 'customVendors:listIcons'`.
  {
    const { registerCustomVendorIpc } = await import('../providers/custom-vendor-ipc')
    registerCustomVendorIpc(storage)
  }
  await (async () => {
    const [
      { PtyService },
      { ProviderConnectionService },
      { OpenCodeV2Service },
      { HarnessUpdateService },
      { HarnessInstallService },
      { HarnessAutoUpdateService },
      { NotificationService }
    ] = await Promise.all([
      import('../system/pty-service'),
      import('../providers/provider-connection'),
      import('../opencode-v2/opencode-v2-service'),
      import('../agents/harness-update-service'),
      import('../agents/harness-install-service'),
      import('../agents/harness-auto-update-service'),
      import('../notifications/notification-service')
    ])

    const { ovenTerminalLaunch, ovenShellLaunch } = await import('../ovens/oven-terminal')
    if (state.quitCleanupStarted) throw new Error('Feature startup was cancelled during shutdown')
    state.ptyService = new PtyService(
      storage,
      database,
      scopeRootResolver,
      (process) => {
        state.chatEngine?.trackPtyProcess(
          process.scopeId,
          process.projectId,
          process.threadId,
          process.pid,
          process.command,
          process.cwd
        )
      },
      (projectId, projectPath) => {
        // User typed in a project terminal   open a user-activity window so
        // their shell-driven edits are excluded from concurrent agent turns.
        state.chatEngine?.recordUserTerminalInput(projectId, projectPath)
      },
      ovenTerminalLaunch(storage, vault, database, context.threadCreation),
      ovenShellLaunch(storage, vault)
    )
    // A probe that changes a harness's install state (new install, version
    // bump) invalidates cached provider catalogs so the model picker reflects
    // it, and rebuilds the `opencode` driver when the detected line changed.
    state.providerConnection = new ProviderConnectionService(() => {
      void state.chatEngine?.invalidateProviderCatalogs()
      state.chatEngine?.refreshOpenCodeHarness()
    })
    state.openCodeV2Service = new OpenCodeV2Service()
    state.harnessUpdateService = new HarnessUpdateService(state.providerConnection)
    state.harnessAutoUpdateService = new HarnessAutoUpdateService(storage)
    state.harnessInstallService = new HarnessInstallService(state.providerConnection)
    state.notificationService = new NotificationService(storage, database, context.onThreadClicked)

    // Optional IPC   registered only after the services exist.
    if (state.updaterService) {
      state.updaterService.addActivitySource({
        activeSessionCount: () => state.ptyService?.activeSessionCount() ?? 0,
        describeOtherSessions: () => state.ptyService?.describeSessions() ?? [],
        terminateActiveWork: async () => {
          state.ptyService?.closeAllSessions()
        }
      })
    }
    // A pid the task manager ends can be a terminal's own shell. The PTY
    // service announces that stop so the renderer does not respawn it as a
    // crash, which is the difference between a kill that holds and a shell that
    // is back a moment later.
    state.chatEngine?.setPtyStopAnnouncer(
      (pid) => state.ptyService?.announceStopForPid(pid) ?? false
    )
    state.ptyService.register()
    state.providerConnection.register()
    state.openCodeV2Service.register()
    state.harnessUpdateService.register()
    state.harnessAutoUpdateService.register()
    state.harnessInstallService.register()

    // One TypeSafe (Jev) capability for the whole app. The key is discovered
    // from however the user already configured it (this device's Settings, the
    // launch environment, a utility credential, or a secret set inside a
    // thread), and every caller goes through one service, so an exhausted
    // balance or a revoked key can only ever cost a fallback.
    const [
      { TypesafeDecisionService },
      { TypesafeKeyResolver },
      { TypesafeAuditLog },
      { UtilityRegistryService },
      { AgentSecretService }
    ] = await Promise.all([
      import('../typesafe/typesafe-decision-service'),
      import('../typesafe/typesafe-key-resolver'),
      import('../typesafe/typesafe-audit'),
      import('../utilities/utility-registry-service'),
      import('../utilities/agent-secret-service')
    ])
    const typesafeRegistry = new UtilityRegistryService(storage)
    const typesafe = new TypesafeDecisionService(
      new TypesafeKeyResolver(
        vault,
        typesafeRegistry,
        new AgentSecretService(vault, typesafeRegistry, storage)
      ),
      new TypesafeAuditLog(storage)
    )
    // The same instance the Settings card talks to is the one the engine asks for
    // judgements, so a key stored, cleared or checked there applies to the
    // auxiliary decisions already in flight without anything being restarted.
    state.chatEngine?.attachTypesafeDecisionService(typesafe)

    const { registerProviderAccountIpc } = await import('../ipc/provider-account-ipc')
    const { registerBaseUrlProviderIpc } = await import('../providers/base-url-provider-ipc')
    const { registerUtilityIpc } = await import('../ipc/utility-ipc')
    const { registerTypesafeIpc } = await import('../ipc/typesafe-ipc')
    registerProviderAccountIpc(storage, undefined, (accountId) =>
      state.chatEngine!.removeHarnessAccount(accountId)
    )
    registerBaseUrlProviderIpc(storage)
    registerTypesafeIpc(typesafe)
    registerUtilityIpc(
      storage,
      undefined,
      undefined,
      undefined,
      state.computerUsePipService ?? undefined,
      // A capability the user switches off must stop being callable in the turns
      // that are already running, without the user restarting anything.
      (utilityId) => state.chatEngine?.applyUtilityRegistryChange(utilityId) ?? Promise.resolve(),
      utilityFootprint,
      // The same OAuth service the gateway resolves tokens from, so authorizing
      // a server in Utilities is what a turn then connects with.
      state.chatEngine?.mcpOAuth
    )

    // Wire PTY to the window now that it exists.
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.ptyService.attach(state.mainWindow.webContents)
    }

    if (state.quitCleanupStarted) throw new Error('Feature startup was cancelled during shutdown')
    state.featuresReady = true
    startupTelemetry.mark('features:ready')
    // The lean-agent merge is maintenance, not first interaction: it shells out
    // for the installed version and rewrites the machine-wide opencode config, so
    // it is deferred past `features:ready` instead of holding the feature boot.
    setTimeout(() => {
      void import('../opencode/opencode-agent-service')
        .then(({ syncOpenCodeLeanAgents }) => syncOpenCodeLeanAgents())
        .catch((error) => Logger.dev('opencode lean-agent sync failed (non-fatal):', error))
    }, 0)
    // Every scoped utility gets its install folder back once the app is up, so a
    // registry entry written before this pass existed, or one whose project moved
    // while the app was closed, never stays an entry with nothing on disk.
    void (async () => {
      const { UtilityRegistryService } = await import('../utilities/utility-registry-service')
      await utilityFootprint.reconcile(await new UtilityRegistryService(storage).list())
    })().catch((error) => Logger.dev('Utility install folders could not be reconciled:', error))
    context.onFeaturesReady()
    state.resolveFeaturesReady?.()
    state.resolveFeaturesReady = null
    if (
      state.mainWindow &&
      !state.mainWindow.isDestroyed() &&
      !state.mainWindow.webContents.isDestroyed()
    ) {
      sendToRenderer(state.mainWindow.webContents, 'app:featuresReady')
    }

    try {
      await state.powerWakeService?.start()
      if (state.powerWakeService) setPowerWakeService(state.powerWakeService)
    } catch (error) {
      Logger.error('Power wake startup failed (non-fatal):', error)
    }

    // Every persisted thread update now re-evaluates the menu bar icon, so a
    // thread that breaks while the window is closed flips it and a thread that
    // recovers flips it back   including the figure, which rises and falls with
    // the threads that are actually running.
    if (state.backgroundLifecycle) setBackgroundTray(state.backgroundLifecycle)

    try {
      await state.retryScheduler?.start()
      // Connectivity first, so the scheduler's immediate launch tick already
      // has a verdict: a wait restored from the last session fires as soon as
      // the device is verified online instead of sitting through a probe
      // window it cannot see.
      state.connectivity?.start()
      await state.chatEngine?.repairPendingRetryThreadStatuses()
    } catch (error) {
      Logger.error('Retry scheduler startup failed (non-fatal):', error)
    }

    try {
      await state.heartbeatScheduler?.start()
    } catch (error) {
      Logger.error('Heartbeat scheduler startup failed (non-fatal):', error)
    }

    try {
      await state.assistantScheduler?.start()
      // A slot the app was closed (or asleep) through is dispatched on return
      // when the user allows it, bounded per pass and idempotent across relaunch.
      if (state.backgroundLifecycle?.autoRunMissedRuns) {
        void state.assistantScheduler
          ?.runPendingMisses()
          .catch((error) => Logger.error('Auto-run of missed assistant runs failed:', error))
      }
    } catch (error) {
      Logger.error('Assistant scheduler startup failed (non-fatal):', error)
    }

    try {
      // Daily, silent, and bounded per pass: a stale scratch backlog is reclaimed
      // in the background instead of hammering the disk in one go.
      await state.cioCleanup?.start()
    } catch (error) {
      Logger.error('CIO Cleanup startup failed (non-fatal):', error)
    }

    // A machine that slept through a slot catches up when it wakes or unlocks.
    try {
      if (!state.powerMonitorService) {
        const { PowerMonitorService } = await import('../system/power-monitor-service')
        state.powerMonitorService = new PowerMonitorService({
          onResume: () => {
            // A machine that just woke cannot know what its link does now: the
            // wake is the signal that re-verifies it and, when the device came
            // back connected, resumes every thread parked on the connection.
            state.connectivity?.signal('device wake')
            state.assistantScheduler?.evaluate()
            if (state.backgroundLifecycle?.autoRunMissedRuns) {
              void state.assistantScheduler
                ?.runPendingMisses()
                .catch((error) => Logger.error('Resume catch-up failed:', error))
            }
          }
        })
      }
      state.powerMonitorService.start()
    } catch (error) {
      Logger.error('Power monitor startup failed (non-fatal):', error)
    }

    try {
      state.modelPricingService?.start()
    } catch (error) {
      Logger.error('Model pricing startup failed (non-fatal):', error)
    }

    try {
      // The watcher keeps the same pass available for the moment the last
      // sibling exits, so arm it before the launch pass can fail.
      state.stopInstanceTakeOverListener = watchForInstanceTakeOver(state, database)
      // Settles and resumes work left in flight by a process that stopped, while
      // leaving every turn a sibling instance is still running alone.
      await reconcileInterruptedWork(state, database, 'launch')
    } catch (error) {
      Logger.error('Restart recovery failed (non-fatal):', error)
    }

    // One-time repair of file-change cards whose line counts were recorded as
    // truncated by the previous whole-file gating (large files with small
    // edits showed +0 −0). Bounded, idempotent, and batched; a no-op once every
    // candidate has been repaired.
    try {
      const repaired = await new CheckpointManager(database).repairTruncatedLineStats()
      if (repaired > 0) {
        Logger.info(`Restored line counts for ${repaired} file-change checkpoints`)
      }
    } catch (error) {
      Logger.error('Line-stats repair failed (non-fatal):', error)
    }

    // One-time repair of file-change cards misattributed to hidden internal
    // prompts (search nudges, mermaid repairs, incomplete-turn continuations)
    // by turns that ran before internal attribution existed. Bounded,
    // idempotent, and batched; a no-op once every candidate is repaired.
    try {
      const repaired = await new CheckpointManager(
        database
      ).repairMisattributedInternalCheckpoints()
      if (repaired > 0) {
        Logger.info(`Reattributed ${repaired} internal-turn file-change checkpoints`)
      }
    } catch (error) {
      Logger.error('Internal-attribution repair failed (non-fatal):', error)
    }

    try {
      state.notificationService.start()
      setNotificationService(state.notificationService)
      state.updaterService?.start()
    } catch (error) {
      Logger.error('Update/notification startup failed (non-fatal):', error)
    }

    // Reclaim directory trees whose database row is gone. Delayed past the
    // interactive path and bounded per run, so a large backlog costs a
    // background task instead of a slower launch.
    setTimeout(() => {
      void import('../storage/orphan-artifact-sweep')
        .then(({ sweepOrphanProjectArtifacts }) => sweepOrphanProjectArtifacts(storage, database))
        .catch((error: unknown) => Logger.dev('Orphan artifact sweep failed:', error))
    }, 20_000)

    // Reclaim the Chromium profiles no live project owns, the same way the sweep
    // above reclaims directory trees under the config root: a deleted project's
    // browser survives as a profile directory that can hold gigabytes. Delayed and
    // bounded for the same reason, and it declines to run at all while a sibling
    // instance is alive, because a sibling's live browser is not this one's to take
    // away.
    setTimeout(() => {
      void import('../browser/browser-service/browser-profile-store')
        .then(({ sweepUnclaimedBrowserProfiles }) => sweepUnclaimedBrowserProfiles(database))
        .catch((error: unknown) => Logger.dev('Browser profile sweep failed:', error))
    }, 25_000)
  })()
}
