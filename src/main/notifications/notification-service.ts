import { app, BrowserWindow, Notification, shell } from 'electron'
import { createHash } from 'node:crypto'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { requireString } from '../ipc/handlers/shared'
import { NotificationInboxStore } from './notification-inbox-store'
import { APP_NAME, APP_SLUG } from '../../lib/brand'
import { Logger } from '../system/logger'
import { sendToRenderer } from '../ipc/renderer-delivery'
import type { StorageEngine } from '../storage/storage-engine'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { AssignmentRepo } from '../database/repositories/assignment-repo'
import { RoutineRepo } from '../database/repositories/routine-repo'
import {
  ASSISTANT_SPACE_ID,
  GLOBAL_BROWSER_PROJECT_ID,
  INBOX_PROJECT_ID,
  isAssistantRunThread,
  isAssistantSetupThread,
  isOrchestrationChildThread,
  type Thread,
  type ThreadStatus
} from '../../lib/types'
import { THREAD_STATUSES, threadStatusPolicy } from '../../lib/thread-status-policy'
import {
  NOTIFICATION_SOUND_DEDUP_MS,
  notificationSoundKind,
  type AgentNotificationKind,
  type AgentNotificationPayload,
  type NotificationSoundKind,
  type NotificationSource,
  type PersistedAgentNotification,
  type SystemNotificationPermissionStatus,
  type SystemNotificationTestResult,
  type ThreadClickedPayload
} from '../../lib/ipc-contract'

const NOTIFIABLE_STATUSES: ReadonlySet<ThreadStatus> = new Set(
  THREAD_STATUSES.filter((status) => threadStatusPolicy(status).notificationKind !== undefined)
)
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
/**
 * Windows rejects notification ids longer than 64 UTF-16 characters, and full
 * payload ids (`slug-projectId-threadId-status-updatedAt`) easily exceed that.
 * Keep a readable prefix and append a short deterministic hash of the full id
 * so distinct payloads never collide while the result always fits.
 */
const NOTIFICATION_ID_MAX_UTF16 = 64
function compactNotificationId(id: string): string {
  if ([...id].length <= NOTIFICATION_ID_MAX_UTF16) return id
  const hash = createHash('sha256').update(id).digest('base64url').slice(0, 12)
  const prefix = id.slice(0, NOTIFICATION_ID_MAX_UTF16 - hash.length - 1)
  return `${prefix}-${hash}`
}

function isPermissionRefusal(error: unknown): boolean {
  return typeof error === 'string' && /not allowed/i.test(error)
}

/** One operating-system notification that did not come from a chat thread (a
 *  browser extension's `chrome.notifications`, for instance). `id` is the
 *  caller's namespaced key, used to retain, update and dismiss the card. */
export interface ExternalNotificationOptions {
  id: string
  title: string
  message: string
  silent?: boolean
  onClick?: () => void
  onClose?: () => void
}

/**
 * The live notification service, when one is running. Browser extension
 * notifications do not originate in the chat pipeline, so the extension service
 * reaches the app's notifier through this accessor rather than standing up a
 * second OS notification mechanism of its own.
 */
let currentNotificationService: NotificationService | null = null

function setCurrentNotificationService(service: NotificationService | null): void {
  currentNotificationService = service
}

export function getNotificationService(): NotificationService | null {
  return currentNotificationService
}

export class NotificationService {
  private readonly storage: StorageEngine
  private readonly projectRepo: ProjectRepo
  private readonly threadRepo: ThreadRepo
  private readonly assignmentRepo: AssignmentRepo
  private readonly routineRepo: RoutineRepo
  private readonly inbox: NotificationInboxStore
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
  /**
   * The one durable-inbox read for this service's lifetime. Both `start` and the
   * `notification:listInbox` handler await it, and both may run in either order
   * (the renderer can boot before the deferred start does), so it is memoized
   * rather than issued twice against the same file.
   */
  private inboxLoad: Promise<void> | undefined

