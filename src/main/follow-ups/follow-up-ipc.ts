import { BrowserWindow } from 'electron'
import { followUpNotice, type FollowUpNotice } from '../../lib/follow-up'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import type { FollowUpService } from './follow-up-service'

/**
 * The renderer's view of the armed wakes.
 *
 * A row cannot ask a scheduler a question per render, so the pending set is read
 * once (`followUps:list`) and then pushed whenever it changes (`followUps:changed`).
 * The payload is deliberately the notice shape: a row needs to say that a thread
 * wakes at a time and why, never what the agent wrote in its instruction.
 */
export function followUpNotices(service: FollowUpService): FollowUpNotice[] {
  return service.list().map(followUpNotice)
}

/** Push the current armed set to every window. */
export function broadcastFollowUpsChanged(service: FollowUpService): void {
  const notices = followUpNotices(service)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    sendToRenderer(win.webContents, 'followUps:changed', notices)
  }
}

/**
 * Register the read channel before the renderer is told the features are ready.
 *
 * It takes a getter rather than the service because the scheduler is built after
 * paint, and a window that asks in that gap must get an honest empty list instead
 * of "no handler registered".
 */
export function registerFollowUpHandlers(getService: () => FollowUpService | null): void {
  ipcMain.handle('followUps:list', () => {
    const service = getService()
    return service ? followUpNotices(service) : []
  })
}
