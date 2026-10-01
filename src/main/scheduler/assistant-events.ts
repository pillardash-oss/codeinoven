import { BrowserWindow } from 'electron'
import type { AutoAnswerItem, BackgroundRun, MissedRun, Routine } from '../../lib/types'
import { sendToRenderer } from '../ipc/renderer-delivery'

/** Push the full routine list so routine rows and the how-to panel stay live. */
export function broadcastRoutinesChanged(routines: Routine[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'routine:changed', routines)
  }
}

/** Push the pending missed-run list so badges, the tab, and the panel react. */
export function broadcastMissedRunsChanged(runs: MissedRun[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'assistant:missedRunsChanged', runs)
  }
}

/** Push the durable unattended-run list so the "While you were away" surfaces refresh. */
export function broadcastBackgroundRunsChanged(runs: BackgroundRun[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'assistant:backgroundRunsChanged', runs)
  }
}

/** Push the auto-resolved-gate list so the attention rail and its panel react. */
export function broadcastAutoAnswersChanged(items: AutoAnswerItem[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'assistant:autoAnswersChanged', items)
  }
}

/**
 * Push one routine's new Getting started checkpoint, so an open how-to panel
 * refreshes what the interview has agreed instead of waiting to be reopened.
 */
export function broadcastRoutineCheckpointChanged(routineId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'routine:checkpointChanged', routineId)
  }
}
