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
import {
  designElementReference,
  designEntryFromUrl,
  designPageIdentity
} from '$lib/design-element-reference'
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

/**
 * A set of tab ids the session remembers, kept out of Svelte's reactive graph.
 *
 * These flags answer questions the session asks itself while publishing, so a
 * reactive collection here would make every read retrigger the effect that does
 * the asking. Nothing renders from them, so they are plain records with the
 * three operations the session needs.
 */
class TabFlags {
  private readonly flags: Record<string, true> = {}

  has(tabId: string): boolean {
    return this.flags[tabId] === true
  }

  add(tabId: string): void {
    this.flags[tabId] = true
  }

  delete(tabId: string): void {
    delete this.flags[tabId]
  }

  ids(): string[] {
    return Object.keys(this.flags)
  }
}

/** One tab's design page: the folder it is served from, and the entry it shows. */
interface ObservedDesignPage {
  design: BrowserDesignTab
  /** The page's own URL, which names the entry inside the folder. */
  url: string
}

/**
 * The design page each tab is serving, also kept out of the reactive graph.
 *
 * The page is kept rather than only its folder because a tab is one entry of a
 * design: the thread's own tab moves through the work, and a screen tab shows a
 * single file. The entry is what lets a comment written on one tab be drawn on
 * the same page when it is opened in another.
 */
class DesignMirror {
  private readonly pages: Record<string, ObservedDesignPage> = {}

  has(tabId: string): boolean {
    return this.pages[tabId] !== undefined
  }

  get(tabId: string): ObservedDesignPage | undefined {
    return this.pages[tabId]
  }

  set(tabId: string, design: BrowserDesignTab, url: string): void {
    this.pages[tabId] = { design, url }
  }

  /** Whether a record was removed, which is what tells a caller it went away. */
  delete(tabId: string): boolean {
    if (this.pages[tabId] === undefined) return false
    delete this.pages[tabId]
    return true
  }
}

/**
 * The number a pin shows, taken from the composer's own label.
 *
 * The composer renumbers a conversation's design notes, and the pin has to agree
 * with the chip beside it. A label that is not one of those (a reference written
 * before design notes were numbered) falls back to its place in this page's own
 * list.
 */
