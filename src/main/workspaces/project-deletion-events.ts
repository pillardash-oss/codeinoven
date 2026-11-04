import { BrowserWindow } from 'electron'
import type { ProjectDeletionEvent } from '../../lib/project-deletion'
import { sendToRenderer } from '../ipc/renderer-delivery'

/**
 * Push one stage of a project deletion to every renderer window.
 *
 * Deletion is fire-and-forget: the IPC call answers the moment the job is
 * accepted, so these events are the only channel that tells a window what
 * happened. Every window applies them, not just the one that asked, because the
 * project row and its threads live in shared sidebar state and a second window
 * would otherwise keep offering a project that is already gone.
 */
export function broadcastProjectDeletion(event: ProjectDeletionEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'project:deletion', event)
  }
}
