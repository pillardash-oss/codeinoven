import { app, BrowserWindow, Notification, shell } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { APP_NAME, APP_SLUG } from '../../lib/brand'
import { Logger } from '../system/logger'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { forwardRemoteEvent } from '../remote/remote-event-forwarder'
import type { StorageEngine } from '../storage/storage-engine'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { AssignmentRepo } from '../database/repositories/assignment-repo'
import { isOrchestrationChildThread, type Thread, type ThreadStatus } from '../../lib/types'
import type {
  AgentNotificationKind,
  AgentNotificationPayload,
  SystemNotificationPermissionStatus,
  SystemNotificationTestResult,
  ThreadClickedPayload
} from '../../lib/ipc-contract'

const NOTIFIABLE_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  'completed',
  'awaiting_approval',
  'failed'
])
const MAX_RETAINED_NOTIFICATIONS = 200
const BADGE_STATE_PATH = 'state/notification-badge.json'
const PERMISSION_STATE_PATH = 'state/notification-permission.json'
/**
 * Cooldown between background permission re-verifications: when the Settings
 * panel is opened while the app thinks notifications are blocked, one silent
 * verification delivery is attempted so the OS can confirm or clear the state.
 */
const PERMISSION_VERIFY_DEDUP_MS = 15_000
/** How long a background verification delivery may take before it is dropped. */
const PERMISSION_VERIFY_TIMEOUT_MS = 4_000
/**
 * Cooldown covering the alert's duration. Only the first notification of a
 * burst plays a sound — notifications arriving inside this window still show
 * their cards but stay quiet so a burst never machine-guns beeps.
 */
const NOTIFICATION_SOUND_DEDUP_MS = 2_500

interface BadgeStateRecord {
  version: 1
  threads: string[]
}

interface PermissionStateRecord {
  version: 1
  status: 'granted' | 'denied' | 'prompt'
}

type ThreadClickedHandler = (payload: ThreadClickedPayload) => void

/**
 * Detect a macOS permission refusal from the `failed` event payload. Electron
 * forwards `NSError.localizedDescription` (a string); a denied/unsigned app
 * gets `UNErrorNotAllowed`, whose description reads "Notifications are not
 * allowed for this application". Any other failure (invalid attachment, etc.)
 * is delivery noise and must not flip the permission state.
 */
function isPermissionRefusal(error: unknown): boolean {
  return typeof error === 'string' && /not allowed/i.test(error)
}

export class NotificationService {
  private readonly storage: StorageEngine
  private readonly projectRepo: ProjectRepo
  private readonly threadRepo: ThreadRepo
  private readonly assignmentRepo: AssignmentRepo
  private readonly onThreadClicked: ThreadClickedHandler
  private readonly lastObservedStatus = new Map<string, ThreadStatus>()
  private readonly activeNotifications = new Map<string, Notification>()
  private readonly abortingThreads = new Set<string>()
  private readonly badgeThreads = new Set<string>()
  private lastNotificationSoundPlayedAt = 0
  private started = false
  private unsupportedLogged = false
  /**
   * Last observed macOS notification delivery outcome, used to surface a
   * permission warning in Settings. Electron exposes no native notification
   * authorization query, so this is inferred from the OS delivery events:
   * 'show' means permission granted; 'failed' with a permission-refusal error
   * (UNErrorNotAllowed) means the OS refused delivery (permission denied or an
   * unsigned/ad-hoc build that macOS silently blocks). The state is persisted
   * and re-verified on demand when the Settings panel opens, so it can never
   * stay stuck at 'denied' after the user re-enables notifications.
   */
  private macosNotificationPermission: 'granted' | 'denied' | 'prompt' = 'prompt'
  private permissionVerifyInFlight = false
  private lastPermissionVerifyAt = 0

  constructor(storage: StorageEngine, db: Database, onThreadClicked: ThreadClickedHandler) {
    this.storage = storage
    this.projectRepo = new ProjectRepo(db)
    this.threadRepo = new ThreadRepo(db)
    this.assignmentRepo = new AssignmentRepo(db)
    this.onThreadClicked = onThreadClicked
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.hydrateBadge()
    void this.hydratePermissionStatus()
    ipcMain.handle('notification:test', () => this.sendTestNotification())
    ipcMain.handle('notification:getPermissionStatus', () => this.getVerifiedPermissionStatus())
    ipcMain.handle('notification:openSettings', () => this.openSettings())
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.lastObservedStatus.clear()
    this.activeNotifications.clear()
    this.badgeThreads.clear()
    this.updateBadge()
    ipcMain.removeHandler('notification:test')
    ipcMain.removeHandler('notification:getPermissionStatus')
    ipcMain.removeHandler('notification:openSettings')
  }

