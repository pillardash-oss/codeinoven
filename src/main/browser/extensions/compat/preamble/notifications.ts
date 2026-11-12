/**
 * ── notifications, for real ────────────────────────────────────────────────
 * The namespace is compiled out, so the stubs above made `create` return a
 * plausible id and raise nothing: an extension that reports a problem to the user
 * was talking to itself. The app can do better than that, because it owns the
 * desktop. A request is queued here, main reads it out of the mailbox and raises
 * it through the app's own notifier, and a click comes back over the bridge as a
 * real `onClicked`, which is the half an extension actually needs.
 *
 * The ids stay the extension's own, because an extension that stores the id it
 * was handed and clears it later must be able to. Main namespaces them per
 * extension on its side instead of rewriting them here.
 */

import { answerWith, roots, state } from './context.ts'
import type { ChromeNamespace } from './context.ts'
import { makeRealEvent } from './events.ts'
import { scheduleMailbox } from './mailbox.ts'

/** Which request this is; the mailbox carries it to main. */
export type NotificationKind = 'create' | 'update' | 'clear'

/** One request main reads out of the mailbox and raises through its notifier. */
export interface NotificationRequest {
  /** The number this life gave the request; main acts on what it has not seen. */
  seq: number
  /** The extension's own id, unchanged. */
  id: string
  kind: NotificationKind
  /** The extension's own options object, as it handed it over. */
  options: object | undefined
}

/** What this module records on `state.notifications`, which the app reads back. */
export interface NotificationStats {
  queued: number
  live: number
  shimmed?: boolean
}

/**
 * The object `state.notifications` points at.
 *
 * It is held here as well as on `state` because `PreambleState` carries an index
 * signature, so `state.notifications.queued` reads as `unknown`; the two names are
 * the same object, and `installNotifications` puts this one on `state`.
 */
export const notificationStats: NotificationStats = { queued: 0, live: 0 }

export const notificationQueue: NotificationRequest[] = []
export let notificationSeq = 0
export let notificationAutoId = 0
export const notificationBox = new Map<string, object>()
export const notificationClicked = makeRealEvent()
export const notificationClosed = makeRealEvent()
export const notificationButtonClicked = makeRealEvent()

export const queueNotification = (kind: NotificationKind, id: string, options: unknown): string => {
  notificationSeq += 1
  notificationQueue.push({
    seq: notificationSeq,
    id,
    kind,
    options: options && typeof options === 'object' ? options : undefined
  })
  // Only what the app has not seen yet matters, but a life that raises a
  // thousand toasts is not worth unbounded memory either.
  if (notificationQueue.length > 60) {
    notificationQueue.splice(0, notificationQueue.length - 60)
  }
  notificationStats.queued = notificationSeq
  notificationStats.live = notificationBox.size
  scheduleMailbox()
  return id
}

export const resolveNotificationId = (id: unknown): string => {
  if (typeof id === 'string' && id.length > 0) return id
  notificationAutoId += 1
  return 'cio-notification-' + String(notificationAutoId)
}

export const notificationApi = {
  create: (
    idOrOptions?: unknown,
    optionsOrCallback?: unknown,
    maybeCallback?: unknown
  ): Promise<unknown> => {
    try {
      let id: string | null = null
      let options: unknown = null
      let callback: unknown = null
      if (typeof idOrOptions === 'string') {
        id = idOrOptions
        options = optionsOrCallback
        callback = maybeCallback
      } else {
        options = idOrOptions
        callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : null
      }
      const resolvedId = resolveNotificationId(id)
      notificationBox.set(resolvedId, options && typeof options === 'object' ? options : {})
      queueNotification('create', resolvedId, options)
      return answerWith(callback, resolvedId)
    } catch (error) {
      state.errors.push('notifications-create: ' + String(error))
      return Promise.resolve(null)
    }
  },
  update: (id: unknown, options: unknown, callback: unknown): Promise<unknown> => {
    try {
      const key = String(id === undefined || id === null ? '' : id)
      // Chromium answers whether an update landed, and an extension that clears
      // a stale id relies on the false rather than on an exception.
      if (!notificationBox.has(key)) return answerWith(callback, false)
      notificationBox.set(key, options && typeof options === 'object' ? options : {})
      queueNotification('update', key, options)
      return answerWith(callback, true)
    } catch (error) {
      state.errors.push('notifications-update: ' + String(error))
      return Promise.resolve(false)
    }
  },
  clear: (id: unknown, callback: unknown): Promise<unknown> => {
    try {
      const key = String(id === undefined || id === null ? '' : id)
      const existed = notificationBox.delete(key)
      queueNotification('clear', key, undefined)
      return answerWith(callback, existed)
    } catch (error) {
      state.errors.push('notifications-clear: ' + String(error))
      return Promise.resolve(false)
    }
  },
  getAll: (callback: unknown): Promise<unknown> => {
    try {
      const all: Record<string, unknown> = {}
      for (const [key, value] of notificationBox.entries()) {
        all[key] = JSON.parse(JSON.stringify(value))
      }
      return answerWith(callback, all)
    } catch (error) {
      state.errors.push('notifications-getAll: ' + String(error))
      return Promise.resolve({})
    }
  },
  // The app shows these itself, so an extension is entitled to a yes rather than
  // the prompt Chromium would show.
  getPermissionLevel: (callback: unknown): Promise<unknown> => answerWith(callback, 'granted')
}

export const notificationEvents = {
  onClicked: notificationClicked,
  onClosed: notificationClosed,
  onButtonClicked: notificationButtonClicked,
  onPermissionLevelChanged: makeRealEvent(),
  onShowSettings: makeRealEvent()
}

export function installNotifications(): void {
  state.notifications = notificationStats
  // Replaced, not ensured: these members are the stubs this same file installed a
  // few hundred lines up, so overwriting them replaces a placeholder rather than
  // clobbering something the runtime provided. Enumerable, like Chromium's own.
  for (const root of roots) {
    const api = root && (root['notifications'] as ChromeNamespace | undefined)
    if (!api) continue
    for (const key of Object.keys(notificationApi)) {
      try {
        Object.defineProperty(api, key, {
          value: notificationApi[key as keyof typeof notificationApi],
          configurable: true,
          writable: true,
          enumerable: true
        })
      } catch (error) {
        state.errors.push('notifications.' + key + ': ' + String(error))
      }
    }
    for (const key of Object.keys(notificationEvents)) {
      try {
        Object.defineProperty(api, key, {
          value: notificationEvents[key as keyof typeof notificationEvents],
          configurable: true,
          writable: true,
          enumerable: true
        })
      } catch (error) {
        state.errors.push('notifications.' + key + ': ' + String(error))
      }
    }
  }
  notificationStats.shimmed = true
}
