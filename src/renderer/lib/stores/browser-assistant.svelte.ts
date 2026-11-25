/**
 * The agent conversation each global browser tab owns.
 *
 * A browser tab's assistant chat used to be the app's temporary side chat: a
 * synthetic conversation that expired after a few idle hours and left nothing
 * behind. That is not what a tab's assistant is, so it is a real chat thread in
 * the reserved hidden browser project instead. Everything the user expects of a
 * conversation then holds without this module doing anything for it: the
 * transcript, the title, the harness session and the chosen model all persist,
 * and the title is generated from the first message exactly as it is for any
 * other chat.
 *
 * The tab is what owns the conversations: `PersistedBrowserTab.assistantThreadIds`
 * is the link list, so every conversation a tab opened lives exactly as long as
 * the tab belongs to it and a restart restores them all. A page can be asked more
 * than one thing, and each answer is a conversation of its own: the rail lists
 * them as tabs and its "+" adds another to the page on screen, which is the only
 * thing that "+" does. This store is the renderer's mirror of those links plus
 * the rows behind them, so the rail can draw a tab per conversation, the strip
 * row can draw the model it runs on, and the workspace thread list never sees any
 * of it (see the ingest guard in `scope-threads.svelte.ts`).
 *
 * The browser is not part of the first paint, so this stays inert until
 * `start()` is called from the browser runtime seam: a launch that never opens
 * the browser pays no subscription for it.
 */

import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { Thread, ThreadSettings } from '$shared/types'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
import {
  MAX_BROWSER_TAB_ASSISTANT_THREADS,
  MAX_BROWSER_TAB_TITLE_LENGTH,
  browserAssistantThreadId
} from '$shared/browser/global-browser-tabs'
import { agentRuns } from './agent-runs.svelte'
import { conversationAttention } from './conversation-attention.svelte'
import { threadMessages } from './thread-messages.svelte'
import { reportError } from './app-errors.svelte'

/** The title a fresh assistant conversation starts on before the model names it
 *  from the user's first question. */
export const BROWSER_ASSISTANT_DEFAULT_TITLE = 'Agent'

/** One browser tab's assistant conversation: its link and the live row. */
export interface BrowserAssistantChat {
  threadId: string
  browserTabId: string
  /** The durable row, refreshed from `thread:updated` broadcasts. */
  thread: Thread
}

class BrowserAssistantState {
  private readonly byThread = new SvelteMap<string, BrowserAssistantChat>()
  /** The conversations each browser tab owns, oldest first. The tab's own durable
   *  row is what survives a restart; this is its live mirror. */
  private readonly byTab = new SvelteMap<string, string[]>()
  /** The conversation on screen for each tab, so reopening the rail lands on the
   *  one the user left there instead of the first one opened. */
  private readonly selectedByTab = new SvelteMap<string, string>()
  /** The conversation still being resolved for a tab, so a second ask while the
   *  first is in flight reuses it instead of creating a second thread. */
  private readonly pending = new Map<string, Promise<BrowserAssistantChat>>()
  artifactThreadId = $state<string | null>(null)
  showArtifacts(threadId: string): void {
    this.artifactThreadId = threadId
  }
  showConversation(): void {
    this.artifactThreadId = null
  }
  private readonly artifactThreads = new SvelteMap<string, boolean>()
  private readonly artifactLoads: Record<string, boolean> = {}
  hasArtifacts(threadId: string): boolean {
    return this.artifactThreads.get(threadId) === true
  }
  async refreshArtifacts(threadId: string): Promise<void> {
    if (this.artifactLoads[threadId]) return
    this.artifactLoads[threadId] = true
    try {
      const entries = await invoke(
        'projectFiles:list',
        GLOBAL_BROWSER_PROJECT_ID,
        '',
        undefined,
        threadId
      )
      // The conversation can be deleted while this read is in flight, and its
      // workspace with it. Nothing may be recorded for a conversation the store
      // no longer knows, or a fresh conversation for the same tab would inherit
      // the deleted one's answer.
      if (!this.byThread.has(threadId)) return
      this.artifactThreads.set(
        threadId,
        entries.some((entry) => !entry.name.startsWith('.'))
      )
    } catch (error) {
      // A read for a conversation that was deleted meanwhile is not a failure the
      // user can act on: reporting it only leaves an error about a conversation
      // that is already gone.
      if (!this.byThread.has(threadId)) return
      reportError(error, 'Browser conversation artifacts could not be loaded.')
    } finally {
      delete this.artifactLoads[threadId]
    }
  }
  private started = false