  constructor(storage: StorageEngine, db: Database, onThreadClicked: ThreadClickedHandler) {
    this.storage = storage
    this.projectRepo = new ProjectRepo(db)
    this.threadRepo = new ThreadRepo(db)
    this.assignmentRepo = new AssignmentRepo(db)
    this.routineRepo = new RoutineRepo(db)
    this.inbox = new NotificationInboxStore(storage)
    this.onThreadClicked = onThreadClicked

    // Register IPC handlers eagerly: the renderer's settings panel can query
    // the permission status on mount before start() runs (start is deferred
    // until after first paint, but the renderer may boot faster).
    ipcMain.handle('notification:test', () => this.sendTestNotification())
    ipcMain.handle('notification:getPermissionStatus', () => this.getVerifiedPermissionStatus())
    ipcMain.handle('notification:openSettings', () => this.openSettings())
    // The inbox channels sit beside the permission ones because they are the
    // same subject from the renderer's side: what the notification surfaces
    // still owe it. They are registered here, not under a handler registrar,
    // because the store is owned by this service rather than by the database.
    ipcMain.handle('notification:listInbox', async () => {
      // A window can be created before the restore lands (the renderer may boot
      // faster than the deferred start), so await it rather than answering from
      // an empty store and leaving the panel blank for the rest of the session.
      await this.inboxReady()
      return { notifications: this.inbox.list(), dismissed: this.inbox.dismissedIds() }
    })
    // Every mutating channel awaits the restore first. `load` clears what it
    // holds before reading the file, so a dismissal that landed ahead of it
    // would be wiped and the entry handed straight back to the next window.
    ipcMain.handle('notification:dismissInbox', async (_, id: unknown) => {
      const notificationId = requireString(id, 'Notification ID').slice(0, 300)
      await this.inboxReady()
      this.inbox.dismiss(notificationId)
    })
    ipcMain.handle(
      'notification:dismissInboxForThread',
      async (_, projectId: unknown, threadId: unknown) => {
        const project = requireString(projectId, 'Project ID').slice(0, 200)
        const thread = requireString(threadId, 'Thread ID').slice(0, 200)
        await this.inboxReady()
        this.inbox.dismissForThread(project, thread)
      }
    )
    ipcMain.handle('notification:clearInbox', async (_, family: unknown) => {
      if (
        family !== undefined &&
        family !== null &&
        family !== 'project' &&
        family !== 'chat' &&
        family !== 'assistant'
      ) {
        throw new TypeError('Notification family is invalid')
      }
      await this.inboxReady()
      if (family === undefined || family === null) this.inbox.clear()
      else this.inbox.clear(family)
    })
  }

  /** Resolves once the durable inbox has been read, at most once per service. */
  private inboxReady(): Promise<void> {
    this.inboxLoad ??= this.inbox.load()
    return this.inboxLoad
  }

  start(): void {
    if (this.started) return
    this.started = true
    setCurrentNotificationService(this)
    void this.inboxReady()
    void this.hydrateBadge()
    void this.hydratePermissionStatus()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (getNotificationService() === this) setCurrentNotificationService(null)
    this.lastObservedStatus.clear()
    this.activeNotifications.clear()
    this.badgeThreads.clear()
    this.updateBadge()
    // Drain the durable inbox before the process goes away: a dismissal the user
    // just made must not come back on the next launch, and the write chain is
    // asynchronous, so this is the last point at which it can be awaited.
    void this.inbox.flush()
    ipcMain.removeHandler('notification:test')
    ipcMain.removeHandler('notification:getPermissionStatus')
    ipcMain.removeHandler('notification:openSettings')
    ipcMain.removeHandler('notification:listInbox')
    ipcMain.removeHandler('notification:dismissInbox')
    ipcMain.removeHandler('notification:dismissInboxForThread')
    ipcMain.removeHandler('notification:clearInbox')
  }