  /**
   * Record the outcome of a native notification delivery. Electron has no
   * notification-permission query API on macOS, so the OS delivery events are
   * the authoritative signal: a shown notification implies permission, a
   * refused one implies the app is blocked (permission denied or unsigned).
   * Only a refusal error (`UNErrorNotAllowed` — "not allowed") marks the state
   * as denied: other failures are logged but never flip the state, so a
   * transient error can never permanently lock the app into "blocked".
   */
  private recordNotificationOutcome(outcome: 'shown' | 'failed', error?: unknown): void {
    if (process.platform !== 'darwin') return
    const previous = this.macosNotificationPermission
    if (outcome === 'shown') {
      this.macosNotificationPermission = 'granted'
    } else if (this.macosNotificationPermission !== 'granted' && isPermissionRefusal(error)) {
      this.macosNotificationPermission = 'denied'
    }
    if (this.macosNotificationPermission !== previous) {
      this.persistPermissionStatus()
      this.pushPermissionStatus()
    }
  }

  private async hydratePermissionStatus(): Promise<void> {
    try {
      const state = await this.storage.read<PermissionStateRecord>(PERMISSION_STATE_PATH)
      if (
        state &&
        (state.status === 'granted' || state.status === 'denied' || state.status === 'prompt')
      ) {
        this.macosNotificationPermission = state.status
      }
    } catch (error) {
      Logger.dev('Notification permission state restore failed:', error)
    }
  }

  private persistPermissionStatus(): void {
    void (async (): Promise<void> => {
      try {
        await this.storage.write(PERMISSION_STATE_PATH, {
          version: 1,
          status: this.macosNotificationPermission
        } satisfies PermissionStateRecord)
      } catch (error) {
        Logger.dev('Notification permission state persist failed:', error)
      }
    })()
  }