  /** Register this store's subscriptions. Idempotent, and deliberately not run
   *  at import time: nothing about the browser exists until the browser does. */
  start(): void {
    if (this.started) return
    this.started = true
    subscribe('thread:updated', (thread) => {
      this.applyThreadUpdate(thread)
      if (
        thread.projectId === GLOBAL_BROWSER_PROJECT_ID &&
        this.byThread.has(thread.id) &&
        thread.status !== 'executing' &&
        thread.status !== 'planning'
      ) {
        void this.refreshArtifacts(thread.id)
      }
    })
    subscribe('thread:deleted', (projectId, threadId) => {
      if (projectId !== GLOBAL_BROWSER_PROJECT_ID) return
      this.forget(threadId)
    })
  }

  /** The conversation one browser tab is showing, or null until it has one. */
  chatForTab(browserTabId: string): BrowserAssistantChat | null {
    const ids = this.byTab.get(browserTabId)
    if (!ids || ids.length === 0) return null
    const selected = this.selectedByTab.get(browserTabId)
    const threadId = selected && ids.includes(selected) ? selected : ids[0]
    return this.byThread.get(threadId) ?? null
  }

  /**
   * Every conversation one browser tab owns, oldest first, as live chats.
   *
   * This is what the rail's strip draws: one tab per conversation of the page on
   * screen. A conversation whose row has not been resolved yet (a restored link
   * still being fetched) is simply absent until it lands.
   */
  chatsForTab(browserTabId: string): BrowserAssistantChat[] {
    const ids = this.byTab.get(browserTabId)
    if (!ids) return []
    return ids.flatMap((threadId) => {
      const chat = this.byThread.get(threadId)
      return chat ? [chat] : []
    })
  }

  /** Put one of a tab's conversations on screen, which is what selecting its rail
   *  tab does. Ignored for a conversation the tab does not own. */
  selectChat(browserTabId: string, threadId: string): void {
    const ids = this.byTab.get(browserTabId)
    if (!ids || !ids.includes(threadId)) return
    this.selectedByTab.set(browserTabId, threadId)
  }

  /** The conversation ids one browser tab owns, for the tab's durable row. */
  threadIdsForTab(browserTabId: string): string[] {
    return [...(this.byTab.get(browserTabId) ?? [])]
  }

  /** The conversation behind one thread id, for a surface that only holds the id. */
  chatForThread(threadId: string): BrowserAssistantChat | null {
    return this.byThread.get(threadId) ?? null
  }

  /**
   * Every conversation this store currently knows about, as live thread rows.
   *
   * These rows are deliberately absent from `scopeState.allScopeThreads`, because
   * no workspace list may show them as phantom threads. That same exclusion is
   * what removed them from the view rail's activity badge, so an assistant chat
   * could work or sit parked on a question with nothing anywhere saying so. This
   * is the read that lets the rail count them on its own terms.
   *
   * Reactive in both directions: a `thread:updated` broadcast replaces the row in
   * `byThread`, and a tab closing removes it.
   */
  get threads(): Thread[] {
    return [...this.byThread.values()].map((chat) => chat.thread)
  }

