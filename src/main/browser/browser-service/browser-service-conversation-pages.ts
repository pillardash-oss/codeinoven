import { conversationScopeId, ASSISTANT_SPACE_ID } from '../../../lib/types'
import type { BrowserThreadBrowserPage } from '../../../lib/ipc-contract'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { type BrowserTab } from './browser-types'
import { type BrowserUtilityPage } from './browser-validation'
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
   *   - the page this conversation's thread browser is in use on, which is the
   *     page the user is reading and is therefore attached;
   *   - the page a browser tab's assistant conversation is bound to, which is the
   *     same rule for the global browser's strips.
   *
   * `page` picks between the first and the second, and it is honoured exactly: an
   * agent that asks for its own page is not handed the user's. The thread browser's
   * page is the default when the agent owns none, and `"user"` asks for it
   * explicitly, so an agent that opened a page of its own can still reach the one
   * that holds the user's session.
   *
   * A project's threads share one strip, so the tab the thread browser is on is
   * not stable: the user switching tabs or a sibling thread showing a preview
   * moves it. `"user"` therefore answers the tab this agent resolved the first
   * time and keeps answering it while it lives (see `agentUserPageTabIds`), which
   * is what stops another conversation's page from becoming this one's target;
   * `"strip"` is the explicit way to move onto whatever the strip shows now.
   */
  utilityTarget(input: {
    scope: string
    threadId: string
    contextKey: string
    page: BrowserUtilityPage | null
  }): { tabId: string; tab: BrowserTab; attached: boolean } | null {
    const ownedTabId = this.host.agentTabIds.get(input.contextKey)
    const owned = ownedTabId ? this.host.tabs.get(ownedTabId) : undefined
    const ownedTarget =
      owned && ownedTabId ? { tabId: ownedTabId, tab: owned, attached: false } : null
    if (input.page === 'agent') return ownedTarget
    if (input.page === 'strip') {
      const stripPage = this.pinConversationPage(input.scope, input.contextKey, ownedTabId)
      return stripPage ? { ...stripPage, attached: stripPage.tabId !== ownedTabId } : null
    }
    if (input.page === 'user') {
      const userPage =
        this.pinnedConversationPage(input.contextKey) ??
        this.pinConversationPage(input.scope, input.contextKey, ownedTabId)
      if (!userPage) return null
      // A page the agent opened may itself be the tab the thread browser is on, and
      // then it is still the agent's own page: nothing changes about who may edit
      // it.
      return { ...userPage, attached: userPage.tabId !== ownedTabId }
    }
    if (ownedTarget) return ownedTarget
    const conversationPage =
      this.pinnedConversationPage(input.contextKey) ??
      this.pinConversationPage(input.scope, input.contextKey, ownedTabId)
    if (conversationPage) return { ...conversationPage, attached: true }
    const pageTabId = this.host.assistantPageTabIds.get(input.threadId)
    if (!pageTabId) return null
    const page = this.host.tabs.get(pageTabId)
    return page ? { tabId: pageTabId, tab: page, attached: true } : null
  }

  /**
   * The thread browser page this agent already resolved, while that tab is live.
   *
   * A tab the user closed is not an error and not a stale answer: the pin is
   * dropped here, so the next call resolves the strip's page afresh exactly as the
   * first one did.
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
   * Resolve the page the thread browser is on now and pin it to this agent.
   *
   * A page the agent opened itself is not pinned: it is already reachable as the
   * agent's own page, and pinning it would keep naming a tab the next `open`
   * replaces.
   */
  private pinConversationPage(
    scope: string,
    contextKey: string,
    ownedTabId: string | undefined
  ): { tabId: string; tab: BrowserTab } | null {
    const page = this.conversationPageTab(scope)
    if (!page) {
      this.host.agentUserPageTabIds.delete(contextKey)
      return null
    }
    if (page.tabId !== ownedTabId) this.host.agentUserPageTabIds.set(contextKey, page.tabId)
    return page
  }

  /**
   * The page one conversation's thread browser is in use on, when it is live.
   *
   * Used for what an answer advertises rather than for what it does, so it never
   * mounts anything: telling an agent about a page must not cost a process.
   */
  liveConversationPage(scope: string): { tabId: string; tab: BrowserTab } | null {
    const binding = this.threadBrowserPage(scope)
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
  conversationPageTab(scope: string): { tabId: string; tab: BrowserTab } | null {
    const binding = this.threadBrowserPage(scope)
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
    scope: string,
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
    const page = this.liveConversationPage(scope)
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
          'This conversation\u2019s thread browser is showing this page now, and it moves whenever the user or another conversation opens something in it. Pass page "strip" to read or act on it, or page "agent" for a page you opened.'
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
   * The binding one conversation's thread browser filed, when the page it names
   * belongs to that conversation.
   *
   * A binding is a reference, not an authority: a page answers only for the
   * conversation whose browser it is in, so a scope that outlived the tab it was
   * filed with can never hand one conversation's page to another's agent.
   */
  threadBrowserPage(scope: string): BrowserThreadBrowserPage | null {
    const page = this.host.threadBrowserPages.get(scope)
    if (!page) return null
    return this.conversationScope(page.projectId, page.threadId) === scope ? page : null
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
