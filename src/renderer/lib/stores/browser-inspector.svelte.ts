import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { toast } from 'svelte-sonner'
import { logRendererError } from '$lib/system/renderer-logger'
import type {
  BrowserDesignTab,
  BrowserInspectorEvent,
  BrowserInspectorMarker,
  BrowserInspectorTheme
} from '$shared/ipc-contract'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { designElementReference } from '$lib/design-element-reference'
import { contextSidebarState } from './context-sidebar.svelte'
import { mergeReferenceById, responseReferencesState } from './response-references.svelte'

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
 *   - the event loop back from the page: a pick becomes a composer reference, a
 *     pin click opens that element's comment, and the comment text the page
 *     reports as it is written lands on the reference the pick created
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
  accent: '--color-accent'
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
    void this.restoreAndFocus(tabId, referenceId).catch((failure: unknown) => {
      logRendererError('The design annotation could not be focused.', failure)
      toast.error('Could not focus this design annotation. Try opening its browser tab again.')
    })
  }

  private async restoreAndFocus(tabId: string, referenceId: string): Promise<void> {
    this.armed.add(tabId)
    const theme = this.themeTokens()
    await invoke('browser:inspectSetArmed', tabId, true, theme ?? undefined)
    await invoke('browser:inspectMarkers', tabId, this.markersFor(tabId))
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
    // A tab that navigated away from its design folder is no longer inspectable,
    // so the session cannot stay armed for a page that no longer offers it.
    if (this.armed.has(tabId)) this.setArmed(tabId, false)
  }

  /**
   * One report from the page's inspector.
   *
   * `pick` is a fresh element, which becomes a composer reference; `open` is a
   * click on an existing pin, whose card the page has already opened; `draft`
   * and `done` are the text as it is written and committed; `remove` detaches
   * the reference; `close` is the user dismissing the card. The page owns the
   * card and the text, so this session only lands what it reports on the
   * reference list, which is the app's truth.
   */
  private onPageEvent(tabId: string, event: BrowserInspectorEvent): void {
    if (event.kind === 'closed') {
      this.armed.delete(tabId)
      return
    }
    const owner = this.ownerOf(tabId)
    if (!owner) return
    const { projectId, threadId } = owner
    if (event.kind === 'draft') {
      responseReferencesState.updateCommentDraft(projectId, threadId, event.id, event.comment)
      return
    }
    if (event.kind === 'done') {
      responseReferencesState.updateComment(projectId, threadId, event.id, event.comment)
      return
    }
    if (event.kind === 'remove') {
      responseReferencesState.setForThread(
        projectId,
        threadId,
        responseReferencesState
          .forThread(projectId, threadId)
          .filter((reference) => reference.id !== event.id)
      )
      return
    }
    if (event.kind === 'open') {
      void import('$lib/threads/open-thread-by-id')
        .then(async ({ openThreadById }) => {
          await openThreadById(projectId, threadId)
          contextSidebarState.focus(tabId)
        })
        .catch(() => {})
      return
    }
    if (event.kind === 'close') return
    const reference = designElementReference(
      event.id,
      event.target,
      this.designs.get(tabId) ?? null,
      tabId
    )
    // A pick's id is the id of the page marker it created, so the same pick can
    // only ever name one reference. Folding it in by id keeps a repeated report
    // of one pick from adding a second entry with the same key.
    responseReferencesState.setForThread(
      projectId,
      threadId,
      mergeReferenceById(responseReferencesState.forThread(projectId, threadId), reference)
    )
  }

  /**
   * Land a reference-list change in the pages that draw it: a pick, a finished
   * comment, or a removal made from the composer moves the pins, and an open
   * comment whose reference is gone closes with it.
   */
  private onReferencesChanged(projectId: string, threadId: string): void {
    for (const tab of contextSidebarState.tabs) {
      if (tab.kind !== 'browser') continue
      if (tab.projectId !== projectId || tab.threadId !== threadId) continue
      if (!this.designs.has(tab.id)) continue
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
    for (const tab of contextSidebarState.tabs) {
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
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === tabId)
    if (!tab || tab.kind !== 'browser') return null
    return { projectId: tab.projectId, threadId: tab.threadId }
  }
}

export const browserInspector = new BrowserInspectorSession()