  /**
   * Record the outcome of a native notification delivery. Electron has no
   * notification-permission query API on macOS, so the OS delivery events are
   * the authoritative signal: a shown notification implies permission, a
   * refused one implies the app is blocked (permission denied or unsigned).
   * Only a refusal error (`UNErrorNotAllowed`   "not allowed") marks the state
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
   * permission prompt pending (fresh install), the request re-prompts   which
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
      body: 'You will be notified when an agent finishes, has a specification ready, needs attention, or encounters an error.',
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
   * 'prompt' means the OS has not delivered nor refused yet   the first
   * notification (or the Settings test) will decide it. Exposed so the UI can
   * warn when notifications are blocked and deep-link into System Settings.
   * While 'denied', every query re-verifies against the OS so the warning
   * clears as soon as the user re-enables notifications   it can never stay
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
   * Whether any app window currently has OS focus. While the app is in the
   * background the renderer can still mark a thread read (e.g. the thread that
   * happens to be selected auto-marks itself read when a live update arrives),
   * which would otherwise close an OS notification the user has not even seen
   * yet   leaving only the alert sound with no card.
   */
  private appFocused(): boolean {
    return BrowserWindow.getAllWindows().some((window) => window.isFocused())
  }

  /**
   * Dismiss every delivered notification for a thread   closes its OS
   * notifications (including side-chat notifications piped through it) and
   * drops the thread from the app-icon badge. Called whenever the thread is
   * marked read or deleted so the OS notification center stays in sync with
   * in-app state.
   *
   * Closing the OS notification cards is skipped while the app is unfocused:
   * a background auto-mark-read must never retract a notification the user
   * has not seen. The badge, however, always updates regardless of focus:
   * it is a count of unread threads and must stay in sync with the DB even
   * when the read/delete happens in the background, otherwise the badge
   * stays stale until the next restart.
   */
  dismissForThread(projectId: string, threadId: string): void {
    const threadKey = `${projectId}:${threadId}`

    if (this.badgeThreads.delete(threadKey)) {
      this.updateBadge()
    }

    // The durable inbox drops the thread's entries here too, and unconditionally.
    // This hook is how a thread reports that it was read or deleted, which is
    // the same acknowledgement the panel itself reconciles on; a store that kept
    // the entry would hand it back to the next window that asked, undoing the
    // dismissal the user just made by reading the thread.
    void this.inboxReady().then(() => this.inbox.dismissForThread(projectId, threadId))

    if (!this.appFocused()) return
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
      const threads = await this.threadRepo.listAllViaWorker()
      const validKeys = new Set<string>()
      for (const thread of threads) {
        // A failure is durable evidence of an unattended run: badge it so the
        // app icon counts a run that failed while no window was open. `failed`
        // already carries the `error` notification kind (so it is in
        // NOTIFIABLE_STATUSES); naming it here keeps the durable-failure
        // guarantee from silently regressing if that map changes.
        const isDurableFailure = thread.status === 'failed'
        if (
          (isDurableFailure || NOTIFIABLE_STATUSES.has(thread.status)) &&
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
    // A browser tab's assistant conversation is answered beside the page it is
    // about, so a settled turn there is never something the user has to be told
    // about while they are looking elsewhere. That was already true of the side
    // chat it replaced, and it stays true of the thread it is now. A thread
    // parked on the user is the exception and always notifies: it can only be
    // waiting because they moved on, and the conversation they left behind has
    // no other surface to ask them from, so staying silent made an agent
    // question indistinguishable from an idle tab.
    if (thread.projectId === GLOBAL_BROWSER_PROJECT_ID && thread.status !== 'awaiting_approval') {
      return
    }
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
    // A thread that transitions straight from `failed` to `completed`   without
    // an intervening working status   is reporting a stale/wrong success: the
    // turn never actually re-ran (a fresh run would pass through executing or
    // planning). Emitting a "done" notification right after an error one is
    // exactly the misleading double-notify users have reported, so suppress it.
    if (thread.status === 'completed' && previous === 'failed') return

    let projectName = ''
    let projectColor: string | undefined
    try {
      const project = await this.projectRepo.getViaWorker(thread.projectId)
      projectName = project?.name ?? ''
      projectColor = project?.color
    } catch (error) {
      Logger.dev('Notification project name resolution failed:', error)
    }

    if (this.lastObservedStatus.get(threadKey) !== thread.status) return

    const payload = await this.notificationPayload(
      thread,
      projectName || APP_NAME,
      projectColor,
      this.notificationSource(thread)
    )
    await this.deliverNotification(payload, {
      retainKey: threadKey,
      badgeThreadKey: threadKey,
      clickPayload: { projectId: thread.projectId, threadId: thread.id },
      logLabel: 'Thread'
    })
  }

  /**
   * One shared delivery path for every notification kind: record it durably,
   * broadcast the payload to all renderers, then show the OS notification when
   * the app is not focused.
   *
   * The durable write comes first and is deliberately not awaited: it is the
   * record of what the panel owes the user across a restart, and it must not be
   * able to stall the toast and the OS card that are the surfaces the user is
   * looking at right now.
   */
  private async deliverNotification(
    payload: AgentNotificationPayload,
    options: {
      retainKey: string
      /** Set when the notification should badge the app icon (regular thread notifications only). */
      badgeThreadKey?: string
      clickPayload: ThreadClickedPayload
      logLabel: string
    }
  ): Promise<void> {
    void this.inboxReady().then(() =>
      this.inbox.add({ ...payload, timestamp: Date.now() } satisfies PersistedAgentNotification)
    )
    const subtitle = payload.source === 'chat' ? 'Chat' : payload.projectName
    const windows = BrowserWindow.getAllWindows()
    for (const window of windows) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        sendToRenderer(window.webContents, 'notification:show', payload)
      }
    }
    if (options.badgeThreadKey) this.markThreadNotified(options.badgeThreadKey)

    // The alert announces the notification on whichever surface actually reaches
    // the user. While the app is in the background that is the OS card, and the
    // full-volume alert is dispatched from here. While the app is in front the
    // card is suppressed and the renderer plays the quieter in-app alert itself,
    // at the moment it shows the toast, so a suppressed toast stays silent.
    const focused = this.appFocused()
    if (focused) return

    this.dispatchNotificationSound(notificationSoundKind(payload.kind, payload.projectId), windows)

    this.showNativeNotification({
      id: payload.id,
      title: payload.title,
      subtitle,
      body: payload.body,
      urgency: payload.kind === 'error' ? 'critical' : 'normal',
      silent: this.appManagesSound(windows),
      retainKey: options.retainKey,
      logLabel: options.logLabel,
      logContext: { kind: payload.kind, projectId: payload.projectId, threadId: payload.threadId },
      onClick: (): void => this.onThreadClicked(options.clickPayload)
    })
  }