function markerNumber(reference: ResponseReferenceAnchor, fallback: number): number {
  const match = /^Design element (\d+)$/u.exec(reference.label)
  const parsed = match === null ? Number.NaN : Number(match[1])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

class BrowserInspectorSession {
  /** Tabs whose page is armed for picking. */
  private readonly armed = new SvelteSet<string>()
  /**
   * The design each tab is serving, mirrored from `browser:state`.
   *
   * Deliberately ordinary collections rather than reactive ones: this is
   * bookkeeping the session reads while deciding what to publish, and a reactive
   * collection read inside the session's own effect made every read retrigger
   * that effect. Nothing renders from these; the pins and the bubble are told to
   * change instead of deriving from them.
   */
  private readonly designs = new DesignMirror()
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
   * Tabs whose page state has been answered, so the list is read once per tab.
   *
   * A tab the app has not asked about yet is a tab whose design report may
already have come and gone, which is why the list is watched rather than read
   * once. A tab main cannot answer for yet (a restored tab whose page it has not
   * created) is deliberately *not* recorded here, so the next change of the list
   * asks again instead of the session going blind.
   */
  private readonly statesRead = new TabFlags()
  /**
   * Tabs whose state has been read once more after they became the page on
   * screen.
   *
   * A restored tab's design report can arrive before this session was started,
   * and the broadcast is the only other way it would ever be seen. Asking again
   * when the reader actually shows the tab closes that gap without polling: one
   * extra question per tab per session, on the first time it is looked at.
   */
  private readonly activeRead = new TabFlags()
  /**
   * The pin set last handed to each tab, kept out of the reactive graph.
   *
   * A reference changes on every keystroke of a comment draft, and a tab showing
   * the same design page under another conversation is now republished too. The
   * serialised set is what keeps that from being an IPC call per key: nothing is
   * sent unless the pins actually changed. A tab whose page moved has a new
   * design and publishes a different set, so the record cannot outlive its use.
   */
  private readonly publishedMarkers = new Map<string, string>()
  /**
   * Reads in flight, so one tab is never asked about twice at once.
   *
   * The promise is kept rather than a plain flag because a caller that needs an
   * answer from after now has to wait for the question already sent, and a flag
   * could only tell it to give up.
   */
  private readonly reading = new Map<string, Promise<void>>()

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
    subscribe('browser:state', (state) => this.notePageState(state.tabId, state.design, state.url))
    subscribe('browser:inspector', (tabId, event) => this.onPageEvent(tabId, event))
    // A tab reports its state when it loads, and a restored or preloaded tab can
    // load before this session was started (the browser is lazy, and this is the
    // seam that starts it). A tab the session never heard of is neither
    // inspectable nor reopenable, and a pick made on it carries no folder, so the
    // state every open tab already has is read here instead of waiting for a page
    // reload to report it again.
    //
    // Read as a subscription to the tab list rather than once at this seam. The
    // list itself is restored from storage a moment after the runtime starts, and
    // main only announces a tab's design when it *changes*, so a session that
    // asked once, too early, learned about no tab at all and never asked again:
    // the design was never mirrored, no pins were published for it, and the only
    // thing that could publish them was an edit from the composer, which reopens
    // the design and marks it again. That is the pins that would not come back
    // after a reload, however many times the page itself was refreshed.
    this.readTabStates()
    $effect.root(() => {
      $effect(() => this.readTabStates())
    })
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

  /**
   * The pins this tab's page draws, in the composer's own numbering.
   *
   * A comment is pinned to the design page it was written on, not to the tab
   * that happened to be showing it. The same page can be opened in a thread's
   * own tab by the agent, in its screen's tab from the board, or in a tab the
   * app had to create again, and each of those has a different tab id. Matching
   * only on the id left a comment with no pin the moment its page was opened
   * another way, which is why the page itself is asked for as well.
   *
   * The conversation that owns the tab is listed first, because its own
   * renumbering is what its composer shows; every other conversation with a
   * comment on the same page follows. A reference is drawn once even when both
   * passes name it.
   */
  markersFor(tabId: string): BrowserInspectorMarker[] {
    const tab = this.tabOf(tabId)
    const owner = tab ? { projectId: tab.projectId, threadId: tab.threadId } : null
    const groups: {
      projectId: string
      threadId: string
      references: ResponseReferenceAnchor[]
    }[] = []
    const seenGroups = new TabFlags()
    if (owner) {
      groups.push({
        ...owner,
        references: responseReferencesState.forThread(owner.projectId, owner.threadId)
      })
      seenGroups.add(`${owner.projectId}\u0000${owner.threadId}`)
    }
    for (const group of responseReferencesState.entries()) {
      const key = `${group.projectId}\u0000${group.threadId}`
      if (seenGroups.has(key)) continue
      seenGroups.add(key)
      groups.push(group)
    }
    const markers: BrowserInspectorMarker[] = []
    const seen = new TabFlags()
    for (const group of groups) {
      for (const reference of group.references) {
        if (seen.has(reference.id)) continue
        if (!this.referenceOnTab(group.projectId, reference, tabId)) continue
        seen.add(reference.id)
        markers.push({
          id: reference.id,
          number: markerNumber(reference, markers.length + 1),
          comment: reference.comment ?? '',
          selector: reference.selector ?? '',
          ...(reference.frame ? { frame: reference.frame } : {})
        })
      }
    }
    return markers
  }

  /**
   * Whether one comment belongs on the page a tab is showing.
   *
   * The tab it was written in is the first answer, because that is exact. A tab
   * showing the same design page is the second, and is what survives the page
   * being opened again under another tab: the design's folder and entry name the
   * page, and a comment picked inside a canvas frame names that frame instead.
   */
  private referenceOnTab(
    projectId: string,
    reference: ResponseReferenceAnchor,
    tabId: string
  ): boolean {
    if (reference.kind !== 'design') return false
    if (reference.tabId === tabId) return true
    const tab = this.tabOf(tabId)
    const page = this.designs.get(tabId)
    if (!tab || !page || !reference.directory) return false
    // A folder path is project-relative, so the same design in another project
    // is a different page even though it is spelled the same.
    if (tab.projectId !== projectId) return false
    if (page.design.directory !== reference.directory) return false
    const currentEntry = designEntryFromUrl(page.url, page.design.origin)
    const currentId = designPageIdentity(page.design.directory, currentEntry)
    if (reference.designId) {
      if (reference.designId === currentId) return true
    } else if ((reference.designEntry ?? '') === (currentEntry ?? '')) {
      return true
    }
    // A comment picked inside a canvas frame names the screen it was picked on,
    // so opening that screen in a tab of its own is the same element's page.
    return reference.frame !== undefined && reference.frame === currentEntry
  }

  /** The tab the sidebar knows, which is where its project and thread come from. */
  private tabOf(tabId: string): { projectId: string; threadId: string } | null {
    const tab = contextSidebarState.browserTabs.find((candidate) => candidate.id === tabId)
    return tab && tab.kind === 'browser'
      ? { projectId: tab.projectId, threadId: tab.threadId }
      : null
  }

  toggle(tabId: string): void {
    this.setArmed(tabId, !this.armed.has(tabId))
  }

  /**
   * The open comment on a tab, resolved against the conversation that owns the
   * tab right now.
   *
   * The reference a pick writes and the reference the bubble reads have to come
   * from one owner. Reading it here, from the tab the session already knows,
   * keeps the bubble alive when the panel's own snapshot of the tab is older than
   * the list (a tab re-scoped to another thread, a restored tab) instead of the
   * comment silently vanishing because a lookup used a stale thread id.
   */
  commentFor(tabId: string): {
    referenceId: string
    anchor: BrowserInspectorRect
    projectId: string
    threadId: string
    reference: ResponseReferenceAnchor
  } | null {
    const editing = this.editing.get(tabId)
    if (!editing) return null
    const owner = this.ownerOf(tabId)
    const reference = owner
      ? responseReferencesState
          .forThread(owner.projectId, owner.threadId)
          .find((candidate) => candidate.id === editing.referenceId)
      : undefined
    // The tab can have been re-scoped to another conversation since the comment
    // was written (a screen tab's id is derived from the screen, so one screen
    // opened twice is one tab). The comment belongs to the conversation that
    // wrote it, and that is the one its edit has to land in, so a miss against
    // the owner falls back to wherever the reference actually lives rather than
    // closing a bubble the reader is looking at.
    const held = reference ? null : responseReferencesState.findById(editing.referenceId)
    const found = reference ?? held?.reference
    if (!found) return null
    return {
      referenceId: editing.referenceId,
      anchor: editing.anchor,
      projectId: owner && reference ? owner.projectId : (held?.projectId ?? owner?.projectId ?? ''),
      threadId: owner && reference ? owner.threadId : (held?.threadId ?? owner?.threadId ?? ''),
      reference: found
    }
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
   * Ask main what every tab the session does not know yet is serving.
   *
   * Bounded by the number of open tabs (a handful) and by one question per tab:
   * a tab main answers for is recorded, and a tab it cannot answer for yet is
   * asked again the next time the list changes. This runs on the tab list, so a
   * tab restored after the session started is mirrored when it arrives instead of
   * being unknown until its page reloads.
   */
  private readTabStates(): void {
    const open = new TabFlags()
    const activeId = contextSidebarState.sidebarActiveTabId
    for (const tab of contextSidebarState.browserTabs) {
      if (tab.kind !== 'browser') continue
      open.add(tab.id)
      if (this.designs.has(tab.id)) continue
      // The page the reader is actually looking at is asked again once, even if
      // its state was already read: the design mark may have been published
      // before this session existed, and no later broadcast would carry it.
      //
      // Checked before the read already in flight is, because that read may have
      // been asked before the tab was shown: moving the pointer away from it
      // would let a question that came back too early stand in for this one and
      // the re-read would be lost with the reader already looking at the page.
      if (tab.id === activeId) {
        if (this.activeRead.has(tab.id)) continue
        this.activeRead.add(tab.id)
        void this.readPageStateAgain(tab.id)
        continue
      }
      if (this.reading.has(tab.id)) continue
      if (this.statesRead.has(tab.id)) continue
      void this.readPageState(tab.id)
    }
    for (const id of this.activeRead.ids()) if (!open.has(id)) this.activeRead.delete(id)
    // A closed tab's record goes with it, so a long session does not keep the id
    // of every tab it ever showed.
    for (const id of this.statesRead.ids()) if (!open.has(id)) this.statesRead.delete(id)
  }

  /**
   * Ask main what one tab is serving, and mirror it.
   *
   * The answer is the same report `browser:state` carries, read on demand rather
   * than waited for: that report is a broadcast, and a listener that starts after
   * the page loaded never receives it.
   */
  private readPageState(tabId: string): Promise<void> {
    const inFlight = this.reading.get(tabId)
    // One question per tab at a time, and the answer on its way is the answer to
    // this one: asking again would only put two reports of the same page in
    // flight against each other.
    if (inFlight) return inFlight
    const read: Promise<void> = this.fetchPageState(tabId).finally(() => {
      if (this.reading.get(tabId) === read) this.reading.delete(tabId)
    })
    this.reading.set(tabId, read)
    return read
  }

  /**
   * Ask again, once whatever read is already in flight for the tab lands.
   *
   * For the callers that need a report from *now*: the page the reader just
   * showed, or the page a comment is about to be pinned to. The question in
   * flight may predate either, so it is awaited and then the page is asked about
   * again, which keeps one tab to one question at a time without spending the
   * re-read on an answer that came back too early to count.
   */
  private readPageStateAgain(tabId: string): Promise<void> {
    const inFlight = this.reading.get(tabId)
    return inFlight ? inFlight.then(() => this.readPageState(tabId)) : this.readPageState(tabId)
  }

  /** The question {@link readPageState} deduplicates and {@link reading} tracks. */
  private async fetchPageState(tabId: string): Promise<void> {
    try {
      const state = await invoke('browser:pageState', tabId)
      // No report means main has no page for this tab yet, which is the answer a
      // restored tab gives until it is shown. It is not recorded, so the next
      // change of the tab list asks again rather than treating it as answered.
      if (!state) return
      this.statesRead.add(tabId)
      this.notePageState(state.tabId, state.design, state.url)
    } catch (failure: unknown) {
      logRendererError("A browser tab's page state could not be read.", failure)
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
    void this.reveal(projectId, threadId, reference)
  }

  /**
   * Bring a comment's page and pin in front of the reader.
   *
   * The page is looked for by what it is rather than by the tab it was written
   * in, because the same screen is shown in a thread's own tab by an agent and
   * in a screen tab by the board. A tab that says it is open but has already
   * gone in main is not a reason to fail the jump: its page is opened again the
   * way the board opens it, which is exactly what the reader asked to see.
   */
  private async reveal(
    projectId: string,
    threadId: string,
    reference: ResponseReferenceAnchor
  ): Promise<void> {
    const tabId = reference.tabId
    let failed: string | undefined
    // The tab the comment was written in is the most direct answer while it is
    // still open and still serving a design.
    if (tabId && this.isOpenDesignTab(tabId)) {
      if (await this.tryFocus(tabId, projectId, threadId, reference)) return
      failed = tabId
    }
    // The same design page can be open in another tab: the thread's own tab by
    // an agent, the screen's tab by the board. The page is what matters, not the
    // tab it happened to be written in.
    if (reference.directory) {
      const shown = this.openTabShowing(reference, reference.directory, projectId, failed)
      if (shown && (await this.tryFocus(shown, projectId, threadId, reference))) return
      failed = shown ?? failed
    }
    // The tab can still be open and serving the design even though this session
    // does not know it yet (its report arrived before the session was started),
    // so an unknown tab is read before the comment is declared unrecoverable.
    if (tabId && !failed && this.isOpenBrowserTab(tabId)) {
      await this.readPageState(tabId)
      if (
        this.isOpenDesignTab(tabId) &&
        (await this.tryFocus(tabId, projectId, threadId, reference))
      )
        return
      failed = tabId
      await this.revealOnStoredDesign(
        projectId,
        threadId,
        this.withDesignFolder(tabId, reference),
        failed
      )
      return
    }
    await this.revealOnStoredDesign(projectId, threadId, reference, failed)
  }

  /**
   * Focus one comment on one tab, and report whether the tab could still do it.
   *
   * A sidebar can list a tab main has already destroyed (a closed window, a
   * restored list that outran the browser), and that tab must not swallow the
   * jump: the caller opens the page again instead.
   */
  private async tryFocus(
    tabId: string,
    projectId: string,
    threadId: string,
    reference: ResponseReferenceAnchor
  ): Promise<boolean> {
    try {
      await this.restoreAndFocus(tabId, reference.id, { projectId, threadId })
      contextSidebarState.focus(tabId)
      return true
    } catch (failure: unknown) {
      logRendererError('A design annotation tab could not be focused; reopening its page.', failure)
      return false
    }
  }

  /** The part of {@link reveal} that needs a known design folder. */
  private async revealOnStoredDesign(
    projectId: string,
    threadId: string,
    reference: ResponseReferenceAnchor,
    /** A tab this jump already failed on, which must not be chosen again. */
    avoidTabId?: string
  ): Promise<void> {
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
    const shown = this.openTabShowing(reference, directory, projectId, avoidTabId)
    if (shown) {
      if (await this.tryFocus(shown, projectId, threadId, reference)) {
        if (tabId && tabId !== shown) this.rebindReferences(projectId, threadId, tabId, shown)
        return
      }
    }
    try {
      await this.reopenAndFocus(projectId, threadId, reference, directory, tabId)
    } catch (failure: unknown) {
      logRendererError('The design a comment was made on could not be reopened.', failure)
      toast.error('The design this comment was made on is no longer in this project.', {
        description: directory
      })
    }
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
    const page = this.designs.get(tabId)
    if (!page) return reference
    const entry = designEntryFromUrl(page.url, page.design.origin)
    return {
      ...reference,
      directory: page.design.directory,
      ...(reference.designEntry || !entry ? {} : { designEntry: entry }),
      ...(reference.designId || !page.design.directory
        ? {}
        : { designId: designPageIdentity(page.design.directory, entry) })
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
  private openTabShowing(
    reference: ResponseReferenceAnchor,
    directory: string,
    projectId: string,
    /** A tab this jump already failed on, which must not be chosen again. */
    avoidTabId?: string
  ): string | null {
    for (const tab of contextSidebarState.browserTabs) {
      if (tab.kind !== 'browser' || tab.id === avoidTabId || tab.projectId !== projectId) continue
      const page = this.designs.get(tab.id)
      if (!page || page.design.directory !== directory) continue
      const entry = designEntryFromUrl(page.url, page.design.origin)
      if (reference.designId === designPageIdentity(directory, entry)) return tab.id
      if (!reference.designEntry || entry === reference.designEntry) return tab.id
      // A comment picked inside the canvas names the screen's own entry as its
      // frame, so that screen's tab is the same page to the reader.
      if (reference.frame !== undefined && reference.frame === entry) return tab.id
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
    _owner: TabOwner | null
  ): Promise<void> {
    this.armed.add(tabId)
    const theme = this.themeTokens()
    await invoke('browser:inspectSetArmed', tabId, true, theme ?? undefined)
    // The pins come from every place a comment on this tab can live, not only from
    // the conversation that owns the tab now: a screen tab keeps its id across a
    // re-scope, the comment being focused was written by another conversation, and
    // a tab main has just opened is not in the sidebar list yet. Markers the
    // session can name at all are published here, so a reopened page never waits
    // for a state report to draw them.
    const markers = this.markersFor(tabId)
    this.publishedMarkers.set(tabId, JSON.stringify(markers))
    await invoke('browser:inspectMarkers', tabId, markers)
    await invoke('browser:inspectFocus', tabId, referenceId, true)
  }

  /** Mirror the design a tab is serving, and end the session when it stops. */
  private notePageState(tabId: string, design: BrowserDesignTab | null, url: string): void {
    if (design) {
      this.designs.set(tabId, design, url)
      this.publishMarkers(tabId)
      return
    }
    if (!this.designs.delete(tabId)) return
    this.publishedMarkers.delete(tabId)
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
    if (event.kind === 'open') {
      // A pin belongs to the comment written on it, which can be held by another
      // conversation than the one the tab now belongs to. The bubble edits the
      // reference, so the conversation that owns that reference is revealed, not
      // whichever thread happens to own the tab.
      const held = responseReferencesState.findById(event.id)
      const target = held ? { projectId: held.projectId, threadId: held.threadId } : owner
      if (!target) return
      this.editing.set(tabId, { referenceId: event.id, anchor: event.anchor })
      void import('$lib/threads/open-thread-by-id')
        .then(async ({ openThreadById }) => {
          await openThreadById(target.projectId, target.threadId)
          contextSidebarState.focus(tabId)
        })
        .catch(() => {})
      return
    }
    if (!owner) return
    const { projectId, threadId } = owner
    const page = this.designs.get(tabId)
    const reference = designElementReference(event.id, event.target, page?.design ?? null, {
      id: tabId,
      url: page?.url ?? contextSidebarState.browserTabs.find((tab) => tab.id === tabId)?.url ?? ''
    })
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
  private onReferencesChanged(_projectId: string, _threadId: string): void {
    // A comment belongs to a design page, so any tab showing that page has to be
    // told again, not only the tab of the conversation that changed: the same
    // screen is opened by an agent in the thread's tab and by the board in its
    // own. `publishMarkers` drops the calls whose pins did not change, so this
    // stays one comparison per open tab instead of an IPC call per keystroke.
    for (const tab of contextSidebarState.browserTabs) {
      if (tab.kind !== 'browser') continue
      this.publishMarkers(tab.id)
    }
    // An open bubble whose reference is gone (removed from the composer) closes
    // with it, exactly as the page's own card used to. Asked of every
    // conversation rather than of the tab's owner, because a tab that moved on
    // from the conversation that wrote the comment must still close when that
    // comment is removed there.
    for (const tabId of [...this.editing.keys()]) {
      const editing = this.editing.get(tabId)
      if (editing && !responseReferencesState.findById(editing.referenceId)) {
        this.editing.delete(tabId)
      }
    }
  }

  /**
   * Hand one tab's pins to the page.
   *
   * Deliberately not gated on the mirrored design: the pins are a function of
   * the conversation's references and the tab's id, and a design mark this
   * session has not heard about yet (a restored tab, a report published before
   * the session started) must not cost the reader the pins their comments
   * already own. A tab that cannot be resolved is skipped, so an unknown tab is
   * never asked about.
   */
  private publishMarkers(tabId: string): void {
    const markers = this.markersFor(tabId)
    // A tab with no owner and no comments for it is not published at all, so an
    // unknown tab is never asked about; one the sidebar can still answer for, or
    // one whose comments live in another conversation, is.
    if (!this.ownerOf(tabId) && markers.length === 0) return
    const serialized = JSON.stringify(markers)
    if (this.publishedMarkers.get(tabId) === serialized) return
    this.publishedMarkers.set(tabId, serialized)
    void invoke('browser:inspectMarkers', tabId, markers).catch(() => {
      // The tab may have gone since it was listed; forget the set so a reopened
      // tab with the same pins is published rather than suppressed by it.
      this.publishedMarkers.delete(tabId)
    })
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
