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

import { app } from 'electron'
import { join } from 'path'
import { chatThreadArtifactDirectory } from '../../lib/project-artifacts'
import { ensureDir, getConfigRoot } from '../../lib/utils'
import type { ThreadClickedPayload } from '../../lib/ipc-contract'
import type { Database } from '../database/database'
import { StorageEngine } from '../storage/storage-engine'
import { CheckpointManager } from '../storage/checkpoint-manager'
import { Logger } from '../system/logger'
import { setNotificationService, setPowerWakeService } from '../chat/thread-events'
import type { ThreadCreationCoordinator } from '../chat/thread-creation-coordinator'
import type { ThreadDeletionCoordinator } from '../chat/thread-deletion-coordinator'
import { ModelPricingService } from '../providers/model-pricing-service'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { startupTelemetry } from '../system/startup-telemetry'
import { BrowserService } from '../browser/browser-service'
import type { BootstrapState } from './bootstrap-state'
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
    {
      // Chat file trees mount on the thread's own `chats-artifacts/<threadId>`
      // directory; resolution creates it on demand so an empty thread still has
      // a browsable root.
      resolve: async (threadId: string) => {
        const root = storage.resolve(chatThreadArtifactDirectory(threadId))
        await ensureDir(root)
        return root
      }
    }
  )
  state.appfileProjectFiles = projectFilesService
  state.computerUsePipService = new ComputerUsePipService(storage)
  state.harnessManifestService = new HarnessManifestService(storage)
  state.modelPricingService = new ModelPricingService(storage)
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
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    const service = new BrowserService(state.mainWindow, database, storage)
    state.browserService = service
    // Remembered permission decisions load before the service accepts browser
    // IPC, so a site is never re-prompted for a permission the user already
    // granted in this or an earlier run.
    await service.hydratePermissionMemory()
    service.register()
    state.chatEngine.setBrowserUtilityExecutor((operation, input, browserContext) =>
      service.executeUtility(operation, input, browserContext)
    )
  }
  // Keep the device awake while a scheduled auto-retry is due within the wake
  // window, so a usage-limit reset fires even when the user is away.
  state.powerWakeService.attachRetryScheduler(state.retryScheduler)
  state.retryScheduler.attachChangeListener(() => state.powerWakeService?.onRetryScheduleChanged())
  state.updaterService.setChatEngine(state.chatEngine)
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
    vault,
    githubAuthService,
    skillUpdates: skillUpdateService,
    directoryPreviewService: state.directoryPreviewService,
    powerWakeService: state.powerWakeService,
    retryScheduler: state.retryScheduler,
    heartbeatScheduler: state.heartbeatScheduler,
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
  state.threadTransfer = new ThreadTransferService(database, state.chatEngine)
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
      }
    )
    // A probe that changes a harness's install state (new install, version
    // bump) invalidates cached provider catalogs so the model picker reflects it.
    state.providerConnection = new ProviderConnectionService(() => {
      void state.chatEngine?.invalidateProviderCatalogs()
    })
    state.openCodeV2Service = new OpenCodeV2Service()
    state.harnessUpdateService = new HarnessUpdateService(state.providerConnection)
    state.harnessAutoUpdateService = new HarnessAutoUpdateService(storage)
    state.harnessInstallService = new HarnessInstallService(state.providerConnection)
    state.notificationService = new NotificationService(storage, database, context.onThreadClicked)

    // Optional IPC   registered only after the services exist.
    if (state.updaterService) {
      state.updaterService.addActivitySource({
        activeSessionCount: () => state.ptyService?.activeSessionCount() ?? 0
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
  })()
}
