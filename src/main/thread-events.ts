import { BrowserWindow } from 'electron'
import type { Thread } from '../lib/types'
import type { NotificationService } from './notification-service'
import type { PowerWakeService } from './power-wake-service'

let _notificationService: NotificationService | null = null
let _powerWakeService: PowerWakeService | null = null

export function setNotificationService(service: NotificationService | null): void {
  _notificationService = service
}

export function setPowerWakeService(service: PowerWakeService | null): void {
  _powerWakeService = service
}

export function markNotificationAborting(projectId: string, threadId: string): void {
  _notificationService?.markAborting(projectId, threadId)
}

export function clearNotificationAborting(projectId: string, threadId: string): void {
  _notificationService?.clearAborting(projectId, threadId)
}

/** Dismiss delivered OS notifications + badge entry for a thread. */
export function dismissThreadNotifications(projectId: string, threadId: string): void {
  _notificationService?.dismissForThread(projectId, threadId)
}

/**
 * Push a thread snapshot to every renderer window so live UI (sidebar
 * indicators, headers) can react to status/read changes without polling,
 * then fire an OS notification if the app is backgrounded.
 */
export function broadcastThreadUpdate(thread: Thread): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('thread:updated', thread)
  }
  if (thread.read) {
    dismissThreadNotifications(thread.projectId, thread.id)
  }
  _powerWakeService?.onThreadUpdate(thread)
  void _notificationService?.notify(thread)
}

/**
 * Pipe a temporary chat (side chat) completion through the parent thread's
 * notification channel so the user learns their side chat is done even when
 * they are not on that thread.
 */
export function notifyTemporaryChat(
  thread: Thread,
  temporaryChatId: string,
  kind: 'completed' | 'error'
): void {
  void _notificationService?.notifyTemporaryChat(thread, temporaryChatId, kind)
}
