import { BrowserWindow } from 'electron'
import { sendToRenderer } from './renderer-delivery'

/**
 * One transient in-app toast, as the renderer's toast layer reads it (see
 * `Toaster.svelte`): an error goes through the app-errors store, which shows the
 * toast with its Copy action and files it in the App Errors panel; an info line
 * is shown as-is. `details` is the optional extra text behind Copy.
 */
export interface AppToastPayload {
  /** Identity a raiser can use to withdraw the notice once it is resolved. */
  id?: string
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

/**
 * Withdraw a toast whose reason no longer holds.
 *
 * A notice that says "resume coordination" is obsolete the moment coordination
 * resumes, and leaving it on screen describes a state the app already left.
 */
export function dismissAppToast(id: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'app:toast:dismiss', id)
  }
}
