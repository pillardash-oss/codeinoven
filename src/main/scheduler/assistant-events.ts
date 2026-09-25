import { BrowserWindow } from 'electron'
import type { MissedRun, Routine } from '../../lib/types'
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

/**
 * Push one routine's new Getting started checkpoint, so an open how-to panel
 * refreshes what the interview has agreed instead of waiting to be reopened.
 */
export function broadcastRoutineCheckpointChanged(routineId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'routine:checkpointChanged', routineId)
  }
}
