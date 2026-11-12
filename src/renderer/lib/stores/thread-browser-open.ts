/**
 * Opening a conversation's own browser, from anywhere in the app.
 *
 * Two surfaces ask for it: the composer's `/browser` command inside a thread,
 * and the spotlight's "Open thread browser" action. Both want the same gesture
 * the rail already offers, so it lives here once instead of being composed
 * twice: reveal the page the conversation already has, or start a blank tab and
 * hand its address bar the keyboard.
 */

import { browserAddressFocus } from './browser-address-focus'
import { contextSidebarState } from './context-sidebar.svelte'

export function openThreadBrowserFor(projectId: string, threadId: string): void {
  const existingTabId = contextSidebarState.rememberedBrowserTabId
  if (existingTabId) {
    contextSidebarState.focus(existingTabId)
    return
  }
  const tabId = contextSidebarState.openBrowserForContext('', projectId, threadId, undefined, true)
  browserAddressFocus.request(tabId)
}
