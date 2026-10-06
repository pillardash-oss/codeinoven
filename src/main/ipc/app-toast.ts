import { BrowserWindow } from 'electron'
import { sendToRenderer } from './renderer-delivery'

/**
 * One transient in-app toast, as the renderer's toast layer reads it (see
 * `Toaster.svelte`): an error goes through the app-errors store, which shows the
 * toast with its Copy action and files it in the App Errors panel; an info line
 * is shown as-is. `details` is the optional extra text behind Copy.
 */
export interface AppToastPayload {
  message: string
  type?: 'error' | 'info'
  details?: string
  projectId?: string
  threadId?: string
  action?: { label: string; projectId: string; threadId: string }
}

/** Deliver one transient in-app toast to every open window. */
export function broadcastAppToast(payload: AppToastPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'app:toast', payload)
  }
}
