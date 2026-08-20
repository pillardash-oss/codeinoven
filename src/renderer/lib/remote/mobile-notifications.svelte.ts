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
import { toast } from 'svelte-sonner'
import { remoteBridge } from './remote-bridge'
import { remoteLog } from './logger'

const ENABLED_KEY = 'codeinoven.remote.notificationsEnabled'
const ASKED_KEY = 'codeinoven.remote.notificationsAsked'
const APP_SLUG = 'codeinoven'

export type MobileNotificationPermission = NotificationPermission | 'unsupported'

export type OpenNotificationHandler = (projectId: string, threadId: string) => void

/** `renotify` is a real Web Notification option absent from this project's lib.dom. */
interface ReplacingNotificationOptions extends NotificationOptions {
  renotify?: boolean
}

class MobileNotifications {
  /** User opt-in — persisted so it survives reloads. */
  enabled = $state(false)
  /** Browser permission for this origin; `unsupported` off the PWA. */
  permission = $state<MobileNotificationPermission>('default')
  private openHandler: OpenNotificationHandler | null = null
  private unsub: (() => void) | null = null
  private pushRegistered = false

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
    if (this.enabled && this.permission === 'granted') void this.syncPushSubscription()
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
      await this.syncPushSubscription()
    }
    return this.permission
  }

  /** Turn system notifications off without touching the browser permission. */
  disable(): void {
    this.enabled = false
    this.pushRegistered = false
    this.persist(false)
    void this.removePushSubscription()
  }

  /**
   * One-time proactive permission prompt on first connect. The browser prompt
   * is shown at most once per browser; afterwards control lives in the
   * notifications sheet's switch, which still re-requests a `default`
   * permission when the user flips it on.
   */
  async maybePrompt(): Promise<MobileNotificationPermission> {
    if (typeof Notification === 'undefined') {
      this.permission = 'unsupported'
      return this.permission
    }
    if (this.permission !== 'default' || this.readAsked()) return this.permission
    this.persistAsked(true)
    const result = await Notification.requestPermission()
    this.permission = result
    if (result === 'granted') {
      this.enabled = true
      this.persist(true)
      await this.syncPushSubscription()
    }
    return result
  }

  private handle(payload: AgentNotificationPayload): void {
    if (!payload || typeof payload !== 'object') return
    // The desktop notification-panel store is only loaded when a notification
    // actually arrives, so the phone's connected closure never eagerly imports
    // the desktop notifications graph.
    void import('$lib/stores/notification-panel.svelte').then(({ notificationPanelState }) => {
      notificationPanelState.add(payload)
    })
    this.showToast(payload)
    if (!this.enabled || this.permission !== 'granted') return
    if (document.visibilityState === 'visible') return
    if (this.pushRegistered) return
    void this.showSystemNotification(payload)
  }

  private showToast(payload: AgentNotificationPayload): void {
    const options = {
      id: payload.id,
      description: payload.body,
      duration: 8_000,
      action: {
        label: 'Open thread',
        onClick: (): void => this.openHandler?.(payload.projectId, payload.threadId)
      }
    }
    if (payload.kind === 'completed' || payload.kind === 'chat-completed') {
      toast.success(payload.title, options)
    } else if (payload.kind === 'attention') {
      toast.warning(payload.title, options)
    } else if (payload.kind === 'spec') {
      toast.info(payload.title, options)
    } else {
      toast.error(payload.title, options)
    }
  }

  private async showSystemNotification(payload: AgentNotificationPayload): Promise<void> {
    try {
      const registration = await navigator.serviceWorker.ready
      const options: ReplacingNotificationOptions = {
        body: payload.body,
        // One notification per thread: a newer agent status replaces the older
        // one instead of stacking duplicates for every status transition.
        tag: `${APP_SLUG}-${payload.projectId}-${payload.threadId}`,
        renotify: true,
        // Attention and error demand action, so they stay until tapped.
        // Completion and spec-ready notices are informational and auto-dismiss quietly.
        requireInteraction: payload.kind === 'attention' || payload.kind === 'error',
        silent: false,
        data: { projectId: payload.projectId, threadId: payload.threadId },
        icon: './icon.png',
        badge: './notification-badge.png'
      }
      await registration.showNotification(payload.title, options)
    } catch (error) {
      remoteLog.error(`Phone system notification failed: ${String(error)}`)
    }
  }

  private decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  }

  private sameApplicationServerKey(
    existing: ArrayBuffer | null,
    expected: Uint8Array<ArrayBuffer>
  ): boolean {
    if (!existing) return false
    const current = new Uint8Array(existing)
    return (
      current.length === expected.length && current.every((byte, index) => byte === expected[index])
    )
  }

  private async syncPushSubscription(): Promise<void> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    try {
      const publicKey = await remoteBridge.invoke('remotePush:getPublicKey')
      if (typeof publicKey !== 'string') return
      const applicationServerKey = this.decodeApplicationServerKey(publicKey)
      const registration = await navigator.serviceWorker.ready
      let subscription = await registration.pushManager.getSubscription()
      if (
        subscription &&
        !this.sameApplicationServerKey(
          subscription.options.applicationServerKey,
          applicationServerKey
        )
      ) {
        await remoteBridge
          .invoke('remotePush:unsubscribe', subscription.endpoint)
          .catch(() => undefined)
        await subscription.unsubscribe()
        subscription = null
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      })
      const json = subscription.toJSON()
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return
      await remoteBridge.invoke('remotePush:subscribe', {
        endpoint: json.endpoint,
        expirationTime: subscription.expirationTime,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }
      })
      this.pushRegistered = true
    } catch (error) {
      this.pushRegistered = false
      remoteLog.error(`Phone Web Push subscription failed: ${String(error)}`)
    }
  }

  private async removePushSubscription(): Promise<void> {
    this.pushRegistered = false
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (!subscription) return
      await remoteBridge
        .invoke('remotePush:unsubscribe', subscription.endpoint)
        .catch(() => undefined)
      await subscription.unsubscribe()
      this.pushRegistered = false
    } catch (error) {
      remoteLog.error(`Phone Web Push unsubscribe failed: ${String(error)}`)
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

  private readAsked(): boolean {
    try {
      return localStorage.getItem(ASKED_KEY) === '1'
    } catch {
      return false
    }
  }

  private persistAsked(asked: boolean): void {
    try {
      if (asked) localStorage.setItem(ASKED_KEY, '1')
      else localStorage.removeItem(ASKED_KEY)
    } catch {
      // best-effort
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
