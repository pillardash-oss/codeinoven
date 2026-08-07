/**
 * Phone-side notification bridge.
 *
 * The desktop's notification service pushes `notification:show` to its own
 * windows; the remote bridge forwards that same event to every connected phone.
 * This store subscribes to it and does two things:
 *
 * 1. Feeds the in-app notification panel (the same store the desktop shell
 *    uses), so the phone always shows attention items even without OS
 *    permission.
 * 2. When the user has opted in and the browser granted notification
 *    permission, shows a system notification through the service worker. Tapping
 *    it posts a `notification:open` message back to the focused client, which
 *    the shell listens for and routes to the thread.
 *
 * The switch in the shell's notifications sheet drives `enabled`; the browser's
 * own prompt gates `permission`. Both must hold for a system notification to
 * appear.
 */

import type { AgentNotificationPayload } from '$shared/ipc-contract'
import { remoteBridge } from './remote-bridge'
import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
import { remoteLog } from './logger'

const ENABLED_KEY = 'codeinoven.remote.notificationsEnabled'
const APP_SLUG = 'codeinoven'

export type MobileNotificationPermission = NotificationPermission | 'unsupported'

export type OpenNotificationHandler = (projectId: string, threadId: string) => void

class MobileNotifications {
  /** User opt-in — persisted so it survives reloads. */
  enabled = $state(false)
  /** Browser permission for this origin; `unsupported` off the PWA. */
  permission = $state<MobileNotificationPermission>('default')
  private openHandler: OpenNotificationHandler | null = null
  private unsub: (() => void) | null = null

  constructor() {
    this.enabled = this.readEnabled()
    this.permission = this.detectPermission()
  }

  /** Subscribe to the bridge's `notification:show` stream (idempotent). */
  init(): void {
    if (this.unsub) return
    this.unsub = remoteBridge.on('notification:show', (payload: unknown) => {
      this.handle(payload as AgentNotificationPayload)
    })
  }

  /** The shell registers how a tapped notification should open a thread. */
  setOpenHandler(handler: OpenNotificationHandler | null): void {
    this.openHandler = handler
  }

  /**
   * Turn system notifications on: requests the browser permission if it is
   * still undecided, then persists the opt-in. Returns the resulting state.
   */
  async enable(): Promise<MobileNotificationPermission> {
    if (typeof Notification === 'undefined') {
      this.permission = 'unsupported'
      this.enabled = false
      return this.permission
    }
    if (this.permission === 'default') {
      this.permission = await Notification.requestPermission()
    }
    if (this.permission === 'granted') {
      this.enabled = true
      this.persist(true)
    }
    return this.permission
  }

  /** Turn system notifications off without touching the browser permission. */
  disable(): void {
    this.enabled = false
    this.persist(false)
  }

  private handle(payload: AgentNotificationPayload): void {
    if (!payload || typeof payload !== 'object') return
    notificationPanelState.add(payload)
    if (!this.enabled || this.permission !== 'granted') return
    void this.showSystemNotification(payload)
  }

  private async showSystemNotification(payload: AgentNotificationPayload): Promise<void> {
    try {
      const registration = await navigator.serviceWorker.ready
      registration.showNotification(payload.title, {
        body: payload.body,
        tag: payload.id,
        data: { projectId: payload.projectId, threadId: payload.threadId },
        icon: './icon.png',
        badge: './icon.png'
      })
    } catch (error) {
      remoteLog.error(`Phone system notification failed: ${String(error)}`)
    }
  }

  /** Route a service-worker `notification:open` message to the shell. */
  routeOpen(projectId: string, threadId: string): void {
    this.openHandler?.(projectId, threadId)
  }

  private readEnabled(): boolean {
    try {
      return localStorage.getItem(ENABLED_KEY) === '1'
    } catch {
      return false
    }
  }

  private persist(enabled: boolean): void {
    try {
      if (enabled) localStorage.setItem(ENABLED_KEY, '1')
      else localStorage.removeItem(ENABLED_KEY)
    } catch {
      // best-effort
    }
  }

  private detectPermission(): MobileNotificationPermission {
    if (typeof Notification === 'undefined') return 'unsupported'
    return Notification.permission
  }
}

export const mobileNotifications = new MobileNotifications()

/** Stable identifier used to recognise our own notifications in the SW. */
export function notificationSourceTag(): string {
  return `${APP_SLUG}-notification`
}