  /**
   * Create, show and retain one native OS notification, recording the delivery
   * outcome into the macOS permission state. Shared by the thread path and the
   * external (browser extension) path, so neither re-implements the permission
   * bookkeeping, the id compaction or the retention.
   */
  private showNativeNotification(options: {
    id: string
    title: string
    subtitle?: string
    body: string
    urgency: 'normal' | 'critical'
    silent: boolean
    retainKey: string
    logLabel: string
    logContext?: Record<string, unknown>
    onClick?: () => void
    onClose?: () => void
  }): void {
    if (!Notification.isSupported()) {
      if (!this.unsupportedLogged) {
        this.unsupportedLogged = true
        Logger.error('System notifications are not supported on this device.')
      }
      return
    }

    try {
      const notification = new Notification({
        id: compactNotificationId(options.id),
        groupId: compactNotificationId(options.id),
        title: options.title,
        ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
        body: options.body,
        urgency: options.urgency,
        silent: options.silent
      })

      if (options.onClick) notification.on('click', options.onClick)
      if (options.onClose) notification.on('close', options.onClose)
      notification.on('show', (): void => {
        this.recordNotificationOutcome('shown')
        Logger.info(`${options.logLabel} system notification shown`, options.logContext ?? {})
      })
      notification.on('failed', (_event, error): void => {
        this.recordNotificationOutcome('failed', error)
        Logger.error(`${options.logLabel} system notification failed:`, error)
      })

      this.retainNotification(options.retainKey, notification)
      notification.show()
    } catch (error) {
      Logger.error(`${options.logLabel} notification could not be shown:`, error)
    }
  }

