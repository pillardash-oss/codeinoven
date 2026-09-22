/**
 * Mutable process state for the main-process bootstrap.
 *
 * `src/main/index.ts` stays the composition root: it creates one
 * `BootstrapState` and hands it to the bootstrap modules, so window handles,
 * quit flags and the optional service graph live in one explicitly-passed
 * object instead of module-level bindings that moved code cannot reach.
 */

import type { BrowserWindow } from 'electron'
import type { BrowserService } from '../browser/browser-service'
import type { ChatEngine } from '../chat/chat-engine'
import type { ForeignRunService } from '../chat/foreign-run-service'
import type { ThreadTransferService } from '../chat/thread-transfer-service'
import type { GatewaySupervisorService } from '../gateway/gateway-supervisor-service'
import type { HarnessManifestService } from '../agents/harness-manifest-service'
import type { ComputerUsePipService } from '../utilities/computer-use-pip-service'
import type { UpdaterService } from '../notifications/updater-service'
import type { SkillUpdateService } from '../utilities/skill-updates'
import type { PowerWakeService } from '../system/power-wake-service'
import type { RetrySchedulerService } from '../system/retry-scheduler-service'
import type { HeartbeatSchedulerService } from '../system/heartbeat-scheduler-service'
import type { PtyService } from '../system/pty-service'
import type { ProviderConnectionService } from '../providers/provider-connection'
import type { HarnessUpdateService } from '../agents/harness-update-service'
import type { HarnessAutoUpdateService } from '../agents/harness-auto-update-service'
import type { HarnessInstallService } from '../agents/harness-install-service'
import type { NotificationService } from '../notifications/notification-service'
import type { ModelPricingService } from '../providers/model-pricing-service'
import type { SpeechService } from '../speech/speech-service'
import type { ProjectFilesService } from '../editor/project-files-service'
import type { PrototypePreviewService } from '../prototypes/prototype-preview-service'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'

export interface BootstrapState {
  /** Primary window; null before creation and after it closes. */
  mainWindow: BrowserWindow | null
  browserService: BrowserService | null
  gatewaySupervisor: GatewaySupervisorService | null

  // Quit lifecycle flags shared by the close gate, the signal handlers and the
  // shutdown pipeline.
  quitCleanupStarted: boolean
  quitConfirmed: boolean
  shutdownFailsafe: ReturnType<typeof setTimeout> | null

  // Renderer readiness and startup milestones.
  rendererReadyReported: boolean
  packagedSmokeProofStarted: boolean
  startupTelemetryReported: boolean
  featuresReady: boolean
  resolveFeaturesReady: (() => void) | null
  /** Whether a terminal in the renderer currently holds focus. */
  terminalFocused: boolean

  /**
   * Optional services constructed after the primary window paints. Module
   * evaluation only declares the bindings so the heavy service graph (chat
   * engine, PTY, harness, ...) never blocks the splash or the first window.
   * Every consumer guards for `null`.
   */
  chatEngine: ChatEngine | null
  ptyService: PtyService | null
  providerConnection: ProviderConnectionService | null
  harnessUpdateService: HarnessUpdateService | null
  harnessAutoUpdateService: HarnessAutoUpdateService | null
  harnessInstallService: HarnessInstallService | null
  harnessManifestService: HarnessManifestService | null
  computerUsePipService: ComputerUsePipService | null
  notificationService: NotificationService | null
  updaterService: UpdaterService | null
  skillUpdateService: SkillUpdateService | null
  powerWakeService: PowerWakeService | null
  retryScheduler: RetrySchedulerService | null
  heartbeatScheduler: HeartbeatSchedulerService | null
  /** Stops the instance take-over watcher registered after launch recovery. */
  stopInstanceTakeOverListener: (() => void) | null
  /** Cross-instance turn-ownership notices pushed to every window. */
  foreignRuns: ForeignRunService | null
  /** Cross-instance thread transfer: releases and adopts running threads. */
  threadTransfer: ThreadTransferService | null
  modelPricingService: ModelPricingService | null
  speechService: SpeechService | null
  unregisterSpeechIpc: (() => void) | null
  prototypePreviewService: PrototypePreviewService | null
  /** Loopback static servers behind the file tree's "Open in browser" action. */
  directoryPreviewService: DirectoryPreviewService | null
  /**
   * Resolved lazily so the `appfile://` preview protocol can be installed before
   * the main window loads (its renderer requests previews as soon as it hydrates).
   * Populated in {@link bootPostPaintServices} once the file service exists.
   */
  appfileProjectFiles: ProjectFilesService | null
  /**
   * Privileged scoped-path resolver, handed over by the IPC layer once the
   * post-paint service graph exists. The `appfile://` protocol needs it to serve
   * standalone (OS-opened) file previews with the same authorization privileged
   * IPC uses; project-relative previews keep resolving through the file service.
   */
  appfileScopedPathResolver: ((value: unknown) => Promise<string>) | null
}

export function createBootstrapState(): BootstrapState {
  return {
    mainWindow: null,
    browserService: null,
    gatewaySupervisor: null,
    quitCleanupStarted: false,
    quitConfirmed: false,
    shutdownFailsafe: null,
    rendererReadyReported: false,
    packagedSmokeProofStarted: false,
    startupTelemetryReported: false,
    featuresReady: false,
    resolveFeaturesReady: null,
    terminalFocused: false,
    chatEngine: null,
    ptyService: null,
    providerConnection: null,
    harnessUpdateService: null,
    harnessAutoUpdateService: null,
    harnessInstallService: null,
    harnessManifestService: null,
    computerUsePipService: null,
    notificationService: null,
    updaterService: null,
    skillUpdateService: null,
    powerWakeService: null,
    retryScheduler: null,
    heartbeatScheduler: null,
    stopInstanceTakeOverListener: null,
    foreignRuns: null,
    threadTransfer: null,
    modelPricingService: null,
    speechService: null,
    unregisterSpeechIpc: null,
    prototypePreviewService: null,
    directoryPreviewService: null,
    appfileProjectFiles: null,
    appfileScopedPathResolver: null
  }
}
