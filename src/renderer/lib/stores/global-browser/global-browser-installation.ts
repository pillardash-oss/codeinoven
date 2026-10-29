import { invoke } from '$lib/ipc.svelte'
import { type BrowserPeekPhase } from '$lib/components/browser/browser-peek-transition'
import type { BrowserOpenRequestContext } from '$shared/ipc-contract'
import { type GlobalBrowserTabsSnapshot } from '$shared/browser/global-browser-tabs'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
import { contextSidebarState } from '../context-sidebar.svelte'
import { logRendererDev } from '$lib/system/renderer-logger'
import { browserVisibility } from '../browser-visibility.svelte'
import { browserAudio } from '../browser-audio.svelte'
import {
  runtimeBoxFromPersisted,
  runtimeGroupFromPersisted,
  runtimeTabFromPersisted
} from '../global-browser-persistence'
import {
  browserTabTitleForUrl,
  DEFAULT_BOX_ID,
  type GlobalBrowserTab
} from '../global-browser-types'
import { withDefaultBox } from '../global-browser.svelte'
import type { GlobalBrowserState } from '../global-browser.svelte'

/** GlobalBrowserState installation: one concern, moved verbatim from the composition root. */
export class GlobalBrowserStateInstallation {
  constructor(private readonly host: GlobalBrowserState) {}

  adoptSnapshot(snapshot: GlobalBrowserTabsSnapshot): void {
    this.host.tabs = snapshot.tabs.map(runtimeTabFromPersisted)
    this.host.groups = snapshot.groups.map(runtimeGroupFromPersisted)
    this.host.boxes = withDefaultBox((snapshot.boxes ?? []).map(runtimeBoxFromPersisted))
    this.adoptDefaultBox(snapshot.defaultBoxId)
    // Through `setActiveTab`, not a direct assignment: the restored tab is the one
    // the browser view is about to show, and it has to count as a visit for the
    // Ctrl+Tab switcher exactly as an activation does. `markOpened` runs before
    // this read lands, so it cannot cover the cold case on its own.
    this.host.units['runtime'].setActiveTab(snapshot.activeTabId)
  }

  /** Take a stored default box, narrowed to one this profile actually offers. A
   *  value that names no box, or one this strip does not hold, is the profile's
   *  own box, so the fallback can never point at a jar nothing owns. */
  adoptDefaultBox(boxId: string | null | undefined): void {
    const known = boxId === DEFAULT_BOX_ID || this.host.boxes.some((box) => box.id === boxId)
    this.host.defaultBoxId = known && typeof boxId === 'string' ? boxId : DEFAULT_BOX_ID
  }

  /**
   * Adopt a tab the main process created on a page's behalf.
   *
   * Main parks and loads the popup before this arrives, so the renderer only has
   * to give it a row. Ordinary project tabs belong to the sidebar; ephemeral
   * peeks from both browser surfaces share this lifecycle.
   */
  adoptOpenRequest(
    url: string,
    context?: BrowserOpenRequestContext,
    peekOwnerThreadId?: string
  ): void {
    if (!context || (!context.peek && context.projectId !== GLOBAL_BROWSER_PROJECT_ID)) return
    const tabId = context.requestedTabId
    if (!tabId) return
    const existing = this.host.tabs.find((tab) => tab.id === tabId)
    if (existing) {
      if (url && existing.url !== url) existing.url = url
      if (context.reveal) this.host.activate(existing.id)
      this.host.units['queries'].persist()
      return
    }
    if (!context.peek) this.host.units['runtime'].enforceTabCap()
    const now = Date.now()
    const sourceTab = context.sourceTabId ? this.host.tabById(context.sourceTabId) : null
    const newTab: GlobalBrowserTab = {
      id: tabId,
      title: browserTabTitleForUrl(url),
      customTitle: null,
      url,
      favicon: null,
      // A popup belongs beside the page that opened it.
      groupId: sourceTab?.groupId ?? this.host.activeTab?.groupId ?? null,
      // Main creates the tab in the opener's jar and hands back the box it
      // used, so the row and the session agree from the first show. Main is the
      // only side that knows the true owner when a background tab opens the
      // popup, so its answer is trusted over the active tab's box.
      boxId: context.boxId ?? null,
      createdAt: now,
      lastUsedAt: now,
      hibernated: false,
      pinned: false,
      pinnedAt: null,
      assistantThreadId: null,
      color: null,
      iconType: null,
      customSvg: null,
      imagePath: null
    }
    if (context.peek) {
      const sourceTabId = context.sourceTabId ?? browserVisibility.sourceTabId
      logRendererDev(
        `peek request ${url} for source ${sourceTabId ?? 'none'} (surface ${browserVisibility.sourceTabId ?? 'none'})`
      )
      if (!sourceTabId) return
      const previous = this.host.peeks.get(sourceTabId)
      if (previous?.tab.id === tabId) return
      if (previous) {
        this.host.runtime.delete(previous.tab.id)
        browserAudio.forget(previous.tab.id)
      }
      const peek = $state({
        tab: newTab,
        projectId: context.projectId,
        threadId: context.threadId,
        ownerThreadId:
          peekOwnerThreadId ??
          (context.projectId === GLOBAL_BROWSER_PROJECT_ID
            ? context.threadId
            : (contextSidebarState.threadIdForProject(context.projectId) ?? context.threadId)),
        phase: 'opening' as BrowserPeekPhase,
        origin: context.origin ?? null,
        documentSeen: false,
        landed: false
      })
      this.host.peeks.set(sourceTabId, peek)
      // Native loading begins before a lazy renderer can subscribe. Read once
      // so a page that already loaded cannot remain behind the loading gate.
      void invoke('browser:pageState', tabId)
        .then((state) => {
          if (state && !this.host.runtime.has(tabId) && this.host.tabById(tabId))
            this.host.applyPageState(state)
        })
        .catch(() => {})
      return
    }
    this.host.tabs = this.host.units['runtime'].insertTabBeside(newTab, context.sourceTabId)
    if (context.reveal) this.host.activate(tabId)
    this.host.units['queries'].persist()
  }
}