  /**
   * Show one operating-system notification for a message that did not come from
   * a chat thread, such as a browser extension's `chrome.notifications.create`.
   *
   * There is no in-app toast surface for such a message, so unlike the thread
   * path this always reaches the OS card (focus is not a reason to drop it), and
   * only the caller's own `silent` flag keeps it quiet. Everything else is the
   * shared native delivery: the same permission bookkeeping, retention and id
   * compaction.
   */
  notifyExternal(options: ExternalNotificationOptions): void {
    if (!this.started) return
    this.showNativeNotification({
      id: options.id,
      title: options.title,
      body: options.message,
      urgency: 'normal',
      silent: options.silent === true,
      retainKey: options.id,
      logLabel: 'External',
      onClick: options.onClick,
      onClose: options.onClose
    })
  }

  /**
   * Close one external OS notification by its namespaced id. Listeners are
   * detached first, so an extension clearing its own notification never reports
   * the close back to itself as a user action.
   */
  dismissExternal(id: string): void {
    const notification = this.activeNotifications.get(id)
    if (!notification) return
    this.activeNotifications.delete(id)
    notification.removeAllListeners('close')
    notification.removeAllListeners('click')
    try {
      notification.close()
    } catch (error) {
      Logger.dev('External OS notification close failed:', error)
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
    kind: Extract<AgentNotificationKind, 'completed' | 'error'>,
    errorDetail?: string
  ): Promise<void> {
    if (!this.started) return

    const threadKey = `${thread.projectId}:${thread.id}`
    if (this.abortingThreads.has(threadKey)) return
    // Side chats piped through a worker or auditor parent thread stay quiet in
    // Achievement/Assignment mode; only the Sr. Engineer thread notifies.
    if (this.isSuppressedOrchestration(thread)) return

    let projectName = ''
    let projectColor: string | undefined
    try {
      const project = await this.projectRepo.getViaWorker(thread.projectId)
      projectName = project?.name ?? ''
      projectColor = project?.color
    } catch (error) {
      Logger.dev('Notification project name resolution failed:', error)
    }

    const payload = this.temporaryChatPayload(
      thread,
      temporaryChatId,
      kind,
      projectName || APP_NAME,
      projectColor,
      errorDetail
    )
    await this.deliverNotification(payload, {
      retainKey: `${threadKey}:temp:${temporaryChatId}`,
      clickPayload: { projectId: thread.projectId, threadId: thread.id, temporaryChatId },
      logLabel: 'Temporary chat'
    })
  }

  /**
   * Notify that an independent (spec-less) audit finished, piped through the
   * coordinator thread's notification channel. The coordinator's own status
   * never changes when its auditor finishes (the auditor is a suppressed
   * orchestration child), so this mirrors the temporary-chat path with a
   * payload that still references the coordinator thread.
   */
  async notifyIndependentAudit(
    thread: Thread,
    kind: Extract<AgentNotificationKind, 'completed' | 'error'>,
    errorDetail?: string
  ): Promise<void> {
    if (!this.started) return

    const threadKey = `${thread.projectId}:${thread.id}`
    if (this.abortingThreads.has(threadKey)) return
    // Audits piped through a worker or auditor parent thread stay quiet in
    // Achievement/Assignment mode; only the Sr. Engineer thread notifies.
    if (this.isSuppressedOrchestration(thread)) return

    let projectName = ''
    let projectColor: string | undefined
    try {
      const project = await this.projectRepo.getViaWorker(thread.projectId)
      projectName = project?.name ?? ''
      projectColor = project?.color
    } catch (error) {
      Logger.dev('Notification project name resolution failed:', error)
    }

    const payload = this.independentAuditPayload(
      thread,
      kind,
      projectName || APP_NAME,
      projectColor,
      errorDetail
    )
    await this.deliverNotification(payload, {
      retainKey: `${threadKey}:independent-audit`,
      clickPayload: { projectId: thread.projectId, threadId: thread.id },
      logLabel: 'Independent audit'
    })
  }

  async sendTestNotification(): Promise<SystemNotificationTestResult> {
    // The test exercises the OS card path, so it always uses the full-volume
    // off-app alert regardless of which window is focused.
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
            'macOS did not confirm delivery. Notifications are likely blocked   allow them in System Settings > Notifications (unsigned builds also require app signing).'
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

  /** The source a thread's notification is routed under: the inbox is a chat,
   *  the assistant space is its own tab, everything else is a project. */
  private notificationSource(thread: Thread): NotificationSource {
    if (thread.projectId === INBOX_PROJECT_ID) return 'chat'
    if (thread.projectId === ASSISTANT_SPACE_ID) return 'assistant'
    return 'project'
  }

  /** Resolve the user-facing assistant task or routine title without holding
   *  the main thread on synchronous SQLite reads. */
  private async assistantCompletionName(thread: Thread): Promise<string> {
    if (isAssistantSetupThread(thread)) return ''
    try {
      if (isAssistantRunThread(thread) && thread.assistantTaskId) {
        const task = await this.threadRepo.getViaWorker(thread.assistantTaskId)
        if (task && !isAssistantSetupThread(task) && task.title.trim()) return task.title.trim()
      }
      if (thread.routineId) {
        const routineName = (await this.routineRepo.getViaWorker(thread.routineId))?.name.trim()
        if (routineName) return routineName
      }
      return thread.title.trim()
    } catch (error) {
      Logger.dev('Notification assistant task name resolution failed:', error)
      return thread.title.trim()
    }
  }

  private async notificationPayload(
    thread: Thread,
    projectName: string,
    projectColor: string | undefined,
    source: NotificationSource
  ): Promise<AgentNotificationPayload> {
    const kind: AgentNotificationKind =
      threadStatusPolicy(thread.status).notificationKind ?? 'error'
    const isAssistant = source === 'assistant'
    const displayName = source === 'chat' ? 'Chat' : isAssistant ? 'Assistant' : projectName
    // Name assistant completions after the task or routine the user recognizes.
    const completionName =
      isAssistant && kind === 'completed' ? await this.assistantCompletionName(thread) : ''
    const title =
      kind === 'completed'
        ? completionName
          ? completionName
          : `${displayName} Done`
        : kind === 'attention'
          ? `${displayName} needs attention`
          : kind === 'spec'
            ? `${displayName} spec is ready`
            : `${displayName} hit an error`
    // Error notifications carry the real failure: the engine records the
    // diagnostic text on the thread when it marks it `failed`, so the panel can
    // show what went wrong instead of a generic label. Only the first line is
    // user-facing prose; the full text (including any stack/raw detail) rides
    // on `errorDetail` for display and copy actions.
    const lastError = kind === 'error' ? thread.lastError?.trim() || undefined : undefined
    const errorHeadline = lastError?.split('\n', 1)[0]?.trim() || undefined
    const errorBody =
      errorHeadline === undefined
        ? undefined
        : errorHeadline.length > 240
          ? `${errorHeadline.slice(0, 240).trimEnd()}…`
          : errorHeadline
    // An assistant run says what it did; naming the hidden assistant space as
    // the project it "finished in" would read as a project thread.
    const body =
      kind === 'completed'
        ? completionName
          ? `${completionName} finished.`
          : isAssistant
            ? `${thread.title} finished.`
            : `${thread.title} finished in ${projectName}.`
        : kind === 'attention'
          ? isAssistant
            ? `${thread.title} is waiting for your input.`
            : `${thread.title} is waiting for your input in ${projectName}.`
          : kind === 'spec'
            ? isAssistant
              ? `${thread.title} has a reviewable engineering artifact ready.`
              : `${thread.title} has a reviewable engineering artifact ready in ${projectName}.`
            : (errorBody ??
              (isAssistant
                ? `${thread.title} stopped with an error.`
                : `${thread.title} stopped with an error in ${projectName}.`))

    return {
      id: `${APP_SLUG}-${thread.projectId}-${thread.id}-${thread.status}-${thread.updatedAt}`,
      kind,
      title,
      body,
      ...(lastError ? { errorDetail: lastError } : {}),
      projectId: thread.projectId,
      threadId: thread.id,
      source,
      projectName,
      projectColor
    }
  }

  private temporaryChatPayload(
    thread: Thread,
    temporaryChatId: string,
    kind: Extract<AgentNotificationKind, 'completed' | 'error'>,
    projectName: string,
    projectColor: string | undefined,
    errorDetail?: string
  ): AgentNotificationPayload {
    const notificationKind: AgentNotificationKind =
      kind === 'completed' ? 'chat-completed' : 'error'
    const title = kind === 'completed' ? 'Chat response available' : 'Chat response failed'
    const trimmedDetail = errorDetail?.trim() || undefined
    const headline = trimmedDetail?.split('\n', 1)[0]?.trim() || undefined
    const body =
      kind === 'completed'
        ? `${thread.title}   your chat response is ready in ${projectName}.`
        : (headline ??
          `${thread.title}   your chat response stopped with an error in ${projectName}.`)
    return {
      id: `${APP_SLUG}-${thread.projectId}-${thread.id}-temp-${temporaryChatId}-${Date.now()}`,
      kind: notificationKind,
      title,
      body,
      ...(kind === 'error' && trimmedDetail ? { errorDetail: trimmedDetail } : {}),
      projectId: thread.projectId,
      threadId: thread.id,
      temporaryChatId,
      source: 'temporary-chat',
      projectName,
      projectColor
    }
  }

  /** Payload for an independent audit completion piped through the coordinator thread. */
  private independentAuditPayload(
    thread: Thread,
    kind: Extract<AgentNotificationKind, 'completed' | 'error'>,
    projectName: string,
    projectColor: string | undefined,
    errorDetail?: string
  ): AgentNotificationPayload {
    const title = kind === 'completed' ? 'Independent audit ready' : 'Independent audit failed'
    const trimmedDetail = errorDetail?.trim() || undefined
    const headline = trimmedDetail?.split('\n', 1)[0]?.trim() || undefined
    const body =
      kind === 'completed'
        ? `${thread.title}: the audit report is ready in ${projectName}.`
        : (headline ?? `${thread.title}: the audit stopped with an error in ${projectName}.`)
    return {
      id: `${APP_SLUG}-${thread.projectId}-${thread.id}-independent-audit-${Date.now()}`,
      kind,
      title,
      body,
      ...(kind === 'error' && trimmedDetail ? { errorDetail: trimmedDetail } : {}),
      projectId: thread.projectId,
      threadId: thread.id,
      source: 'project',
      projectName,
      projectColor
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
   * Dispatch the off-app audible alert for a notification. Only the first alert
   * of a burst plays: notifications arriving within the dedup window after the
   * last played sound still show their OS card but stay quiet. The gate lives
   * here in the main process, not the throttled renderer, so the decision is
   * deterministic and the first sound is dispatched the moment its notification
   * arrives, instead of seconds after the OS card appears.
   *
   * This covers the background surface only. While the app is in front the
   * renderer plays its own in-app alert from the toast path, under the same
   * dedup window and the user's mute preference.
   */
  private dispatchNotificationSound(
    kind: NotificationSoundKind = 'default',
    windows = BrowserWindow.getAllWindows()
  ): boolean {
    const soundWindow = windows.find(
      (window) => !window.isDestroyed() && !window.webContents.isDestroyed()
    )
    if (!soundWindow) return false

    const now = Date.now()
    if (now - this.lastNotificationSoundPlayedAt < NOTIFICATION_SOUND_DEDUP_MS) return false
    this.lastNotificationSoundPlayedAt = now

    // The window is throttled while it is occluded, which is the normal state
    // whenever the user is in another app, and this alert exists exactly for
    // that case. Lift throttling for the dispatch so the alert lands with the OS
    // card instead of after Chromium's next throttled turn, then let the window
    // fall back to throttled once the alert has had time to play.
    try {
      soundWindow.webContents.setBackgroundThrottling(false)
      const restore = setTimeout(() => {
        if (soundWindow.isDestroyed() || soundWindow.webContents.isDestroyed()) return
        soundWindow.webContents.setBackgroundThrottling(true)
      }, NOTIFICATION_SOUND_DEDUP_MS)
      restore.unref()
    } catch (error) {
      // Throttling control is best effort; the alert still dispatches.
      Logger.dev('Could not lift background throttling for the notification alert:', error)
    }

    return sendToRenderer(soundWindow.webContents, 'notification:playSound', kind)
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
