import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { toast } from 'svelte-sonner'
import { logRendererError } from '$lib/system/renderer-logger'
import type {
  BrowserDesignTab,
  BrowserInspectorEvent,
  BrowserInspectorMarker,
  BrowserInspectorRect,
  BrowserInspectorTheme
} from '$shared/ipc-contract'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { designElementReference, designEntryFromUrl } from '$lib/design-element-reference'
import { contextSidebarState } from './context-sidebar.svelte'
import {
  mergeReferenceById,
  responseReferencesState,
  type ResponseReferenceAnchor
} from './response-references.svelte'

/**
 * The in-app browser's design inspection session.
 *
 * Inspecting a design and commenting on its elements is a property of the TAB,
 * not of the panel that happens to be drawing it. While it lived inside the
 * panel, moving between the sidebar and the full screen surface dropped the
 * mode, the pins and the open comment, and the panel's own teardown disarmed the
 * page, so one tab behaved like two different browsers depending on where it was
 * shown. The session lives here instead, once, and a panel only renders it.
 *
 * The session owns:
 *
 *   - which tabs are armed, and the pins each one draws
 *   - the application theme the injected overlay is drawn with
 *   - the event loop back from the page: a pick becomes a composer reference and
 *     opens its comment bubble, and a pin click or a jump from the composer
 *     reopens the bubble on the element it belongs to
 *
 * Pushing the pins and the theme from here rather than from a panel is what
 * makes the session survive a surface switch: main holds the last set it was
 * given and replays it into every new document, so it does not matter which
 * surface, or how many, are mounted at the time.
 */

/** The app's design tokens, and the custom property each one is read from. */
const INSPECTOR_THEME_TOKENS = {
  surface: '--color-surface',
  elevated: '--color-elevated',
  border: '--color-border',
  foreground: '--color-foreground',
  muted: '--color-muted',
  accent: '--color-accent',
  font: '--font-app'
} as const satisfies Record<keyof BrowserInspectorTheme, string>

const THEME_KEYS = Object.keys(INSPECTOR_THEME_TOKENS) as (keyof BrowserInspectorTheme)[]

interface TabOwner {
  projectId: string
  threadId: string
}

class BrowserInspectorSession {
  /** Tabs whose page is armed for picking. */
  private readonly armed = new SvelteSet<string>()
  /** The design each tab is serving, mirrored from `browser:state`. A tab that
   *  is not serving a design is not inspectable, and never gets pins. */
  private readonly designs = new SvelteMap<string, BrowserDesignTab>()
  /**
   * The comment bubble each tab has open: the reference it belongs to, and where
   * the element was when the reader picked or reopened it.
   *
   * The bubble is the app's own component, so this session owns what the page
   * used to own outright: which comment is open, and where it sits. The anchor is
   * the place main resolved for the element, in the app window's coordinates,
   * which is the only space the bubble can be positioned in.
   */
  private readonly editing = new SvelteMap<
    string,
    { referenceId: string; anchor: BrowserInspectorRect }
  >()
  /** Last theme read from the stylesheet, reused while a token is unavailable. */
  private themeCache: BrowserInspectorTheme | null = null

  /**
   * Whether {@link start} has wired the session. Inspection is a browser-only
   * concern and the browser is not part of the first paint, so the subscriptions
   * and the document observer wait for the runtime seam.
   */
  private started = false

