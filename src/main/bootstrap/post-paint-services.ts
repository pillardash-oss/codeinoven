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

import { app, type BrowserWindow } from 'electron'
import { join } from 'path'
import { createThreadWorkspaceRoots } from '../editor/project-files/thread-workspace-roots'
import { getConfigRoot } from '../../lib/utils'
import { routinePrimaryModel, settingsWithRoutineModel } from '../../lib/routine-agents'
import { findBrowserSearchEngine } from '../../lib/browser-search-engines'
import { prototypeCdnPolicyFromConfig } from '../../lib/prototypes/prototype-cdn'
import { workRootsFromConfig } from '../../lib/design/work-roots'
import { setWorkRoots } from '../design/work-roots-state'
import { assistantRunTitle, routineRunPrompt } from '../../lib/routine-run'
import type { ThreadClickedPayload } from '../../lib/ipc-contract'
import type { Database } from '../database/database'
import { StorageEngine } from '../storage/storage-engine'
import { CheckpointManager } from '../storage/checkpoint-manager'
import { Logger } from '../system/logger'
import { resolveAutoAnswerScope } from '../system/auto-answer-scope'
import {
  broadcastThreadUpdate,
  setBackgroundAttention,
  setNotificationService,
  setPowerWakeService
} from '../chat/thread-events'
import type { ThreadCreationCoordinator } from '../chat/thread-creation-coordinator'
import type { ThreadDeletionCoordinator } from '../chat/thread-deletion-coordinator'
import { ModelPricingService } from '../providers/model-pricing-service'
import { getActiveThreadProjects } from '../database/active-thread-report'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { startupTelemetry } from '../system/startup-telemetry'
import { BrowserService } from '../browser/browser-service'
import { BrowserDownloadManager } from '../browser/browser-service/browser-downloads'
import type { DesignService } from '../design/design-service'
import type { BootstrapState } from './bootstrap-state'

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
  if (state.updaterService) return
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
    { UpdaterService },
    { PowerWakeService },
    { RetrySchedulerService },
    { HeartbeatSchedulerService },
    { SpeechService },
    { registerSpeechIpc },
    { PrototypePreviewService },
    { DirectoryPreviewService },
    { ForeignRunService },
    { ThreadTransferService },
    { RoutineManager },
    { RoutineSchedulerService },
    {
      broadcastMissedRunsChanged,
      broadcastAutoAnswersChanged,
      broadcastBackgroundRunsChanged,
      broadcastSkippedRoutineRunsChanged
    },
    { SkillUpdateService },
    { SecretVault },
    { GitHubAuthService }
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
    import('../notifications/updater-service'),
    import('../system/power-wake-service'),
    import('../system/retry-scheduler-service'),
    import('../system/heartbeat-scheduler-service'),
    import('../speech/speech-service'),
    import('../ipc/speech-ipc'),
    import('../prototypes/prototype-preview-service'),
    import('../preview/directory-preview-service'),
    import('../chat/foreign-run-service'),
    import('../chat/thread-transfer-service'),
    import('../../lib/engines/routine-manager'),
    import('../scheduler/routine-scheduler-service'),
    import('../scheduler/assistant-events'),
    import('../utilities/skill-updates'),
    import('../storage/secret-vault'),
    import('../git/github-auth-service')
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
    // `assistant-cwd/<routineId ?? threadId>` workspace; both are created on
    // demand so an empty conversation still has a browsable root.
    createThreadWorkspaceRoots(storage, database)
  )
  state.appfileProjectFiles = projectFilesService
  state.computerUsePipService = new ComputerUsePipService(storage)
  state.harnessManifestService = new HarnessManifestService(storage)
  state.modelPricingService = new ModelPricingService(storage)
  // Resolve which OpenCode line is installed before the chat engine builds its
  // driver map, so a V2-only machine never starts a turn on the V1 transport.
  // Bounded and non-fatal: a missing binary just leaves the canonical default.
  const { detectOpenCodeInstallation } = await import('../agents/opencode-installation')
  await detectOpenCodeInstallation().catch((error) =>
    Logger.dev('opencode install detection failed (non-fatal):', error)
  )
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
  // Merge the app-managed lean opencode agents into the machine-wide global
  // config. Idempotent, additive-only and non-fatal; runs after first paint
  // so it never blocks the workspace, and logs a dev-only summary.
  const { syncOpenCodeLeanAgents } = await import('../opencode/opencode-agent-service')
  await syncOpenCodeLeanAgents().catch((error) =>
    Logger.dev('opencode lean-agent sync failed (non-fatal):', error)
  )
  state.updaterService = new UpdaterService(storage)
  // An update install owns its quit: background mode would otherwise park on the
  // `app.quit()` the updater triggers and the update would never apply. The flag
  // is cleared again if the install cannot proceed, so the app stays parkable.
  state.updaterService.attachUpdateQuitHooks({
    begin: () => {
      state.quitForUpdate = true
    },
    end: () => {
      state.quitForUpdate = false
    }
  })
  // The menu bar's "Check for Updates" drives the whole silent cycle. Wired here,
  // where the updater is born, so the tray item is live the moment the updater is.
  state.backgroundLifecycle?.setUpdater({
    updateInBackground: async () => {
      await state.updaterService?.updateInBackground()
    },
    status: () => state.updaterService?.status ?? { canAutoUpdate: false, state: 'idle' },
    onStatusChange: (callback) =>
      state.updaterService?.onStatusChange(callback) ?? (() => undefined)
  })
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
  // Installed skills ride the app-update check cycle: the same startup,
  // six-hourly and explicit check that looks for a new build also keeps the
  // marketplace skills CodeInOven placed up to date, in small batches.
  const skillUpdateService = new SkillUpdateService({
    install: {
      storage,
      home: app.getPath('home'),
      resolveProjectPath: resolveProjectRoot,
      githubToken: () => githubAuthService.resolveToken()
    },
    listProjectIds: async () => (await projectManager.listProjects()).map((project) => project.id)
  })
  state.skillUpdateService = skillUpdateService
  state.updaterService.setCheckCycleHook((explicit) =>
    skillUpdateService.scheduleCheck({ explicit })
  )
  state.powerWakeService = new PowerWakeService(storage, database)
  state.retryScheduler = new RetrySchedulerService(storage)
  state.heartbeatScheduler = new HeartbeatSchedulerService(storage)
  state.chatEngine.attachHeartbeatScheduler(state.heartbeatScheduler)
  state.routineManager = new RoutineManager(database)
  const routineManager = state.routineManager
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
      // File the gate under the task and routine it actually concerns, so the
      // decision keeps surfacing after this run thread is evicted.
      ...resolveAutoAnswerScope(database, report.projectId, report.threadId),
      entries: report.entries,
      at: report.at
    })
    broadcastAutoAnswersChanged(store.list())
    state.backgroundLifecycle?.refreshAttention()
  })
  state.routineScheduler = new RoutineSchedulerService(storage, {
    routines: routineManager,
    backgroundLedger: state.backgroundRunLedger,
    // A run that failed while nobody was watching becomes unread, so its
    // persisted message reaches the badge and the panel on the next open and the
    // menu bar icon can say something needs attention.
    onRunFailed: (runThreadId) => {
      try {
        new ThreadRepo(database).markUnread(runThreadId)
        state.backgroundLifecycle?.refreshAttention()
      } catch (error) {
        Logger.error('Could not flag a failed run as unread:', error)
      }
    },
    onTaskChanged: (task) => broadcastThreadUpdate(task),
    // Every run executes on a fresh thread: a scheduled fire and a manual
    // "Run now" both create one, so a run never lands in the task's own
    // conversation. Only a routine's Getting started thread hosts authoring.
    createRunThread: (task, routine) => {
      const chatEngine = state.chatEngine
      if (!chatEngine) throw new Error('The chat engine is not available')
      // A scheduled run needs a bound model; a task that was never configured
      // is skipped rather than fired with guessed settings.
      if (!task.settings) throw new Error('This task has no model configured yet.')
      // The routine's primary model wins over whatever the thread was last set
      // to, so the models the user picked for the routine are the models its
      // runs actually use. A routine without a model set keeps the thread's own.
      const primary = routinePrimaryModel(routine?.agents)
      const runSettings = primary ? settingsWithRoutineModel(task.settings, primary) : task.settings
      return chatEngine.createAssistantRunThread({
        task,
        settings: runSettings,
        title: assistantRunTitle(Date.now())
      })
    },
    dispatch: (run, task, routine) => {
      const chatEngine = state.chatEngine
      if (!chatEngine) {
        Logger.dev('Scheduled routine run skipped   no chat engine', { threadId: task.id })
        return
      }
      const prompt = routineRunPrompt(task, routine?.name)
      const runSettings = run.settings ?? task.settings
      if (!runSettings) {
        Logger.error('Routine run has no bound settings', { taskId: task.id, runId: run.id })
        return
      }
      // The routine's how-to is NOT passed as prompt context: the engine composes
      // it into the run's system prompt from the routine itself
      // (`routineHowToInstruction`), which the run thread carries through its
      // inherited `routineId`, so it is restated every turn instead of being
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
  state.routineScheduler.attachChangeListener(() => {
    broadcastMissedRunsChanged(state.routineScheduler?.listMissedRuns() ?? [])
    broadcastBackgroundRunsChanged(state.routineScheduler?.listBackgroundRuns() ?? [])
    broadcastSkippedRoutineRunsChanged(state.routineScheduler?.listSkippedRoutineRuns() ?? [])
    state.backgroundLifecycle?.refreshAttention()
  })
  // Background wake: the machine is held awake inside the lead window before a
  // due scheduled run, capped so a mis-scheduled task cannot pin it. The next
  // due moment is read lazily from the scheduler, so a change is never cached.
  state.powerWakeService.attachScheduledRunSource(
    () => state.routineScheduler?.nextDueAt(Date.now()) ?? null
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
  // Scheduled assistant runs fall over to the routine's next model when the
  // current one fails, instead of waiting out the failed provider's reset.
  state.chatEngine.attachAssistantAgentsResolver((task) =>
    state.routineManager?.resolveTaskAgents(task)
  )
  // A settled turn on an assistant task is reported to the routine scheduler,
  // which knows whether it dispatched a run on that task and stamps the last
  // successful run once the run's turn actually completes.
  state.chatEngine.attachAssistantRunSettledRecorder((threadId, status) => {
    state.routineScheduler?.settleRun(threadId, status)
    // A settled run's outcome now belongs in the "While you were away" list.
    broadcastBackgroundRunsChanged(state.routineScheduler?.listBackgroundRuns() ?? [])
  })
  state.speechService = new SpeechService(
    {
      catalogPath: app.isPackaged
        ? join(process.resourcesPath, 'speech/model-catalog.json')
        : join(app.getAppPath(), 'resources/speech/model-catalog.json'),
      mlxWorkerPath: app.isPackaged
        ? join(process.resourcesPath, 'speech/mlx-worker')
        : join(app.getAppPath(), 'resources/speech/runtime/darwin-arm64/mlx-worker'),
      coremlWorkerPath: app.isPackaged
        ? join(process.resourcesPath, 'speech/coreml-worker')
        : join(app.getAppPath(), 'resources/speech/runtime/darwin-arm64/coreml-worker'),
      nativeCaptureWorkerPath: app.isPackaged
        ? join(process.resourcesPath, 'speech/speech-capture-worker')
        : join(app.getAppPath(), 'resources/speech/runtime/darwin-arm64/speech-capture-worker')
    },
    undefined,
    (input) => state.chatEngine!.cleanupSpeechTranscript(input),
    (input) => state.chatEngine!.transcribeSpeechAudio(input),
    (input) => state.chatEngine!.learnSpeechLessons(input),
    (pid, command, cwd) =>
      state.chatEngine!.trackPtyProcess(undefined, undefined, undefined, pid, command, cwd)
  )
  await state.speechService.initialize()
  // Initialize auto-evict timers from persisted sound settings
  try {
    const cfg = await storage.getConfig()
    state.speechService.updateUnloadOptions({
      asr: cfg.sound.asrUnload,
      cleanup: cfg.sound.cleanupUnload,
      tts: cfg.sound.ttsUnload
    })
  } catch {
    // defaults already applied
  }
  state.unregisterSpeechIpc = registerSpeechIpc(
    state.speechService,
    () => state.mainWindow?.webContents ?? null
  )
  state.prototypePreviewService = new PrototypePreviewService()
  try {
    const startupConfig = await storage.getConfig()
    state.prototypePreviewService.setCdnPolicy(prototypeCdnPolicyFromConfig(startupConfig))
    // The folders designs and videos are written into. Held for the whole run so a
    // path resolver never touches the config file, and replaced on every save.
    setWorkRoots(workRootsFromConfig(startupConfig))
  } catch {
    // The strict policy and the default folders stand until the config can be read.
  }
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
  const designService = new DesignService({
    database,
    previews: state.directoryPreviewService,
    browser: () => state.browserService
  })
  designService.registerIpc()
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
  state.chatEngine.setVideoPreviewExecutor(
    createVideoPreviewExecutor({
      previews: state.directoryPreviewService,
      database,
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
    state.backgroundLifecycle?.requestAttentionRefresh()
  })
  // The engine counts the working sessions but cannot name them; the shared
  // report is what the close gate lists too, so an install prompt and a quit
  // prompt describe the same work the same way.
  state.updaterService.setChatEngine(state.chatEngine, () => getActiveThreadProjects(database))
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
  registerIpcHandlers(storage, database, state.updaterService, state.chatEngine, {
    projectManager,
    projectFilesService,
    browser: () => state.browserService,
    vault,
    githubAuthService,
    skillUpdates: skillUpdateService,
    directoryPreviewService: state.directoryPreviewService,
    prototypePreviewService: state.prototypePreviewService ?? undefined,
    powerWakeService: state.powerWakeService,
    backgroundLifecycle: state.backgroundLifecycle ?? undefined,
    retryScheduler: state.retryScheduler,
    heartbeatScheduler: state.heartbeatScheduler,
    routineManager: state.routineManager ?? undefined,
    routineScheduler: state.routineScheduler ?? undefined,
    autoAnswerStore: state.autoAnswerStore ?? undefined,
    harnessManifestService: state.harnessManifestService,
    worktreeService: scopeWorktreeService,
    threadCreation: context.threadCreation,
    threadDeletion: context.threadDeletion,
    hydrationHandlersRegistered: true,
    speechService: state.speechService,
    onScopedPathResolver: (resolve) => {
      state.appfileScopedPathResolver = resolve
    }
  })
  state.chatEngine.register()
  state.harnessManifestService.register()
  state.chatEngine.attachRetryScheduler(state.retryScheduler)
  // Registered before `featuresReady`: a window hydrates the cross-instance turn
  // notice as soon as it mounts, and its invoke must not race the handler.
  state.foreignRuns = new ForeignRunService(database)
  state.foreignRuns.registerIpc()
  state.foreignRuns.start()
  state.threadTransfer = new ThreadTransferService(state.chatEngine)
  state.threadTransfer.registerIpc()
  state.threadTransfer.start()
  state.featuresReady = true
  startupTelemetry.mark('features:ready')
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

  void (async () => {
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

    const { ovenTerminalLaunch } = await import('../ovens/oven-terminal')
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
      ovenTerminalLaunch(storage, vault, database)
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
    const { registerGatewayIpc } = await import('../ipc/gateway-ipc')
    const { registerTypesafeIpc } = await import('../ipc/typesafe-ipc')
    const { OwnedProcessJournal } = await import('../system/owned-process-journal')
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
      (utilityId) => state.chatEngine?.applyUtilityRegistryChange(utilityId) ?? Promise.resolve()
    )
    state.gatewaySupervisor = registerGatewayIpc(
      storage,
      () => state.mainWindow?.webContents ?? null,
      undefined,
      new OwnedProcessJournal(join(getConfigRoot(), 'gateways', 'owned-processes.json'))
    )
    // Reap gateway processes orphaned by a previous crash before anything can
    // bind their port again, then bring enabled gateways back up.
    void state.gatewaySupervisor
      .recoverOrphans()
      .then(() => state.gatewaySupervisor?.autoStartEnabled())
      .catch((error) => {
        Logger.error('Gateway startup recovery failed (non-fatal):', error)
      })

    // Wire PTY to the window now that it exists.
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.ptyService.attach(state.mainWindow.webContents)
    }

    try {
      await state.powerWakeService?.start()
      if (state.powerWakeService) setPowerWakeService(state.powerWakeService)
    } catch (error) {
      Logger.error('Power wake startup failed (non-fatal):', error)
    }

    // Every persisted thread update now re-evaluates the menu bar icon, so a
    // thread that breaks while the window is closed flips it and a thread that
    // recovers flips it back.
    if (state.backgroundLifecycle) setBackgroundAttention(state.backgroundLifecycle)

    try {
      await state.retryScheduler?.start()
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
      await state.routineScheduler?.start()
      // A slot the app was closed (or asleep) through is dispatched on return
      // when the user allows it, bounded per pass and idempotent across relaunch.
      if (state.backgroundLifecycle?.autoRunMissedRuns) {
        void state.routineScheduler
          ?.runPendingMisses()
          .catch((error) => Logger.error('Auto-run of missed assistant runs failed:', error))
      }
    } catch (error) {
      Logger.error('Routine scheduler startup failed (non-fatal):', error)
    }

    // A machine that slept through a slot catches up when it wakes or unlocks.
    try {
      if (!state.powerMonitorService) {
        const { PowerMonitorService } = await import('../system/power-monitor-service')
        state.powerMonitorService = new PowerMonitorService({
          onResume: () => {
            state.routineScheduler?.evaluate()
            if (state.backgroundLifecycle?.autoRunMissedRuns) {
              void state.routineScheduler
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
