import { BrowserWindow } from 'electron'
import { sendToRenderer } from '../ipc/renderer-delivery'
import type { OrchestrationDispatchChange } from '../../lib/types/orchestration'

/**
 * Tell every window that a thread's dispatch count moved.
 *
 * A dispatched run is a row in the sidebar of another project, but the mark that
 * says "this thread dispatched it" belongs to the thread that asked, and that
 * thread is on screen somewhere right now. So the count is pushed rather than
 * polled: the row's mark appears the moment the dispatch is accepted, without
 * waiting for the sidebar to re-read anything.
 */
export function broadcastOrchestrationDispatchChange(change: OrchestrationDispatchChange): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    sendToRenderer(win.webContents, 'orchestration:changed', change)
  }
}