  /**
   * Wire the session's listeners. Idempotent.
   *
   * The document observer is deliberately here rather than in the constructor:
   * the store is built while the renderer document evaluates, and observing
   * `documentElement` for the app's whole lifetime to theme a page that does not
   * exist is work the first paint should not carry.
   */
  start(): void {
    if (this.started) return
    this.started = true
    subscribe('browser:state', (state) => this.notePageState(state.tabId, state.design))
    subscribe('browser:inspector', (tabId, event) => this.onPageEvent(tabId, event))
    // A tab reports its state when it loads, and a restored or preloaded tab can
    // load before this session was started (the browser is lazy, and this is the
    // seam that starts it). A tab the session never heard of is neither
    // inspectable nor reopenable, and a pick made on it carries no folder, so the
    // state every open tab already has is read once here instead of waiting for a
    // page reload to report it again.
    this.readOpenTabs()
    // Pins and the open comment are consequences of the reference list, which is
    // written by the page, the composer and the panel alike, so the session
    // follows the list rather than being told by each writer.
    responseReferencesState.subscribe((projectId, threadId) =>
      this.onReferencesChanged(projectId, threadId)
    )
    // The theme is an attribute swap on the document element (the setting, a
    // system change, a project swap), so one observer catches every one of them.
    new MutationObserver(() => this.publishTheme()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    })
  }

  /** Whether this tab is serving a design, which is what inspection needs. */
  canInspect(tabId: string): boolean {
    return this.designs.has(tabId)
  }

  isArmed(tabId: string): boolean {
    return this.armed.has(tabId)
  }

  /** The pins this tab's page draws, in the composer's own numbering. */
  markersFor(tabId: string): BrowserInspectorMarker[] {
    const owner = this.ownerOf(tabId)
    if (!owner) return []
    return this.markersForOwner(owner, tabId)
  }

  /** The pins one conversation's references draw on one tab. */
  private markersForOwner(owner: TabOwner, tabId: string): BrowserInspectorMarker[] {
    return responseReferencesState
      .forThread(owner.projectId, owner.threadId)
      .flatMap((reference, index) =>
        reference.kind === 'design' && reference.tabId === tabId
          ? [
              {
                id: reference.id,
                number: index + 1,
                comment: reference.comment ?? '',
                selector: reference.selector ?? ''
              }
            ]
          : []
      )
  }

  toggle(tabId: string): void {
    this.setArmed(tabId, !this.armed.has(tabId))
  }

  /** The comment bubble this tab has open, and where the element sits. */
  editingFor(tabId: string): { referenceId: string; anchor: BrowserInspectorRect } | null {
    return this.editing.get(tabId) ?? null
  }

  /** Close this tab's comment bubble. The comment itself is left alone. */
  closeComment(tabId: string): void {
    this.editing.delete(tabId)
  }

  /**
   * Arm or disarm picking on one tab.
   *
   * Deliberately not tied to any panel's lifetime: two surfaces can show the
   * same tab, and a surface that is going away is not a reason to end the
   * session the user opened. The mode ends when the user turns it off, when the
   * page does (Escape), or when the tab stops serving a design.
   */
  setArmed(tabId: string, armed: boolean): void {
    if (armed) this.armed.add(tabId)
    else this.armed.delete(tabId)
    // Turning the mode off leaves the open comment and its element's border
    // alone on purpose: the reader switches the mode off to stop the page
    // answering the pointer, not to lose the comment they were writing. The
    // bubble has its own close, and a page that stops serving a design closes it.
    const theme = this.themeTokens()
    void invoke('browser:inspectSetArmed', tabId, armed, theme ?? undefined)
      .then(() => {
        if (armed) this.publishMarkers(tabId)
        else void invoke('browser:inspectFocus', tabId, null, false).catch(() => {})
      })
      .catch(() => this.armed.delete(tabId))
  }

  /**
   * Put one commented element back in front of the reader: arm the tab if the
   * session is not already running on it, highlight the element, scroll it into
   * view, and open its comment. This is what a comment clicked in the composer
   * does, and it is the mirror of the document annotation's jump to its passage.
   */
  focusComment(tabId: string, referenceId: string): void {
    void this.restoreAndFocus(tabId, referenceId, this.ownerOf(tabId)).catch((failure: unknown) => {
      logRendererError('The design annotation could not be focused.', failure)
      toast.error('Could not focus this design annotation. Try opening its browser tab again.')
    })
  }

  /**
   * Read the page state of every browser tab that is already open.
   *
   * Bounded by the number of open tabs (a handful), and each read is one IPC
   * round trip, so this costs nothing at a seam that runs once per renderer.
   */
  private readOpenTabs(): void {
    for (const tab of contextSidebarState.browserTabs) {
      if (tab.kind !== 'browser') continue
      void this.readPageState(tab.id)
    }
  }

  /**
   * Ask main what one tab is serving, and mirror it.
   *
   * The answer is the same report `browser:state` carries, read on demand rather
   * than waited for: that report is a broadcast, and a listener that starts after
   * the page loaded never receives it.
   */
  private async readPageState(tabId: string): Promise<BrowserDesignTab | null> {
    try {
      const state = await invoke('browser:pageState', tabId)
      if (!state) return null
      this.notePageState(state.tabId, state.design)
      return state.design
    } catch (failure: unknown) {
      logRendererError("A browser tab's page state could not be read.", failure)
      return null
    }
  }

  /**
   * Bring a commented design element back in front of the reader, reopening the
   * page it was picked from when that page is no longer open.
   *
   * A comment outlives the tab it was written in: the page is closed, the comment
   * stays in the composer, and the comment is the reason the page can be brought
   * back at all. So the edit action reopens that screen in the thread's browser
   * and reveals the element again, instead of reporting a page the reader is
   * expected to go and find. A screen whose folder or entry is gone from the
   * project cannot be reopened, and that is reported rather than opened onto a
   * different page.
   */
  revealComment(projectId: string, threadId: string, reference: ResponseReferenceAnchor): void {
    const tabId = reference.tabId
    if (tabId && this.isOpenDesignTab(tabId)) {
      this.focusComment(tabId, reference.id)
      return
    }
    // The tab can still be open and serving the design even though this session
    // does not know it yet (its report arrived before the session was started),
    // so an unknown tab is read before the comment is declared unrecoverable.
    if (tabId && !reference.directory && this.isOpenBrowserTab(tabId)) {
      void this.readPageState(tabId).then(() => {
        if (tabId && this.isOpenDesignTab(tabId)) {
          this.focusComment(tabId, reference.id)
          return
        }
        this.revealOnStoredDesign(projectId, threadId, this.withDesignFolder(tabId, reference))
      })
      return
    }
    this.revealOnStoredDesign(projectId, threadId, reference)
  }

  /** The part of {@link revealComment} that needs a known design folder. */
  private revealOnStoredDesign(
    projectId: string,
    threadId: string,
    reference: ResponseReferenceAnchor
  ): void {
    const tabId = reference.tabId
    const directory = reference.directory
    if (!directory) {
      // A reference written before a design comment carried its folder cannot be
      // reopened, and its page is not open, so the report is the only honest
      // answer.
      toast.error('The design this comment was made on is no longer open.', {
        description: reference.label
      })
      return
    }
    // The same screen can already be open in another tab (the reader reopened it
    // themselves, or the thread's own tab is showing it), and a second copy of one
    // page would be a page the comment is not drawn on.
    const shown = this.openTabShowing(reference, directory)
    if (shown) {
      if (tabId && tabId !== shown) this.rebindReferences(projectId, threadId, tabId, shown)
      contextSidebarState.focus(shown)
      this.focusComment(shown, reference.id)
      return
    }
    void this.reopenAndFocus(projectId, threadId, reference, directory, tabId).catch(
      (failure: unknown) => {
        logRendererError('The design a comment was made on could not be reopened.', failure)
        toast.error('The design this comment was made on is no longer in this project.', {
          description: directory
        })
      }
    )
  }

  /**
   * A reference that gained the folder of the design its tab is serving.
   *
   * A pick writes the folder it knows at the time. A tab this session learned
   * about late answers with its own folder, which is what lets a comment made on
   * it be reopened afterwards.
   */
  private withDesignFolder(
    tabId: string,
    reference: ResponseReferenceAnchor
  ): ResponseReferenceAnchor {
    const design = this.designs.get(tabId)
    if (!design) return reference
    const entry = designEntryFromUrl(
      contextSidebarState.browserTabs.find((tab) => tab.id === tabId)?.url ?? '',
      design.origin
    )
    return {
      ...reference,
      directory: design.directory,
      ...(reference.designEntry || !entry ? {} : { designEntry: entry })
    }
  }

  /** Whether a tab is open in the browser, whatever it is serving. */
  private isOpenBrowserTab(tabId: string): boolean {
    return contextSidebarState.browserTabs.some((tab) => tab.id === tabId && tab.kind === 'browser')
  }

  /**
   * An open tab already showing the page a comment was made on, if there is one.
   *
   * A comment names its screen by folder and entry file, so a tab serving that
   * folder and showing that entry is the same page even though it is a different
   * tab: the element is on it, and focusing it is what the reader asked for.
   */
  private openTabShowing(reference: ResponseReferenceAnchor, directory: string): string | null {
    for (const tab of contextSidebarState.browserTabs) {
      const design = this.designs.get(tab.id)
      if (!design || design.directory !== directory) continue
      if (!reference.designEntry) return tab.id
      if (designEntryFromUrl(tab.url, design.origin) === reference.designEntry) return tab.id
    }
    return null
  }

  /** Whether a tab is open and still serving the design a comment was made on. */
  private isOpenDesignTab(tabId: string): boolean {
    if (!this.designs.has(tabId)) return false
    return contextSidebarState.browserTabs.some((tab) => tab.id === tabId)
  }

  /**
   * Show the commented page again and land the comment on its element.
   *
   * The page is opened through the app's own route for a design screen, so the
   * folder is served and the tab is marked as a design before it loads: the
   * reopened tab has to be inspectable, or the comment would arrive on a page
   * that cannot be picked from. Reopening is also what asks the question the
   * user cares about, because a folder or entry that no longer exists fails here
   * rather than loading a substitute.
   */
  private async reopenAndFocus(
    projectId: string,
    threadId: string,
    reference: ResponseReferenceAnchor,
    directory: string,
    closedTabId: string | undefined
  ): Promise<void> {
    const opened = await invoke(
      'design:open',
      projectId,
      threadId,
      directory,
      reference.designEntry ?? null,
      true,
      'design'
    )
    contextSidebarState.focus(opened.tabId)
    // A pin is drawn for the tab its reference names, and the reopened page can be
    // a different tab from the closed one (a screen tab of its own only when the
    // pick came from a board-opened screen), so the comments pinned to the closed
    // tab move onto this one before the pins are published.
    if (closedTabId && closedTabId !== opened.tabId) {
      this.rebindReferences(projectId, threadId, closedTabId, opened.tabId)
    }
    await this.restoreAndFocus(opened.tabId, reference.id, { projectId, threadId })
  }

  /** Move every comment pinned to a closed tab onto the tab that reopened it. */
  private rebindReferences(
    projectId: string,
    threadId: string,
    fromTabId: string,
    toTabId: string
  ): void {
    const references = responseReferencesState.forThread(projectId, threadId)
    if (!references.some((reference) => reference.tabId === fromTabId)) return
    responseReferencesState.setForThread(
      projectId,
      threadId,
      references.map((reference) =>
        reference.tabId === fromTabId ? { ...reference, tabId: toTabId } : reference
      )
    )
  }

  private async restoreAndFocus(
    tabId: string,
    referenceId: string,
    owner: TabOwner | null
  ): Promise<void> {
    this.armed.add(tabId)
    const theme = this.themeTokens()
    await invoke('browser:inspectSetArmed', tabId, true, theme ?? undefined)
    // A reopened page's tab can be newer than the sidebar's own tab list, so the
    // pins come from the conversation the caller named rather than from a lookup
    // of the tab. Without an owner there is nothing to publish and the pins arrive
    // with the page's own state report.
    if (owner) await invoke('browser:inspectMarkers', tabId, this.markersForOwner(owner, tabId))
    await invoke('browser:inspectFocus', tabId, referenceId, true)
  }

  /** Mirror the design a tab is serving, and end the session when it stops. */
  private notePageState(tabId: string, design: BrowserDesignTab | null): void {
    if (design) {
      this.designs.set(tabId, design)
      this.publishMarkers(tabId)
      return
    }
    if (!this.designs.delete(tabId)) return
    // The tab left its design folder, so the element a comment was pinned to is
    // gone with the document that held it: the border has nothing left to outline
    // and the bubble has nothing left to sit beside.
    this.editing.delete(tabId)
    // A tab that navigated away from its design folder is no longer inspectable,
    // so the session cannot stay armed for a page that no longer offers it.
    if (this.armed.has(tabId)) this.setArmed(tabId, false)
  }

  /**
   * One report from the page's inspector.
   *
   * `pick` is a fresh element, which becomes a composer reference and opens its
   * comment bubble; `open` is a click on an existing pin, or a jump to one from
   * the composer, which reopens that element's bubble. `closed` is inspect mode
   * ending on the page's own terms, which ends the mode and leaves the open
   * comment where it is. The bubble is the app's own component, so the comment
   * text never travels through the page at all.
   */
  private onPageEvent(tabId: string, event: BrowserInspectorEvent, read: boolean = false): void {
    if (event.kind === 'closed') {
      this.armed.delete(tabId)
      return
    }
    // A pick is written into a composer reference that names the design folder it
    // came from, so that the comment can bring its page back afterwards. A tab
    // this session has not heard about is read once before the reference is
    // built, rather than writing a pick that cannot be reopened.
    if (!read && !this.designs.has(tabId)) {
      void this.readPageState(tabId).then(() => this.onPageEvent(tabId, event, true))
      return
    }
    const owner = this.ownerOf(tabId)
    if (!owner) return
    const { projectId, threadId } = owner
    if (event.kind === 'open') {
      // The bubble is drawn beside the element, and the element is in the tab the
      // reader is looking at, so reveal that tab and the thread it belongs to.
      this.editing.set(tabId, { referenceId: event.id, anchor: event.anchor })
      void import('$lib/threads/open-thread-by-id')
        .then(async ({ openThreadById }) => {
          await openThreadById(projectId, threadId)
          contextSidebarState.focus(tabId)
        })
        .catch(() => {})
      return
    }
    const reference = designElementReference(
      event.id,
      event.target,
      this.designs.get(tabId) ?? null,
      {
        id: tabId,
        url: contextSidebarState.browserTabs.find((tab) => tab.id === tabId)?.url ?? ''
      }
    )
    // A pick's id is the id of the page marker it created, so the same pick can
    // only ever name one reference. Folding it in by id keeps a repeated report
    // of one pick from adding a second entry with the same key.
    responseReferencesState.setForThread(
      projectId,
      threadId,
      mergeReferenceById(responseReferencesState.forThread(projectId, threadId), reference)
    )
    this.editing.set(tabId, { referenceId: event.id, anchor: event.anchor })
  }

  /**
   * Land a reference-list change in the pages that draw it: a pick, a finished
   * comment, or a removal made from the composer moves the pins, and an open
   * comment whose reference is gone closes with it.
   */
  private onReferencesChanged(projectId: string, threadId: string): void {
    const references = responseReferencesState.forThread(projectId, threadId)
    for (const tab of contextSidebarState.browserTabs) {
      if (tab.kind !== 'browser') continue
      if (tab.projectId !== projectId || tab.threadId !== threadId) continue
      if (!this.designs.has(tab.id)) continue
      // An open bubble whose reference is gone (removed from the composer) closes
      // with it, exactly as the page's own card used to.
      const editing = this.editing.get(tab.id)
      if (editing && !references.some((reference) => reference.id === editing.referenceId)) {
        this.editing.delete(tab.id)
      }
      this.publishMarkers(tab.id)
    }
  }

  private publishMarkers(tabId: string): void {
    if (!this.designs.has(tabId)) return
    void invoke('browser:inspectMarkers', tabId, this.markersFor(tabId)).catch(() => {})
  }

  /** Re-theme every overlay currently on screen after the app theme changed. */
  private publishTheme(): void {
    const theme = this.themeTokens()
    if (!theme) return
    for (const tab of contextSidebarState.browserTabs) {
      if (tab.kind !== 'browser') continue
      if (!this.armed.has(tab.id) && this.markersFor(tab.id).length === 0) continue
      void invoke('browser:inspectTheme', tab.id, theme).catch(() => {})
    }
  }

  /**
   * The app's design tokens, as the injected overlay has to draw them.
   *
   * The overlay is page script and cannot read the application's stylesheet, so
   * the values are resolved here from the same custom properties every other
   * surface styles itself with. Reading them, rather than duplicating the
   * palette, is what makes a pin and its comment the same colour as the app in
   * both light and dark mode.
   */
  private themeTokens(): BrowserInspectorTheme | null {
    const styles = getComputedStyle(document.documentElement)
    const theme = {} as BrowserInspectorTheme
    for (const key of THEME_KEYS) {
      const value = styles.getPropertyValue(INSPECTOR_THEME_TOKENS[key]).trim()
      // A token the stylesheet has not applied yet (the very first paint) is not
      // a reason to ship an unthemed overlay: fall back to the last good read.
      if (!value) return this.themeCache
      theme[key] = value
    }
    this.themeCache = theme
    return theme
  }

  private ownerOf(tabId: string): TabOwner | null {
    const tab = contextSidebarState.browserTabs.find((candidate) => candidate.id === tabId)
    if (!tab || tab.kind !== 'browser') return null
    return { projectId: tab.projectId, threadId: tab.threadId }
  }
}

export const browserInspector = new BrowserInspectorSession()
