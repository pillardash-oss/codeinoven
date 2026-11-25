import { BrowserWindow } from 'electron'
import { sendToRenderer } from '../ipc/renderer-delivery'
import type { GitPushProgress } from '../../lib/types'

/**
 * Send one stage of a running push to every window. The panel reads it as the
 * percentage on the push button; no other surface depends on it, so a window that
 * is closing loses nothing.
 *
 * Kept apart from `git-push-jobs` because that module is also bundled into the
 * Oven service, which runs in plain Node where Electron does not exist.
 */
export function broadcastGitPushProgress(progress: GitPushProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    sendToRenderer(win.webContents, 'git:pushProgress', progress)
  }
}