  /**
   * Open the conversation a browser tab should show, creating the first one when
   * the tab has never asked the agent anything.
   *
   * `existingThreadIds` is the durable list the tab carries: the conversation on
   * screen is reused when its thread is still there, and a link whose thread is
   * gone (deleted elsewhere, or a stored id this build cannot read) is skipped
   * rather than failing the rail the user just opened.
   */
  async ensureChat(input: {
    browserTabId: string
    existingThreadIds: readonly string[]
    title: string
    settings: ThreadSettings
  }): Promise<BrowserAssistantChat> {
    const inFlight = this.pending.get(input.browserTabId)
    if (inFlight) return inFlight
    const resolving = this.#resolveChat(input).finally(() => {
      if (this.pending.get(input.browserTabId) === resolving)
        this.pending.delete(input.browserTabId)
    })
    this.pending.set(input.browserTabId, resolving)
    return resolving
  }

  async #resolveChat(input: {
    browserTabId: string
    existingThreadIds: readonly string[]
    title: string
    settings: ThreadSettings
  }): Promise<BrowserAssistantChat> {
    const known = this.chatForTab(input.browserTabId)
    if (known) return known
    const linked = this.byTab.get(input.browserTabId) ?? [...input.existingThreadIds]
    if (linked.length > 0) {
      // The tab already owns conversations; reopen the one it was showing. Its
      // row is missing only when the thread was deleted elsewhere, in which case
      // the tab asks the agent again and gets a fresh conversation.
      const selected = this.selectedByTab.get(input.browserTabId)
      const target = selected && linked.includes(selected) ? selected : linked[0]
      const existing = await invoke('thread:get', GLOBAL_BROWSER_PROJECT_ID, target)
      if (existing && !existing.archived) return this.register(input.browserTabId, existing)
      this.#forgetId(input.browserTabId, target)
    }
    return this.#createChat({
      browserTabId: input.browserTabId,
      title: input.title,
      settings: input.settings,
      id: browserAssistantThreadId(input.browserTabId)
    })
  }

  /**
   * Start another conversation for one browser tab, which is what the rail's "+"
   * does.
   *
   * The page is the same page; only the conversation is new. The first
   * conversation of a tab keeps the id derived from the tab, so its workspace is
   * the one a conversation for that tab has always used, and every later one adds
   * its own suffix so two conversations of one page never share files.
   */
  async newChat(input: {
    browserTabId: string
    title: string
    settings: ThreadSettings
  }): Promise<BrowserAssistantChat> {
    const key = `new:${input.browserTabId}`
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight
    const ids = this.byTab.get(input.browserTabId) ?? []
    if (ids.length >= MAX_BROWSER_TAB_ASSISTANT_THREADS) {
      throw new Error(
        `A browser tab can hold ${MAX_BROWSER_TAB_ASSISTANT_THREADS} assistant conversations; close one to start another.`
      )
    }
    const creating = this.#createChat({
      browserTabId: input.browserTabId,
      title: input.title,
      settings: input.settings,
      id: this.#mintedThreadId(input.browserTabId)
    }).finally(() => {
      if (this.pending.get(key) === creating) this.pending.delete(key)
    })
    this.pending.set(key, creating)
    return creating
  }

  async #createChat(input: {
    browserTabId: string
    title: string
    settings: ThreadSettings
    id: string
  }): Promise<BrowserAssistantChat> {
    const created = await invoke('thread:create', {
      // The thread id is the tab's own, in a form a path can hold: the tab's
      // workspace is `browser-cwd/<thread id>`, so a conversation recreated for
      // this tab lands in the same directory its files were staged in.
      id: input.id,
      projectId: GLOBAL_BROWSER_PROJECT_ID,
      providerId: input.settings.harnessId ?? '',
      title: boundedTitle(input.title),
      workingDirectory: '',
      settings: input.settings
    })
    return this.register(input.browserTabId, created)
  }

  /** An id for one more conversation of a tab: the tab-derived id while no
   *  conversation owns it, otherwise that id with a suffix nothing else holds. */
  #mintedThreadId(browserTabId: string): string {
    const base = browserAssistantThreadId(browserTabId)
    const taken = new Set([
      ...(this.byTab.get(browserTabId) ?? []),
      ...[...this.byThread.keys()].filter((id) => id.startsWith(base))
    ])
    if (!taken.has(base)) return base
    for (;;) {
      const candidate = `${base}-${crypto.randomUUID().slice(0, 8)}`
      if (!taken.has(candidate)) return candidate
    }
  }

  /**
   * Reconnect the durable tab links after the browser snapshot is restored.
   *
   * Every linked conversation is fetched, not just one per tab, because a tab can
   * own several and each of them is a tab in the rail. The work is bounded by the
   * browser's tab cap times the per-tab conversation cap, and it avoids a full
   * hidden-project thread scan.
   */
  async restoreChats(
    tabs: readonly { id: string; assistantThreadIds: readonly string[] }[]
  ): Promise<void> {
    await Promise.all(
      tabs.map(async (tab) => {
        const linked = tab.assistantThreadIds.filter((id) => id.length > 0)
        if (linked.length === 0) return
        this.byTab.set(tab.id, [...linked])
        await Promise.all(
          linked.map(async (threadId) => {
            try {
              const thread = await invoke('thread:get', GLOBAL_BROWSER_PROJECT_ID, threadId)
              if (!thread || thread.archived) {
                this.#forgetId(tab.id, threadId)
                return
              }
              this.register(tab.id, thread)
              void invoke('browser:bindAssistantPage', thread.id, tab.id).catch(() => {})
            } catch {
              // A deleted thread leaves a stale tab link; opening Ask the agent
              // can create a replacement through the existing ensureChat path.
              this.#forgetId(tab.id, threadId)
            }
          })
        )
      })
    )
  }

  /** Rename one conversation. The user's own title is manual, so the model never
   *  overwrites it on a later turn. */
  async renameChat(threadId: string, title: string): Promise<void> {
    const updated = await invoke('thread:update', GLOBAL_BROWSER_PROJECT_ID, threadId, {
      title: title.trim(),
      titleSource: 'manual'
    })
    this.applyThreadUpdate(updated)
  }

  /**
   * Delete one conversation and forget it.
   *
   * The thread row is what the transcript lives in, so the delete is main's:
   * closing the conversation is deleting it, exactly as the user asked. The
   * renderer's per-conversation caches go with it so a future conversation that
   * reuses nothing cannot inherit a message, a working state or an attention flag.
   */
  async closeChat(chat: BrowserAssistantChat): Promise<void> {
    try {
      await invoke('thread:delete', GLOBAL_BROWSER_PROJECT_ID, chat.threadId)
      // The conversation is gone, so the page it was attached to no longer has an
      // assistant: main drops the binding rather than keeping a link to a thread
      // that no longer exists.
      void invoke('browser:unbindAssistantPage', chat.threadId).catch(() => {})
    } finally {
      this.forget(chat.threadId)
    }
  }

  /** Drop every conversation a closed browser tab owned, before their threads are
   *  deleted, so the rail can never render a tab whose link is already gone. */
  releaseTab(browserTabId: string): string[] {
    const threadIds = this.byTab.get(browserTabId) ?? []
    this.byTab.delete(browserTabId)
    this.selectedByTab.delete(browserTabId)
    for (const threadId of threadIds) {
      this.artifactThreads.delete(threadId)
      this.byThread.delete(threadId)
    }
    return threadIds
  }

  private register(browserTabId: string, thread: Thread): BrowserAssistantChat {
    const chat: BrowserAssistantChat = { threadId: thread.id, browserTabId, thread }
    this.byThread.set(thread.id, chat)
    const ids = this.byTab.get(browserTabId) ?? []
    if (!ids.includes(thread.id)) this.byTab.set(browserTabId, [...ids, thread.id])
    if (!this.selectedByTab.get(browserTabId)) this.selectedByTab.set(browserTabId, thread.id)
    this.#bindSession(thread)
    return chat
  }

  private applyThreadUpdate(thread: Thread): void {
    if (thread.projectId !== GLOBAL_BROWSER_PROJECT_ID) return
    const known = this.byThread.get(thread.id)
    if (!known) return
    // The record is replaced rather than mutated, so every reader of a chat (the
    // rail's tab, the strip row's model, the panel's settings) sees the new row:
    // a mutated object inside the map would never notify them.
    this.byThread.set(thread.id, { ...known, thread })
    this.#bindSession(thread)
  }

  /**
   * Bind this conversation's harness session in the shared streaming routing
   * table, so live agent events reach it whether or not its panel is mounted.
   *
   * The panel binds the session itself on mount, but a conversation created by
   * its first message has no session yet at that moment: main creates the
   * session during the send and reports it only through `thread:updated`. That
   * left the routing table without this conversation's session, so every live
   * event for the turn   including the `session.idle` that ends it   resolved to
   * no conversation and was dropped. The optimistically set busy flag then never
   * cleared, and the tab read as working long after the agent finished.
   *
   * The store already owns these rows and already subscribes to `thread:updated`,
   * so binding here covers both registration and every later row update.
   */
  #bindSession(thread: Thread): void {
    if (thread.sessionId) threadMessages.setSessionId(thread.projectId, thread.id, thread.sessionId)
  }

  private forget(threadId: string): void {
    const chat = this.byThread.get(threadId)
    if (!chat) {
      for (const browserTabId of [...this.byTab.keys()]) this.#forgetId(browserTabId, threadId)
      return
    }
    this.artifactThreads.delete(threadId)
    this.byThread.delete(threadId)
    this.#forgetId(chat.browserTabId, threadId)
    threadMessages.clear(GLOBAL_BROWSER_PROJECT_ID, threadId)
    agentRuns.clear(GLOBAL_BROWSER_PROJECT_ID, threadId)
    conversationAttention.clear(GLOBAL_BROWSER_PROJECT_ID, threadId)
  }

  /** Drop one conversation id from a tab's list, and move the tab's selection off
   *  it so the rail lands on a conversation the tab still owns. */
  #forgetId(browserTabId: string, threadId: string): void {
    const ids = this.byTab.get(browserTabId)
    if (!ids) return
    const remaining = ids.filter((id) => id !== threadId)
    if (remaining.length === 0) this.byTab.delete(browserTabId)
    else this.byTab.set(browserTabId, remaining)
    if (this.selectedByTab.get(browserTabId) === threadId) {
      this.selectedByTab.delete(browserTabId)
    }
  }
}

/** A thread title is bounded by the create contract, and a page's own label can
 *  be longer than a conversation title should ever be. */
function boundedTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed === '') return BROWSER_ASSISTANT_DEFAULT_TITLE
  return trimmed.length > MAX_BROWSER_TAB_TITLE_LENGTH
    ? trimmed.slice(0, MAX_BROWSER_TAB_TITLE_LENGTH)
    : trimmed
}

export const browserAssistant = new BrowserAssistantState()
