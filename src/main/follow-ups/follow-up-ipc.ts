import { BrowserWindow } from 'electron'
import { followUpNotice, type FollowUpAction, type FollowUpNotice } from '../../lib/follow-up'
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
function isFollowUpAction(value: unknown): value is FollowUpAction {
  return value === 'pause' || value === 'resume' || value === 'cancel'
}

export function registerFollowUpHandlers(getService: () => FollowUpService | null): void {
  ipcMain.handle('followUps:list', async () => {
    const service = getService()
    if (!service) return []
    // The file is shared by every instance, so the panel reads it rather than a
    // copy that only the owner keeps fresh.
    await service.refresh()
    return followUpNotices(service)
  })
  /**
   * Control one armed wake by id.
   *
   * This is the user's own surface, so unlike the agent capability it is not
   * scoped to a calling thread: the panel lists every wake of an assistant, which
   * by definition includes threads that are not on screen. The id is the whole
   * authority, and the service refuses an id it does not hold.
   */
  ipcMain.handle('followUps:update', async (_, rawId: unknown, rawAction: unknown) => {
    if (typeof rawId !== 'string' || rawId.trim().length === 0) {
      throw new TypeError('A follow-up id is required')
    }
    if (!isFollowUpAction(rawAction)) {
      throw new TypeError('A follow-up action must be pause, resume or cancel')
    }
    const service = getService()
    if (!service) throw new Error('Scheduled wakes are unavailable right now')
    // A window that is not the owner holds a stale copy: the action must be
    // applied to the file's truth, not to whatever this process last saw.
    await service.refresh()
    const id = rawId.trim()
    const found =
      rawAction === 'pause'
        ? service.pause(id)
        : rawAction === 'resume'
          ? service.resume(id)
          : service.cancel(id)
    if (!found) throw new Error('That wake is no longer armed')
    broadcastFollowUpsChanged(service)
  })
}
