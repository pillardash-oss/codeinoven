import { BrowserWindow } from 'electron'
import type {
  AutoAnswerItem,
  BackgroundRun,
  MissedRun,
  Assistant,
  SkippedRun
} from '../../lib/types'
import { sendToRenderer } from '../ipc/renderer-delivery'

/** Push the full assistant list so assistant rows and the knowledge panel stay live. */
export function broadcastAssistantsChanged(assistants: Assistant[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'assistant:changed', assistants)
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

/** Push skipped slots so every renderer recalculates task and assistant next runs. */
export function broadcastSkippedRunsChanged(runs: SkippedRun[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'assistant:skippedAssistantRunsChanged', runs)
  }
}

/** Push the auto-resolved-gate list so the attention rail and its panel react. */
export function broadcastAutoAnswersChanged(items: AutoAnswerItem[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'assistant:autoAnswersChanged', items)
  }
}

/**
 * Push one assistant's new Getting started checkpoint, so an open knowledge panel
 * refreshes what the interview has agreed instead of waiting to be reopened.
 */
export function broadcastAssistantCheckpointChanged(assistantId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'assistant:checkpointChanged', assistantId)
  }
}
