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
 * The tab is what owns the conversation: `PersistedBrowserTab.assistantThreadId`
 * is the link, so a conversation lives exactly as long as the tab it belongs to
 * and a restart restores both. This store is the renderer's mirror of those
 * links plus the rows behind them, so the rail can draw a tab, the strip row can
 * draw the model it runs on, and the workspace thread list never sees any of it
 * (see the ingest guard in `scope-threads.svelte.ts`).
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
  MAX_BROWSER_TAB_TITLE_LENGTH,
  browserAssistantThreadId
} from '$shared/browser/global-browser-tabs'
import { agentRuns } from './agent-runs.svelte'
import { conversationAttention } from './conversation-attention.svelte'
import { threadMessages } from './thread-messages.svelte'

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
  private readonly byTab = new SvelteMap<string, string>()
  /** The conversation still being resolved for a tab, so a second ask while the
   *  first is in flight reuses it instead of creating a second thread. */
  private readonly pending = new Map<string, Promise<BrowserAssistantChat>>()
  private started = false

  /** Register this store's subscriptions. Idempotent, and deliberately not run
   *  at import time: nothing about the browser exists until the browser does. */
  start(): void {
    if (this.started) return
    this.started = true
    subscribe('thread:updated', (thread) => this.applyThreadUpdate(thread))
    subscribe('thread:deleted', (projectId, threadId) => {
      if (projectId !== GLOBAL_BROWSER_PROJECT_ID) return
      this.forget(threadId)
    })
  }

  /** The conversation bound to one browser tab, or null until it has one. */
  chatForTab(browserTabId: string): BrowserAssistantChat | null {
    const threadId = this.byTab.get(browserTabId)
    if (!threadId) return null
    return this.byThread.get(threadId) ?? null
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
   * Resolve a browser tab's assistant conversation, creating it on first use.
   *
   * `existingThreadId` is the durable link the tab carries: when that thread is
   * still there it is reused as-is, and when it is gone (deleted elsewhere, or a
   * stored id this build cannot read) a fresh conversation is created rather than
   * failing the rail the user just opened.
   */
  async ensureChat(input: {
    browserTabId: string
    existingThreadId: string | null
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
    existingThreadId: string | null
    title: string
    settings: ThreadSettings
  }): Promise<BrowserAssistantChat> {
    const bound = this.byTab.get(input.browserTabId)
    if (bound) {
      const known = this.byThread.get(bound)
      if (known) return known
    }
    if (input.existingThreadId) {
      const existing = await invoke('thread:get', GLOBAL_BROWSER_PROJECT_ID, input.existingThreadId)
      if (existing && !existing.archived) return this.register(input.browserTabId, existing)
    }
    const created = await invoke('thread:create', {
      // The thread id is the tab's own, in a form a path can hold: the tab's
      // workspace is `browser-cwd/<thread id>`, so a conversation recreated for
      // this tab lands in the same directory its files were staged in.
      id: browserAssistantThreadId(input.browserTabId),
      projectId: GLOBAL_BROWSER_PROJECT_ID,
      providerId: input.settings.harnessId ?? '',
      title: boundedTitle(input.title),
      workingDirectory: '',
      settings: input.settings
    })
    return this.register(input.browserTabId, created)
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

  /** Drop the conversation a closed browser tab owned, before its thread is
   *  deleted, so the rail can never render a tab whose link is already gone. */
  releaseTab(browserTabId: string): string | null {
    const threadId = this.byTab.get(browserTabId)
    if (!threadId) return null
    this.byTab.delete(browserTabId)
    this.byThread.delete(threadId)
    return threadId
  }

  private register(browserTabId: string, thread: Thread): BrowserAssistantChat {
    const chat: BrowserAssistantChat = { threadId: thread.id, browserTabId, thread }
    this.byThread.set(thread.id, chat)
    this.byTab.set(browserTabId, thread.id)
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
  }

  private forget(threadId: string): void {
    const chat = this.byThread.get(threadId)
    if (!chat) return
    this.byThread.delete(threadId)
    if (this.byTab.get(chat.browserTabId) === threadId) this.byTab.delete(chat.browserTabId)
    threadMessages.clear(GLOBAL_BROWSER_PROJECT_ID, threadId)
    agentRuns.clear(GLOBAL_BROWSER_PROJECT_ID, threadId)
    conversationAttention.clear(GLOBAL_BROWSER_PROJECT_ID, threadId)
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
