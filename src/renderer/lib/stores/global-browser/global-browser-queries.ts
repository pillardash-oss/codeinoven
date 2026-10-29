import { invoke } from '$lib/ipc.svelte'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
import { reportError } from '../app-errors.svelte'
import { browserAssistant } from '../browser-assistant.svelte'
import { contextSidebarState } from '../context-sidebar.svelte'
import { defaultSettingsFor } from '../thread-settings.svelte'
import { isBlankBrowserAddress, type GlobalBrowserTab } from '../global-browser-types'
import {
  GLOBAL_BROWSER_CONTEXT,
  TAB_SAVE_COALESCE_MS,
  browserAssistantChatTitle
} from '../global-browser.svelte'
import type { GlobalBrowserState } from '../global-browser.svelte'

/** GlobalBrowserState queries: one concern, moved verbatim from the composition root. */
export class GlobalBrowserStateQueries {
  constructor(private readonly host: GlobalBrowserState) {}

  hasPeek(sourceTabId: string): boolean {
    return this.host.peeks.has(sourceTabId)
  }

  hasThreadPeek(projectId: string, threadId: string): boolean {
    for (const peek of this.host.peeks.values()) {
      if (peek.projectId === projectId && peek.ownerThreadId === threadId) return true
    }
    return false
  }

  forgetPeek(): void {
    const tab = this.host.peekTab
    if (!tab) return
    for (const [sourceId, peek] of this.host.peeks) {
      if (peek.tab.id === tab.id) this.host.peeks.delete(sourceId)
    }
  }

  /** Whether a browser tab with this address is already open. A blank address
   *  never matches, so "new tab" always makes a new one. When a box is named the
   *  match is scoped to it: the same address in two jars is two different sessions
   *  and must stay two tabs. */
  findTabByUrl(url: string, boxId?: string | null): GlobalBrowserTab | null {
    if (isBlankBrowserAddress(url)) return null
    return (
      this.host.tabs.find(
        (tab) => tab.url === url && (boxId === undefined || tab.boxId === boxId)
      ) ?? null
    )
  }

  /**
   * Reveal the rail on the browsing history.
   *
   * History belongs to the browser rather than to a tab, like downloads do, so this
   * is one of the tools that keeps the rail present with no tab on screen.
   */
  showHistorySidebar(): void {
    this.dismissNotifications()
    this.host.contextSidebarTool = 'history'
    this.host.contextSidebarVisible = true
  }

  toggleHistorySidebar(): void {
    if (this.host.contextSidebarTool === 'history' && this.host.contextSidebarVisible) {
      this.host.closeHistorySidebar()
      return
    }
    this.host.showHistorySidebar()
  }

  closeHistorySidebar(): void {
    if (this.host.contextSidebarTool === 'history') this.host.contextSidebarVisible = false
  }

  /**
   * Drop the notifications tool when another rail tool takes over. The
   * notifications flag lives in the context-sidebar store (the header bell owns
   * it), so the rail can only ask it to close, and only while it is the tool on
   * screen.
   */
  dismissNotifications(): void {
    if (contextSidebarState.sidebarActiveTab?.kind === 'sticky-notes') {
      contextSidebarState.hide()
      return
    }
    if (this.host.notificationsShown) contextSidebarState.toggleNotifications()
  }

  /**
   * Put the tab that owns one assistant conversation on screen with that chat
   * open, and report whether it landed.
   *
   * A conversation parked on a question is only ever reached through here: it is
   * held out of every thread list on purpose, so the notification that says it
   * needs an answer is the one thing that has to be able to bring it back. The
   * conversation is resolved first (creating it if the tab's link was never
   * followed), because the rail only knows about conversations it has seen, and
   * the page binding is what lets the agent read the tab it is answering about.
   *
   * `activate` rather than `switchTo`: this is not a user tab switch, so the
   * native page must not take the keyboard out of whatever the user was typing in.
   */
  async revealAssistantChat(threadId: string): Promise<boolean> {
    const chat = browserAssistant.chatForThread(threadId)
    if (!chat) return false
    const tab = this.host.tabById(chat.browserTabId)
    if (!tab) return false
    await this.ensureAssistantChat(tab)
    this.host.activate(tab.id)
    this.host.showAgentSidebar()
    return this.host.activeTabId === tab.id
  }

  /**
   * Resolve (creating on the very first open) the assistant conversation bound to
   * one browser tab, and hand main the page it answers about.
   *
   * The conversation and the tab point at each other: the thread id is written
   * into the tab's durable row, so a restart restores the link, and main is told
   * which browser tab the thread is looking at, which is what lets the agent's
   * browser capability read the page the user is on rather than a page of its own.
   */
  async ensureAssistantChat(tab: GlobalBrowserTab): Promise<void> {
    try {
      const chat = await browserAssistant.ensureChat({
        browserTabId: tab.id,
        existingThreadId: tab.assistantThreadId,
        title: browserAssistantChatTitle(tab),
        settings: defaultSettingsFor('chat')
      })
      if (tab.assistantThreadId !== chat.threadId) {
        tab.assistantThreadId = chat.threadId
        this.persist()
      }
      void invoke('browser:bindAssistantPage', chat.threadId, tab.id).catch(() => {})
    } catch (error) {
      reportError(error, 'The assistant conversation could not be started.')
    }
  }

  /**
   * Tear down one browser tab's agent conversation: the thread that holds its
   * transcript is deleted with the tab that owned it.
   *
   * The link is read from the store first and from the tab's own durable field
   * second, so a conversation this session never opened (a tab restored from a
   * previous launch) is still cleaned up instead of being left behind as a
   * thread nothing can reach.
   */
  closeAssistantChatFor(tabId: string, linkedThreadId: string | null): void {
    const threadId = browserAssistant.releaseTab(tabId) ?? linkedThreadId
    if (!threadId) return
    void invoke('thread:delete', GLOBAL_BROWSER_PROJECT_ID, threadId).catch(() => {})
    void invoke('browser:unbindAssistantPage', threadId).catch(() => {})
  }

  /** A box was deleted: erase it and take its Chromium profile with it. Nothing can
   *  name a deleted box's jar again, so leaving the profile in place would strand
   *  its cache on disk. Best-effort with a report, exactly like `clearBoxData`: the
   *  user asked for the data to be gone, and a silent failure would leave them
   *  believing it is. */
  async forgetBox(boxId: string): Promise<void> {
    try {
      await invoke('browser:forgetBox', GLOBAL_BROWSER_CONTEXT.projectId, boxId)
    } catch (error) {
      reportError(error, 'The box\u2019s data could not be erased.')
    }
  }

  /**
   * Queue a write of the current strip.
   *
   * Nothing is written before the stored list has been read, so a store that has
   * never seen it cannot erase it. Changes coalesce into one write, and the quit
   * path flushes whatever is still pending.
   */
  persist(): void {
    this.host.mutatedSinceBoot = true
    if (!this.host.hydrated) return
    if (this.host.saveTimer !== null) return
    this.host.saveTimer = window.setTimeout(() => {
      this.host.saveTimer = null
      void this.host.units['runtime'].saveStoredTabs()
    }, TAB_SAVE_COALESCE_MS)
  }
}
