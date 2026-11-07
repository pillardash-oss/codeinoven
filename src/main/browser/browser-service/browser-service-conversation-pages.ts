import { conversationScopeId, ASSISTANT_SPACE_ID } from '../../../lib/types'
import type { BrowserAgentTabClaim, BrowserThreadBrowserPage } from '../../../lib/ipc-contract'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { type BrowserTab } from './browser-types'
import { browserContextKey, type BrowserUtilityPage } from './browser-validation'
import type { BrowserService } from '../browser-service'

/**
 * Which browser page a conversation is about.
 *
 * A thread browser is shared by a conversation and its agent, so the app reports the
 * page in use and this unit answers where that page is   for a conversation's own
 * assistant chat, for a thread's browser, and for the agent that asks about it.
 */

/**
 * What `browser-service-conversation-pages` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface ConversationPagesHost {
  readonly agentPageTargets: BrowserService['agentPageTargets']
  readonly agentTabIds: BrowserService['agentTabIds']
  readonly agentUserPageTabIds: BrowserService['agentUserPageTabIds']
  readonly assistantPageTabIds: BrowserService['assistantPageTabIds']
  readonly ensureTab: BrowserService['ensureTab']
  readonly load: BrowserService['load']
  readonly parkTab: BrowserService['parkTab']
  readonly tabs: BrowserService['tabs']
  readonly threadBrowserPages: BrowserService['threadBrowserPages']
  readonly threads: BrowserService['threads']
  readonly validateTabNavigationUrl: BrowserService['validateTabNavigationUrl']
}

export class BrowserServiceConversationPages {
  constructor(private readonly host: ConversationPagesHost) {}

  /**
   * The page tab a browser assistant conversation answers about, when the tab is
   * live.
   *
   * A binding whose tab is gone (closed or never created in this process) reads
   * as no binding rather than as an error, so an operation reports that it has no
   * page to read instead of failing a turn over a tab the user closed.
   */
  attachedPageTab(threadId: string): BrowserTab | null {
    const tabId = this.host.assistantPageTabIds.get(threadId)
    if (!tabId) return null
    return this.host.tabs.get(tabId) ?? null
  }

  /**
   * The tab one browser utility call works on.
   *
   * Three kinds of page answer here, and `attached` is what tells the caller them
   * apart, because they are not interchangeable (see
   * {@link ATTACHED_PAGE_READ_OPERATIONS}):
   *
   *   - the page the agent opened and owns (`open`), which it edits freely;
   *   - the page assigned to this conversation by its thread browser, which is the
   *     page the user gave it and is therefore attached;
   *   - the page a browser tab's assistant conversation is bound to, which is the
   *     same rule for the global browser's strips.
   *
   * `page` picks between the first and the second, and it is honoured exactly: an
   * agent that asks for its own page is not handed the user's. The assigned page is
   * the default when the agent owns none, and `"user"` asks for it explicitly, so an
   * agent that opened a page of its own can still reach the one that holds the
   * user's session.
   *
   * The assignment belongs to the conversation, not to the project's strip. A
   * project's threads share one strip, so plenty of other tabs come and go on it;
   * what one thread was given stays that thread's page until the user closes the tab
   * or points that thread at another one (see `threadBrowserPages`). Both `"user"`
   * and `"strip"` answer it, and neither can move it onto a sibling thread's page.
   */
  utilityTarget(input: {
    projectId: string
    threadId: string
    contextKey: string
    page: BrowserUtilityPage | null
  }): { tabId: string; tab: BrowserTab; attached: boolean } | null {
    const target = this.resolveTarget(input)
    if (target) {
      const contents = target.tab.view.webContents
      this.host.agentPageTargets.set(input.contextKey, {
        tabId: target.tabId,
        url: contents.isDestroyed() ? '' : contents.getURL()
      })
      // Remember what this conversation was given, so the page survives the app
      // dropping the binding (a panel closing, a turn where no strip is on screen)
      // while the tab itself lives on. Only a tab the user closed is forgotten.
      if (input.page !== 'agent' && this.host.agentTabIds.get(input.contextKey) !== target.tabId) {
        this.host.agentUserPageTabIds.set(input.contextKey, target.tabId)
      }
    }
    return target
  }

  /** What the previous call for this context worked on, if any. */
  previousPageTarget(contextKey: string): { tabId: string; url: string } | null {
    return this.host.agentPageTargets.get(contextKey) ?? null
  }

  /** The tab one browser utility call resolves to, before the ledger is updated. */
  private resolveTarget(input: {
    projectId: string
    threadId: string
    contextKey: string
    page: BrowserUtilityPage | null
  }): { tabId: string; tab: BrowserTab; attached: boolean } | null {
    const ownedTabId = this.host.agentTabIds.get(input.contextKey)
    const owned = ownedTabId ? this.host.tabs.get(ownedTabId) : undefined
    const ownedTarget =
      owned && ownedTabId ? { tabId: ownedTabId, tab: owned, attached: false } : null
    if (input.page === 'agent') return ownedTarget
    const assigned = this.assignedPage(input.projectId, input.threadId, input.contextKey)
    if (input.page === 'user' || input.page === 'strip') {
      // A page the agent opened may itself be the page assigned to this
      // conversation, and then it is still the agent's own page: nothing changes
      // about who may edit it.
      return assigned ? { ...assigned, attached: assigned.tabId !== ownedTabId } : null
    }
    if (ownedTarget) return ownedTarget
    if (assigned) return { ...assigned, attached: true }
    const pageTabId = this.host.assistantPageTabIds.get(input.threadId)
    if (!pageTabId) return null
    const page = this.host.tabs.get(pageTabId)
    return page ? { tabId: pageTabId, tab: page, attached: true } : null
  }

  /**
   * The page this conversation was given: what its thread browser is on, else the
   * page it last worked on.
   *
   * The binding wins, because pointing this conversation's strip at another tab is
   * how the user hands the agent a different page. The pin is the fallback for the
   * moment the binding is gone while the tab lives on, so a panel closing never
   * costs a thread the tab it was given.
   */
  private assignedPage(
    projectId: string,
    threadId: string,
    contextKey: string
  ): { tabId: string; tab: BrowserTab } | null {
    return this.conversationPageTab(projectId, threadId) ?? this.pinnedConversationPage(contextKey)
  }

  /**
   * The page this conversation last worked on, while that tab is live.
   *
   * A tab the user closed is not an error and not a stale answer: the pin is
   * dropped here, and that close is the one case that earns a new tab. Nothing here
   * ever keeps naming a page that is gone.
   */
  private pinnedConversationPage(contextKey: string): { tabId: string; tab: BrowserTab } | null {
    const tabId = this.host.agentUserPageTabIds.get(contextKey)
    if (!tabId) return null
    const tab = this.host.tabs.get(tabId)
    if (tab) return { tabId, tab }
    this.host.agentUserPageTabIds.delete(contextKey)
    return null
  }

  /**
   * The box (cookie jar) one conversation's browser is using, when it has a page.
   *
   * A tab's jar is fixed when it is created, so this is what a page the agent opens
   * has to use: the user may have moved this conversation onto the personal box to
   * bring a signed-in session into it, and a page opened into the conversation's own
   * empty jar would see none of that session.
   */
  conversationBoxFor(projectId: string, threadId: string): string | null {
    return this.threadBrowserPage(projectId, threadId)?.boxId ?? null
  }

  /**
   * File the page one conversation's thread browser is on.
   *
   * The app reports this, never an agent operation: it is the user pointing a
   * conversation at a tab, and it is per conversation so that browsing in one
   * thread can never reassign another thread's page.
   */
  bindConversationPage(projectId: string, threadId: string, page: BrowserThreadBrowserPage): void {
    this.host.threadBrowserPages.set(this.conversationPageKey(projectId, threadId), page)
  }

  /** Drop that binding, for a conversation whose thread browser holds no page. */
  unbindConversationPage(projectId: string, threadId: string): void {
    this.host.threadBrowserPages.delete(this.conversationPageKey(projectId, threadId))
  }

  /**
   * Every tab an agent is working on, and the thread it belongs to.
   *
   * Both kinds of claim are here: the tab an agent opened for itself and the page a
   * conversation was assigned. A tab the user opened and handed to a thread's agent
   * is claimed the moment that agent works on it, which is what the strip's badge
   * reports. A closed tab drops out because its entry is gone.
   */
  agentTabClaims(): BrowserAgentTabClaim[] {
    const claims: BrowserAgentTabClaim[] = []
    const seen = new Set<string>()
    for (const tabId of [
      ...this.host.agentTabIds.values(),
      ...this.host.agentUserPageTabIds.values()
    ]) {
      if (seen.has(tabId)) continue
      const tab = this.host.tabs.get(tabId)
      if (!tab) continue
      seen.add(tabId)
      claims.push({ tabId, projectId: tab.projectId, threadId: tab.threadId })
    }
    return claims
  }

  /**
   * The page one conversation's thread browser is assigned, when it is live.
   *
   * Used for what an answer advertises rather than for what it does, so it never
   * mounts anything: telling an agent about a page must not cost a process.
   */
  liveConversationPage(
    projectId: string,
    threadId: string
  ): { tabId: string; tab: BrowserTab } | null {
    const binding = this.threadBrowserPage(projectId, threadId)
    if (!binding) return null
    const tab = this.host.tabs.get(binding.tabId)
    return tab ? { tabId: binding.tabId, tab } : null
  }

  /**
   * The page one conversation's thread browser is on, mounted when this process
   * holds no view for its tab.
   *
   * A tab the user left in the thread browser across a restart has no page until
   * something shows it. It is mounted offscreen and put back on its address,
   * exactly as an agent's own `open` mounts its page, so the agent can read it
   * without the user's view changing and without taking the tab over.
   */
  conversationPageTab(
    projectId: string,
    threadId: string
  ): { tabId: string; tab: BrowserTab } | null {
    const binding = this.threadBrowserPage(projectId, threadId)
    if (!binding) return null
    const live = this.host.tabs.get(binding.tabId)
    if (live) return { tabId: binding.tabId, tab: live }
    // A blank tab has no address to restore, so it has nothing to read either.
    if (binding.url === '') return null
    try {
      const url = this.host.validateTabNavigationUrl(binding.projectId, binding.boxId, binding.url)
      const tab = this.host.ensureTab(
        binding.tabId,
        binding.projectId,
        binding.threadId,
        binding.boxId
      )
      tab.initialNavigationStarted = true
      this.host.parkTab(binding.tabId)
      this.host.load(binding.tabId, url)
      return { tabId: binding.tabId, tab }
    } catch (error: unknown) {
      Logger.dev('A thread browser page could not be mounted for the agent:', error)
      return null
    }
  }

  /**
   * What one conversation's agent is told about the page the thread browser is on
   * when that is not the page that answered.
   *
   * An agent that opened a page of its own would otherwise never learn that the
   * user has one, which is exactly how a signed-in page stayed invisible to it. The
   * hint names the page and the argument that reaches it, and it is empty when the
   * page that answered already is that page.
   */
  threadBrowserHint(
    projectId: string,
    threadId: string,
    answeredTabId: string | null,
    contextKey: string
  ): {
    threadBrowser?: {
      tabId: string
      url: string
      title: string
      boxId: string | null
      detail: string
    }
    /** The tab `page "user"` answers, present when the answer came from another. */
    userPage?: { tabId: string; url: string; title: string }
  } {
    const page = this.liveConversationPage(projectId, threadId)
    const pinned = this.pinnedConversationPage(contextKey)
    const answered = answeredTabId
    const hint: {
      threadBrowser?: {
        tabId: string
        url: string
        title: string
        boxId: string | null
        detail: string
      }
      userPage?: { tabId: string; url: string; title: string }
    } = {}
    if (pinned && pinned.tabId !== answered) hint.userPage = this.describePage(pinned)
    if (page && page.tabId !== answered) {
      const strip = this.describePage(page)
      hint.threadBrowser = {
        ...strip,
        boxId: page.tab.boxId,
        detail:
          'This conversation\u2019s thread browser is on this page, the one the agent was given. Pass page "user" or page "strip" to read or act on it, or page "agent" for a page you opened.'
      }
    }
    return hint
  }

  /** What one live tab is showing, as the agent is told about it. */
  private describePage(page: { tabId: string; tab: BrowserTab }): {
    tabId: string
    url: string
    title: string
  } {
    const contents = page.tab.view.webContents
    const url = contents.isDestroyed() ? '' : contents.getURL()
    return {
      tabId: page.tabId,
      url,
      title: contents.isDestroyed() ? url : contents.getTitle()
    }
  }

  /**
   * The binding one conversation's thread browser filed, when the page it names is
   * still one of that conversation's pages.
   *
   * A binding is a reference, not an authority: a page answers only while it
   * belongs to the same browser, so a record that outlived the tab it was filed for
   * can never hand a conversation a page from another project or another hidden
   * container.
   */
  threadBrowserPage(projectId: string, threadId: string): BrowserThreadBrowserPage | null {
    const page = this.host.threadBrowserPages.get(this.conversationPageKey(projectId, threadId))
    if (!page) return null
    const scope = this.conversationScope(projectId, threadId)
    return this.conversationScope(page.projectId, page.threadId) === scope ? page : null
  }

  /**
   * The key one conversation's assigned page is filed under.
   *
   * Every thread of a project keeps its own assignment, so the key is the
   * conversation. A hidden container that already groups its conversations into one
   * browser (an assistant's tasks) keeps that grouping, because those threads share
   * one strip and one page by design.
   */
  private conversationPageKey(projectId: string, threadId: string): string {
    const scope = this.conversationScope(projectId, threadId)
    const grouped = scope !== projectId && scope !== threadId
    return grouped ? scope : browserContextKey(projectId, threadId)
  }

  /**
   * The scope a thread's browsers belong to, as the strip groups its tabs by.
   *
   * A project's threads share one thread browser, an inbox chat owns its own, and
   * an assistant's tasks share the assistant (see `conversationScopeId`). The
   * global browser's own project holds every browser conversation's tabs, so it is
   * never addressed by scope: those pages arrive through
   * `browser:bindAssistantPage`.
   */
  conversationScope(projectId: string, threadId: string): string {
    if (projectId === GLOBAL_BROWSER_PROJECT_ID) return `browser-conversation:${threadId}`
    // Only an assistant's tasks file a browser under something other than the
    // project or the thread, so only there does resolving a scope need the thread
    // row. Reading it on every browser operation would put a database read on the
    // path of every click.
    const assistantId =
      projectId === ASSISTANT_SPACE_ID
        ? (this.host.threads.get(threadId)?.assistantId ?? null)
        : null
    return conversationScopeId(projectId, threadId, assistantId)
  }
}
