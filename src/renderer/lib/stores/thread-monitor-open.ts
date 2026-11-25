/**
 * Opening a conversation's device preview, from anywhere in the app.
 *
 * The panel otherwise docks on its own only when an agent starts mirroring a
 * device it booted or attached to, so seeing an emulator, a simulator or a phone
 * on the desk meant waiting for an agent to ask for one. The composer's
 * `/monitor` command asks for the same panel the rail offers, so the gesture
 * lives here once: reveal the device this project already has on display, or
 * open the chooser so a person picks one.
 */

import { contextSidebarState } from './context-sidebar.svelte'

export function openThreadMonitorFor(projectId: string, threadId: string): void {
  const mirrored = contextSidebarState
    .mirroredDisplayTabs()
    .find((panel) => panel.projectId === projectId && panel.threadId === threadId)
  if (mirrored) {
    contextSidebarState.focus(mirrored.tabId)
    return
  }
  contextSidebarState.openDisplayChooser(projectId, threadId)
}
