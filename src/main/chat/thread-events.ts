import { BrowserWindow } from 'electron'
import type { AgentEvent, Thread } from '../../lib/types'
import type { NotificationService } from '../notifications/notification-service'
import type { PowerWakeService } from '../system/power-wake-service'
import { forwardRemoteEvent } from '../remote/remote-event-forwarder'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { instanceRegistry } from '../system/instance-registry'

type CheckpointUpdatedEvent = Extract<AgentEvent, { type: 'checkpoint.updated' }>

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

/** Keep provider-owned retry windows aligned with the power-wake policy. */
export function updateRetryWakeWindow(sessionId: string, retryAt: number | null): void {
  _powerWakeService?.onRetryWindowChanged(sessionId, retryAt)
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
    sendToRenderer(win.webContents, 'thread:updated', thread)
  }
  forwardRemoteEvent('thread:updated', thread)
  if (thread.read) {
    dismissThreadNotifications(thread.projectId, thread.id)
  }
  _powerWakeService?.onThreadUpdate(thread)
  void _notificationService?.notify(thread)
}

/** Push permanent task deletion so every desktop and remote view drops it. */
export function broadcastThreadDeleted(thread: Thread): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'thread:deleted', thread.projectId, thread.id)
  }
  forwardRemoteEvent('thread:deleted', [thread.projectId, thread.id])
  dismissThreadNotifications(thread.projectId, thread.id)
}

/** Keep note-presence indicators synchronized across desktop and remote renderers. */
export function broadcastNoteChanged(projectId: string, threadId: string, hasNote: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'note:changed', projectId, threadId, hasNote)
  }
  forwardRemoteEvent('note:changed', [projectId, threadId, hasNote])
}

/** Notify renderers that one task's live process list changed. */
export function broadcastAgentProcessesChanged(projectId: string, threadId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'agent:processesChanged', projectId, threadId)
  }
}

/** Deliver another process's persisted checkpoint invalidation locally. */
function deliverCrossInstanceCheckpointUpdated(event: CheckpointUpdatedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'agent:event', event)
  }
  forwardRemoteEvent('agent:event', event)
}

instanceRegistry.onCheckpointUpdated(deliverCrossInstanceCheckpointUpdated)

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