  /** Push the current permission status to every live renderer. */
  private pushPermissionStatus(): void {
    const status = this.getPermissionStatus()
    if (status.platform !== 'darwin') return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        sendToRenderer(window.webContents, 'notification:permissionStatus', status)
      }
    }
  }

  /**
   * Re-verify a previously observed `denied` state against the OS by silently
   * delivering one verification notification. A successful delivery flips the
   * state back to `granted` (the user re-enabled notifications in System
   * Settings); a refusal keeps it `denied`. If the OS actually still has the
   * permission prompt pending (fresh install), the request re-prompts — which
   * is exactly what the notification settings panel is for. Deduped so
   * repeated settings queries only re-check every few seconds.
   */
  private verifyPermissionDelivery(): void {
    if (this.permissionVerifyInFlight) return
    const now = Date.now()
    if (now - this.lastPermissionVerifyAt < PERMISSION_VERIFY_DEDUP_MS) return
    this.lastPermissionVerifyAt = now
    if (!Notification.isSupported()) return

    const notification = new Notification({
      id: `${APP_SLUG}-permission-verify`,
      groupId: `${APP_SLUG}-system`,
      title: `${APP_NAME} notifications`,
      body: 'You will be notified when an agent finishes, needs attention, or encounters an error.',
      silent: true
    })
    this.permissionVerifyInFlight = true
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      this.permissionVerifyInFlight = false
    }
    const timeout = setTimeout(settle, PERMISSION_VERIFY_TIMEOUT_MS)
    notification.once('show', () => {
      this.recordNotificationOutcome('shown')
      settle()
    })
    notification.once('failed', (_event, error) => {
      this.recordNotificationOutcome('failed', error)
      Logger.dev('Permission verification delivery was refused:', error)
      settle()
    })
    this.retainNotification('system-verify', notification)
    try {
      notification.show()
    } catch (error) {
      Logger.dev('Permission verification could not be shown:', error)
      settle()
    }
  }

  /**
   * macOS notification authorization, inferred from OS delivery outcomes.
   * 'prompt' means the OS has not delivered nor refused yet — the first
   * notification (or the Settings test) will decide it. Exposed so the UI can
   * warn when notifications are blocked and deep-link into System Settings.
   * While 'denied', every query re-verifies against the OS so the warning
   * clears as soon as the user re-enables notifications — it can never stay
   * stale across Settings visits.
   */
  getPermissionStatus(): SystemNotificationPermissionStatus {
    if (process.platform !== 'darwin') {
      return { platform: 'other' }
    }
    return { platform: 'darwin', status: this.macosNotificationPermission }
  }

  /**
   * The permission status used by the Settings panel: returns the current
   * state and, when it is 'denied', kicks a deduped background verification so
   * the OS itself confirms or clears the block. The result arrives over the
   * `notification:permissionStatus` event.
   */
  async getVerifiedPermissionStatus(): Promise<SystemNotificationPermissionStatus> {
    const status = this.getPermissionStatus()
    if (status.platform === 'darwin' && status.status === 'denied') {
      this.verifyPermissionDelivery()
    }
    return status
  }

  /**
   * Open the OS notification-settings pane so the user can re-enable
   * notifications. The deep-link URL is a hard-coded, platform-specific
   * constant (never renderer-supplied), so it bypasses the web-only external
   * URL validator. Returns false on platforms with no such deep link.
   */
  async openSettings(): Promise<boolean> {
    const url = this.notificationSettingsUrl()
    if (url === null) return false
    try {
      await shell.openExternal(url)
      return true
    } catch (error) {
      Logger.error('Could not open notification settings:', error)
      return false
    }
  }

  private notificationSettingsUrl(): string | null {
    switch (process.platform) {
      case 'darwin':
        return 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
      case 'win32':
        return 'ms-settings:notifications'
      default:
        return null
    }
  }

  markAborting(projectId: string, threadId: string): void {
    this.abortingThreads.add(`${projectId}:${threadId}`)
  }

  clearAborting(projectId: string, threadId: string): void {
    this.abortingThreads.delete(`${projectId}:${threadId}`)
  }

  /**
   * The Sr. Engineer (coordinator) thread is the one that owns an Achievement
   * or Assignment workflow and is the only orchestration thread that may
   * notify the user.
   */
  private isCoordinatorThread(thread: Thread): boolean {
    return thread.achievementRole === 'coordinator' || thread.assignmentRole === 'coordinator'
  }

  /**
   * Worker and auditor threads are orchestration internals: their progress and
   * outcomes are surfaced through the coordinator instead, so they never
   * notify on their own.
   */
  private isSuppressedOrchestration(thread: Thread): boolean {
    return isOrchestrationChildThread(thread)
  }

  /**
   * The coordinator notifies on `completed` only when the whole process is
   * over. While its Achievement loop is still enabled or its Assignment is
   * still running, a `completed` turn is an intermediate step (dispatch,
   * review) that must not notify.
   */
  private isPrematureCoordinatorCompletion(thread: Thread): boolean {
    if (thread.status !== 'completed' || !this.isCoordinatorThread(thread)) return false
    if (thread.settings?.loopMode === true) return true
    if (thread.assignmentId) {
      try {
        const assignment = this.assignmentRepo.getActive(thread.projectId, thread.id)
        if (assignment && ['approved', 'running', 'attention'].includes(assignment.status)) {
          return true
        }
      } catch (error) {
        Logger.dev('Assignment state lookup failed for notification suppression:', error)
      }
    }
    return false
  }

  /**
   * Dismiss every delivered notification for a thread — closes its OS
   * notifications (including side-chat notifications piped through it) and
   * drops the thread from the app-icon badge. Called whenever the thread is
   * marked read or deleted so the OS notification center stays in sync with
   * in-app state.
   */
  dismissForThread(projectId: string, threadId: string): void {
    const threadKey = `${projectId}:${threadId}`
    for (const [key, notification] of this.activeNotifications) {
      if (key === threadKey || key.startsWith(`${threadKey}:temp:`)) {
        this.activeNotifications.delete(key)
        try {
          notification.close()
        } catch (error) {
          Logger.dev('OS notification close failed:', error)
        }
      }
    }

    if (this.badgeThreads.delete(threadKey)) {
      this.updateBadge()
    }
  }

  /**
   * Restore the badge after a restart. The durable record is restored first
   * (belt-and-suspenders), then reconciled against the authoritative DB state:
   * every unread thread in a notifiable status counts, stale restored keys are
   * pruned, and the reconciled set is persisted back.
   */
  private async hydrateBadge(): Promise<void> {
    this.badgeThreads.clear()
    await this.restoreBadgeState()

    try {
      const threads = this.threadRepo.listAll()
      const validKeys = new Set<string>()
      for (const thread of threads) {
        if (
          NOTIFIABLE_STATUSES.has(thread.status) &&
          !thread.read &&
          !this.isSuppressedOrchestration(thread) &&
          !this.isPrematureCoordinatorCompletion(thread)
        ) {
          validKeys.add(`${thread.projectId}:${thread.id}`)
        }
      }
      for (const key of [...this.badgeThreads]) {
        if (!validKeys.has(key)) this.badgeThreads.delete(key)
      }
      for (const key of validKeys) {
        this.badgeThreads.add(key)
      }
    } catch (error) {
      Logger.dev('Notification badge hydration failed:', error)
    }

    this.updateBadge()
  }

  private async restoreBadgeState(): Promise<void> {
    try {
      const state = await this.storage.read<BadgeStateRecord>(BADGE_STATE_PATH)
      if (!state || !Array.isArray(state.threads)) return
      for (const key of state.threads) {
        if (typeof key === 'string') this.badgeThreads.add(key)
      }
    } catch (error) {
      Logger.dev('Notification badge state restore failed:', error)
    }
  }

  private async persistBadgeState(): Promise<void> {
    try {
      await this.storage.write(BADGE_STATE_PATH, {
        version: 1,
        threads: [...this.badgeThreads]
      } satisfies BadgeStateRecord)
    } catch (error) {
      Logger.dev('Notification badge state persist failed:', error)
    }
  }

  private markThreadNotified(threadKey: string): void {
    if (this.badgeThreads.has(threadKey)) return
    this.badgeThreads.add(threadKey)
    this.updateBadge()
  }

  /** Push the unread-notification count onto the app icon (dock/taskbar). */
  private updateBadge(): void {
    try {
      app.setBadgeCount(this.badgeThreads.size)
    } catch (error) {
      Logger.dev('App icon badge update failed:', error)
    }
    void this.persistBadgeState()
  }

  async notify(thread: Thread): Promise<void> {
    if (!this.started) return

    const threadKey = `${thread.projectId}:${thread.id}`
    if (this.abortingThreads.has(threadKey)) return
    // In Achievement/Assignment mode only the Sr. Engineer (coordinator) thread
    // notifies, and only when the whole process is over or human intervention
    // is needed. Worker/auditor threads never notify, and the coordinator's
    // intermediate turn completions do not.
    if (this.isSuppressedOrchestration(thread)) return
    if (this.isPrematureCoordinatorCompletion(thread)) return
    const previous = this.lastObservedStatus.get(threadKey)
    this.lastObservedStatus.set(threadKey, thread.status)

    if (!NOTIFIABLE_STATUSES.has(thread.status)) return
    if (previous === thread.status) return
    if (thread.read) return
    // A thread that transitions straight from `failed` to `completed` — without
    // an intervening working status — is reporting a stale/wrong success: the
    // turn never actually re-ran (a fresh run would pass through executing or
    // planning). Emitting a "done" notification right after an error one is
    // exactly the misleading double-notify users have reported, so suppress it.
    if (thread.status === 'completed' && previous === 'failed') return

    let projectName = ''
    try {
      const project = this.projectRepo.get(thread.projectId)
      projectName = project?.name ?? ''
    } catch (error) {
      Logger.dev('Notification project name resolution failed:', error)
    }

    if (this.lastObservedStatus.get(threadKey) !== thread.status) return

    this.markThreadNotified(threadKey)

    const payload = this.notificationPayload(thread, projectName || APP_NAME)
    const windows = BrowserWindow.getAllWindows()
    for (const window of windows) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        sendToRenderer(window.webContents, 'notification:show', payload)
      }
    }
    forwardRemoteEvent('notification:show', payload)

    if (windows.some((window) => window.isFocused())) return
    this.dispatchNotificationSound(windows)
    const silent = this.appManagesSound(windows)
    if (!Notification.isSupported()) {
      if (!this.unsupportedLogged) {
        this.unsupportedLogged = true
        Logger.error('System notifications are not supported on this device.')
      }
      return
    }

    try {
      const notification = new Notification({
        id: payload.id,
        groupId: `${APP_SLUG}-${thread.projectId}`,
        title: payload.title,
        subtitle: projectName || APP_NAME,
        body: payload.body,
        urgency: payload.kind === 'error' ? 'critical' : 'normal',
        silent
      })

      notification.on('click', (): void => {
        this.onThreadClicked({
          projectId: thread.projectId,
          threadId: thread.id
        })
      })
      notification.on('show', (): void => {
        this.recordNotificationOutcome('shown')
        Logger.info('System notification shown', {
          kind: payload.kind,
          projectId: thread.projectId,
          threadId: thread.id
        })
      })
      notification.on('failed', (_event, error): void => {
        this.recordNotificationOutcome('failed', error)
        Logger.error('System notification failed:', error)
      })

      this.retainNotification(threadKey, notification)
      notification.show()
    } catch (error) {
      Logger.error('Thread notification could not be shown:', error)
    }
  }

  /**
   * Notify that a temporary chat (side chat) finished responding, piped through
   * the parent thread's notification channel. The parent thread's own status
   * never changes when a temporary chat completes, so this mirrors the regular
   * notification path with a payload that still references the parent thread.
   */
  async notifyTemporaryChat(
    thread: Thread,
    temporaryChatId: string,
    kind: Extract<AgentNotificationKind, 'completed' | 'error'>
  ): Promise<void> {
    if (!this.started) return

    const threadKey = `${thread.projectId}:${thread.id}`
    if (this.abortingThreads.has(threadKey)) return
    // Side chats piped through a worker or auditor parent thread stay quiet in
    // Achievement/Assignment mode; only the Sr. Engineer thread notifies.
    if (this.isSuppressedOrchestration(thread)) return

    let projectName = ''
    try {
      const project = this.projectRepo.get(thread.projectId)
      projectName = project?.name ?? ''
    } catch (error) {
      Logger.dev('Notification project name resolution failed:', error)
    }

    const payload = this.temporaryChatPayload(
      thread,
      temporaryChatId,
      kind,
      projectName || APP_NAME
    )
    const windows = BrowserWindow.getAllWindows()
    for (const window of windows) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        sendToRenderer(window.webContents, 'notification:show', payload)
      }
    }
    forwardRemoteEvent('notification:show', payload)

    if (windows.some((window) => window.isFocused())) return
    this.dispatchNotificationSound(windows)
    const silent = this.appManagesSound(windows)
    if (!Notification.isSupported()) {
      if (!this.unsupportedLogged) {
        this.unsupportedLogged = true
        Logger.error('System notifications are not supported on this device.')
      }
      return
    }

    try {
      const notification = new Notification({
        id: payload.id,
        groupId: `${APP_SLUG}-${thread.projectId}`,
        title: payload.title,
        subtitle: projectName || APP_NAME,
        body: payload.body,
        urgency: payload.kind === 'error' ? 'critical' : 'normal',
        silent
      })

      notification.on('click', (): void => {
        this.onThreadClicked({
          projectId: thread.projectId,
          threadId: thread.id
        })
      })
      notification.on('show', (): void => {
        this.recordNotificationOutcome('shown')
        Logger.info('Temporary chat system notification shown', {
          kind: payload.kind,
          projectId: thread.projectId,
          threadId: thread.id,
          temporaryChatId
        })
      })
      notification.on('failed', (_event, error): void => {
        this.recordNotificationOutcome('failed', error)
        Logger.error('Temporary chat system notification failed:', error)
      })

      this.retainNotification(`${threadKey}:temp:${temporaryChatId}`, notification)
      notification.show()
    } catch (error) {
      Logger.error('Temporary chat notification could not be shown:', error)
    }
  }

  async sendTestNotification(): Promise<SystemNotificationTestResult> {
    this.dispatchNotificationSound()
    const silent = this.appManagesSound()
    if (!Notification.isSupported()) {
      return {
        status: 'unsupported',
        message: 'System notifications are not supported on this device.'
      }
    }

    return new Promise((resolve) => {
      const notification = new Notification({
        id: `${APP_SLUG}-notification-test`,
        groupId: `${APP_SLUG}-system`,
        title: `${APP_NAME} notifications`,
        body: 'You will be notified when an agent finishes, needs attention, or encounters an error.',
        silent
      })
      let settled = false
      const finish = (result: SystemNotificationTestResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(result)
      }
      // No state change on timeout: the OS neither confirmed nor refused the
      // delivery (the first-time permission prompt may still be on screen),
      // so a slow test must never poison the persisted permission state.
      const timeout = setTimeout(() => {
        finish({
          status: 'failed',
          message:
            'macOS did not confirm delivery. Notifications are likely blocked — allow them in System Settings > Notifications (unsigned builds also require app signing).'
        })
      }, 8_000)

      notification.once('show', () => {
        this.recordNotificationOutcome('shown')
        finish({
          status: 'shown',
          message: 'Test notification sent. System notifications are ready.'
        })
      })
      notification.once('failed', (_event, error) => {
        this.recordNotificationOutcome('failed', error)
        Logger.error('System notification test failed:', error)
        finish({
          status: 'failed',
          message:
            'macOS rejected the notification. Allow notifications in System Settings > Notifications.'
        })
      })

      this.retainNotification('system-test', notification)
      try {
        notification.show()
      } catch (error) {
        Logger.error('System notification test could not be shown:', error)
        finish({
          status: 'failed',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    })
  }

  private notificationPayload(thread: Thread, projectName: string): AgentNotificationPayload {
    const kind: AgentNotificationKind =
      thread.status === 'completed'
        ? 'completed'
        : thread.status === 'awaiting_approval'
          ? 'attention'
          : 'error'
    const title =
      kind === 'completed'
        ? 'Agent turn complete'
        : kind === 'attention'
          ? 'Agent needs your attention'
          : 'Agent encountered an error'
    const body =
      kind === 'completed'
        ? `${thread.title} finished in ${projectName}.`
        : kind === 'attention'
          ? `${thread.title} is waiting for your input in ${projectName}.`
          : `${thread.title} stopped with an error in ${projectName}.`

    return {
      id: `${APP_SLUG}-${thread.projectId}-${thread.id}-${thread.status}-${thread.updatedAt}`,
      kind,
      title,
      body,
      projectId: thread.projectId,
      threadId: thread.id
    }
  }

  private temporaryChatPayload(
    thread: Thread,
    temporaryChatId: string,
    kind: Extract<AgentNotificationKind, 'completed' | 'error'>,
    projectName: string
  ): AgentNotificationPayload {
    const title = kind === 'completed' ? 'Side chat complete' : 'Side chat failed'
    const body =
      kind === 'completed'
        ? `${thread.title} — your side chat is ready in ${projectName}.`
        : `${thread.title} — your side chat stopped with an error in ${projectName}.`
    return {
      id: `${APP_SLUG}-${thread.projectId}-${thread.id}-temp-${temporaryChatId}-${Date.now()}`,
      kind,
      title,
      body,
      projectId: thread.projectId,
      threadId: thread.id
    }
  }

  /**
   * The app plays its own audible alert (`alert.wav`) from the renderer, so the
   * OS notification must never add its default sound: as long as a renderer is
   * alive the app owns audio and the OS notification is shown silent. Without a
   * live renderer the OS notification falls back to its own sound.
   */
  private appManagesSound(windows = BrowserWindow.getAllWindows()): boolean {
    return windows.some((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
  }

  /**
   * Dispatch the custom audible alert for a notification. Only the first
   * notification of a burst plays: notifications arriving within the dedup
   * window after the last played sound still show their cards but stay quiet.
   * The gate lives here in the main process — not the throttled renderer — so
   * the decision is deterministic and the first sound is dispatched the moment
   * its notification arrives, instead of seconds after the OS card appears.
   */
  private dispatchNotificationSound(windows = BrowserWindow.getAllWindows()): boolean {
    const soundWindow = windows.find(
      (window) => !window.isDestroyed() && !window.webContents.isDestroyed()
    )
    if (!soundWindow) return false

    const now = Date.now()
    if (now - this.lastNotificationSoundPlayedAt < NOTIFICATION_SOUND_DEDUP_MS) return false
    this.lastNotificationSoundPlayedAt = now

    return sendToRenderer(soundWindow.webContents, 'notification:playSound')
  }

  private retainNotification(key: string, notification: Notification): void {
    this.activeNotifications.set(key, notification)
    const release = (): void => {
      if (this.activeNotifications.get(key) === notification) {
        this.activeNotifications.delete(key)
      }
    }
    notification.once('close', release)
    notification.once('failed', release)

    while (this.activeNotifications.size > MAX_RETAINED_NOTIFICATIONS) {
      const oldestKey = this.activeNotifications.keys().next().value
      if (typeof oldestKey !== 'string') break
      this.activeNotifications.delete(oldestKey)
    }
  }
}
