import { invoke, subscribe } from '$lib/ipc.svelte'
import type { BrowserFindResult } from '$shared/ipc-contract'

/**
 * What one browser tab's find bar is showing.
 *
 * `query` is kept when the bar closes, because that is what a browser does: the
 * next Cmd/Ctrl+F comes back to the text the user last searched rather than an
 * empty field. `focusTrigger` is the "show this and take the keyboard" gesture,
 * bumped on every open so a second press while the bar is up selects the query
 * already in it.
 */
export interface BrowserFindTabState {
  open: boolean
  query: string
  matchCase: boolean
  matches: number
  /** The 1-based position of the match the page is on, as the page reports it. */
  activeMatchOrdinal: number
  focusTrigger: number
}

/** A tab nobody has searched reads as this, and it never changes identity. */
const CLOSED_TAB: BrowserFindTabState = Object.freeze({
  open: false,
  query: '',
  matchCase: false,
  matches: 0,
  activeMatchOrdinal: 0,
  focusTrigger: 0
})

/** Which way a find step moves. */
export type BrowserFindDirection = 'next' | 'previous'

/**
 * Find in the browser's pages, keyed by tab.
 *
 * The page is a native `WebContentsView`, so no renderer can search it: this is
 * the renderer's half of Chromium's own find, and it is a store rather than a
 * component's local state because two surfaces show a tab's page (the sidebar
 * panel, and the global Browser view's frame) and a shortcut can arrive while
 * either of them owns the keyboard. One authority means the bar that is on screen
 * is the one that answers, and the state a user left behind is what comes back.
 *
 * Everything the bar draws is main's answer, never this store's guess: the count
 * and the ordinal arrive over `browser:findResult`, because only the page's own
 * engine knows how many matches there are.
 */
class BrowserFindState {
  /** Per-tab state, created on first use so a tab that never searched costs
   *  nothing. Mutated in place: replacing an entry would leave a mounted bar
   *  reading the state it had when it rendered. */
  private readonly tabs = $state<Record<string, BrowserFindTabState>>({})

  /** Whether the one app-lifetime result subscription is wired. */
  private started = false

  /** The find bar of one tab. */
  stateFor(tabId: string): BrowserFindTabState {
    return this.tabs[tabId] ?? CLOSED_TAB
  }

  /** Show a tab's find bar and hand its field the keyboard. A second press
   *  re-focuses and selects the query already there, exactly as Chrome does. */
  open(tabId: string): void {
    this.start()
    const state = this.ensure(tabId)
    state.open = true
    state.focusTrigger += 1
  }

  /**
   * Step within a tab's search.
   *
   * With the bar closed this opens it instead of stepping: there is no session
   * left to step in, and re-opening re-searches the query it remembers, which is
   * the useful reading of "find next" when find is not on screen.
   */
  step(tabId: string, direction: BrowserFindDirection): void {
    this.start()
    const state = this.ensure(tabId)
    if (!state.open || state.query.length === 0) {
      state.open = true
      state.focusTrigger += 1
      return
    }
    this.search(tabId, state, { findNext: true, forward: direction === 'next' })
  }

  /** Take a settled query and search the page for it. */
  setQuery(tabId: string, query: string): void {
    const state = this.ensure(tabId)
    state.query = query
    this.search(tabId, state, { findNext: false, forward: true })
  }

  /** Search the same query again, case-sensitively or not. */
  setMatchCase(tabId: string, matchCase: boolean): void {
    const state = this.ensure(tabId)
    state.matchCase = matchCase
    this.search(tabId, state, { findNext: false, forward: true })
  }

  /**
   * Close a tab's find bar, leaving the page's highlight off and the keyboard
   * back in the page.
   *
   * The query is deliberately kept: a browser remembers what was searched, so the
   * next open comes back to it and searches it again.
   */
  close(tabId: string): void {
    const state = this.tabs[tabId]
    if (!state || !state.open) return
    state.open = false
    state.matches = 0
    state.activeMatchOrdinal = 0
    void invoke('browser:stopFindInPage', tabId, 'clearSelection').catch(() => {})
    // The bar was the surface holding the keyboard, so the page takes it back:
    // find was closed to keep reading the page.
    void invoke('browser:focusPage', tabId).catch(() => {})
  }

  /**
   * Drop a tab's find state because the surface showing its page went away.
   *
   * The page itself is parked rather than destroyed, so its highlight has to be
   * taken off it here: a search that is no longer on screen must not still be
   * painted on the page the user returns to.
   */
  forget(tabId: string): void {
    const state = this.tabs[tabId]
    if (!state) return
    const wasOpen = state.open
    delete this.tabs[tabId]
    if (wasOpen) void invoke('browser:stopFindInPage', tabId, 'clearSelection').catch(() => {})
  }

  /** Ask a tab's page to search, or to let go of what it is showing. */
  private search(
    tabId: string,
    state: BrowserFindTabState,
    options: { findNext: boolean; forward: boolean }
  ): void {
    if (state.query.length === 0) {
      // An empty field is not a search for nothing: it is the user taking the
      // highlight off the page, so the session ends and the count goes with it.
      state.matches = 0
      state.activeMatchOrdinal = 0
      void invoke('browser:stopFindInPage', tabId, 'clearSelection').catch(() => {})
      return
    }
    // A fresh search has no answer yet, so the count from the query before it is
    // dropped rather than shown against text it does not belong to. A step keeps
    // the count it has: the page is moving within the same set of matches.
    if (!options.findNext) {
      state.matches = 0
      state.activeMatchOrdinal = 0
    }
    void invoke('browser:findInPage', tabId, {
      text: state.query,
      forward: options.forward,
      findNext: options.findNext,
      matchCase: state.matchCase
    }).catch(() => {})
  }

  /** Apply what the page reported, if it is still what this tab is searching. */
  private applyResult(result: BrowserFindResult): void {
    const state = this.tabs[result.tabId]
    if (!state || !state.open) return
    // A report naming a query the field no longer holds belongs to a search the
    // user has already moved past, so the count on screen stays the current one.
    if (result.text !== state.query) return
    state.matches = result.matches
    state.activeMatchOrdinal = result.activeMatchOrdinal
  }

  /** Register the result subscription once, on the first open. */
  private start(): void {
    if (this.started) return
    this.started = true
    subscribe('browser:findResult', (result) => this.applyResult(result))
  }

  /** The state of a tab, created on first use. Read back after the write so the
   *  caller holds the reactive entry rather than the object it handed over. */
  private ensure(tabId: string): BrowserFindTabState {
    if (!this.tabs[tabId]) {
      this.tabs[tabId] = {
        open: false,
        query: '',
        matchCase: false,
        matches: 0,
        activeMatchOrdinal: 0,
        focusTrigger: 0
      }
    }
    return this.tabs[tabId]
  }
}

export const browserFindState = new BrowserFindState()
