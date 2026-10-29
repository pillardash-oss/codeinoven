import { tick } from 'svelte'

import { invoke } from '$lib/ipc.svelte'

import { normalizeChatSettings } from '$lib/stores/thread-settings.svelte'
import { playHistoryArrive } from '$lib/motion'
import { THREAD_MESSAGE_PRELOAD_WINDOW, threadMessages } from '$lib/stores/thread-messages.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import type { ThreadMessageCursor, ThreadSettings } from '$shared/types'
import {
  hasRenderableWorkingParts,
  isActivityOnlyUserMessage,
  turnStartPromptsBefore
} from '../thread-turn-parts'
import { HISTORY_WINDOW_SIZE, promptPagesBefore } from '../thread-history'
import { threadScrollPositions } from '../thread-scroll-memory'
import type { ThreadView } from './ThreadView-board.svelte'
import { DEFAULT_SETTINGS } from '$lib/stores/thread-settings.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewLoadOlderMessages extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }

  /** Reads the thread's settings once the board can resolve them. */
  bindSettings(): void {
    this.settings = this.hasController
      ? normalizeChatSettings(this.root.props.controller!.settings)
      : this.root.sources.initialThreadSettings(this.root.handleAgentEvent.thread)
  }

  /**
   * Capture the restored scroll state.
   *
   * It is read from a sibling unit, which only exists once the whole board is
   * built, so the board asks for it right after construction.
   */
  bind(): void {
    const mounted = this.root.unmirroredTraceStartTime.mountedThread
    this.userScrolledAway =
      this.root.unmirroredTraceStartTime.savedScrollState?.awayFromBottom ?? false
    this.mountedCount = Math.min(
      threadMessages.messages(mounted.projectId, mounted.id).length,
      this.root.composerScope.INITIAL_PAINT_MESSAGES
    )
  }
  /** True when this view is driven by an external controller (e.g. temporary chat). */
  hasController = $derived(this.root.props.controller !== undefined)

  alive = true

  messages = $derived(
    this.root.props.controller?.messages ??
      threadMessages.messages(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
  )

  /** Set by `bind()`: whether the conversation was left scrolled away. */
  userScrolledAway = $state(false)

  /** Set by `bind()`: how many messages the first paint mounts. */
  mountedCount = $state(0)

  /** Id of the first mounted message while the reader is scrolled up. With an
   *  anchor pinned, the window runs from what the reader is reading all the
   *  way to the live tail and GROWS with the stream instead of sliding with
   *  it   a working turn appending trace entries can never unmount the
   *  message and trace the reader is steering against. Null = follow the
   *  tail with the newest `mountedCount` messages. */
  windowStartId = $state<string | null>(null)

  /** Absolute index of the first mounted message. If the anchored message
   *  left the store (truncated/deleted), fall back without touching state
   *  deriveds must stay pure.
   *
   *  The window always begins on the prompt that opened the newest turn, never
   *  on an assistant row. The tail-relative fallback used to start a few
   *  messages back, which for a normal turn lands inside the *previous* turn's
   *  assistant rows: the reader opened a conversation and the first thing on
   *  screen was that turn's final text, its file-changes card, and its footer,
   *  with the prompt and answer they came to read further down. The prompt is
   *  the anchor, so the current turn reads in the order it was lived
   *  (prompt, trace, answer) and its cards follow the answer. */
  mountedStartIndex = $derived.by(() => {
    if (this.hasController) return 0
    if (this.windowStartId) {
      const anchorIndex = this.messages.findIndex((message) => message.id === this.windowStartId)
      if (anchorIndex >= 0) return anchorIndex
    }
    const countStart = Math.max(0, this.messages.length - this.mountedCount)
    const turnStart = this.root.buildSpecActionPrompt.latestTurnInfo.startIndex
    if (turnStart < 0) {
      // A fresh thread has an optimistic prompt before it has an assistant
      // message, so it is not a complete turn yet. Keep that prompt mounted
      // instead of treating it as history hidden behind the load button.
      for (let index = this.messages.length - 1; index >= 0; index -= 1) {
        const message = this.messages[index]
        if (message?.role !== 'user' || isActivityOnlyUserMessage(message)) continue
        return index
      }
      return countStart
    }
    // One prompt back is this turn's own opening message. If the loaded window
    // does not reach it (a turn longer than the alignment budget), the turn
    // start is still a better anchor than the raw page boundary, which can sit
    // inside the previous turn and paint that turn's cards first.
    const turnPrompt = promptPagesBefore(this.messages, turnStart, 1)
    if (turnPrompt !== -1) return turnPrompt
    return Math.min(turnStart, Math.max(0, this.messages.length - 1))
  })

  scheduleInitialReveal(): void {
    if (!this.alive) return
    if (this.mountedCount >= Math.min(this.messages.length, HISTORY_WINDOW_SIZE)) return
    this.root.unmirroredTraceStartTime.initialPaintRevealFrame = requestAnimationFrame(() => {
      if (!this.alive) return
      const fillTarget = Math.min(this.messages.length, HISTORY_WINDOW_SIZE)
      if (this.mountedCount >= fillTarget) return
      const el = this.scrollEl
      const previousTop = el?.scrollTop ?? 0
      const previousHeight = el?.scrollHeight ?? 0
      this.mountedCount = Math.min(
        fillTarget,
        this.mountedCount + this.root.unmirroredTraceStartTime.INITIAL_REVEAL_BATCH
      )
      // The batch mounted above the viewport. A reader at the bottom is
      // re-anchored by the tail-follow ResizeObserver; a reader away from the
      // bottom keeps their exact viewport across the off-screen mount.
      if (el && this.userScrolledAway) {
        const grown = el.scrollHeight - previousHeight
        if (grown > 0) el.scrollTop = previousTop + grown
      }
      this.scheduleInitialReveal()
    })
  }

  olderMessagesAvailable = $state(false)

  /** Why the transcript could not be read, when it is empty and unloaded. */
  loadError = $derived(
    this.root.props.controller
      ? ''
      : threadMessages.error(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id
        )
  )

  /** Retry a transcript that failed to load, from the same path an open uses. */
  retryLoad(): void {
    const { projectId, id } = this.root.handleAgentEvent.thread
    threadMessages.clearLoadError(projectId, id)
    void this.loadLocal(1)
  }

  jumpLoading = $state(false)

  // svelte-ignore state_referenced_locally
  /** Set by `bind()`: the settings this view reads from. */
  settings = $state<ThreadSettings>(DEFAULT_SETTINGS)

  /** Jump target for the header's history dropdown   loads a window around the
   *  target when it lies outside the currently loaded cache, then scrolls to it. */
  async jumpToMessage(id: string): Promise<void> {
    const { projectId, id: threadId } = this.root.handleAgentEvent.thread
    if (this.jumpLoading) return
    // A jump is a deliberate leave from the live tail. Detach the follow lock
    // and mark the open as restored BEFORE the window mounts and the scroll
    // begins: a far-back jump mounts a large stretch of the transcript, and
    // the ResizeObserver that re-anchors a following reader would otherwise
    // snap the viewport straight back to the bottom   the reason the first
    // (and second) click loaded the target without revealing it.
    this.userScrolledAway = true
    this.root.unmirroredTraceStartTime.scrollRestored = true
    const cachedIndex = this.messages.findIndex((message) => message.id === id)
    if (cachedIndex >= 0) {
      // The store holds the target but the mounted window may not   move the
      // anchor back to cover it (plus context) before scrolling.
      if (!this.hasController && this.mountedStartIndex > cachedIndex) {
        this.windowStartId = this.messages[Math.max(0, cachedIndex - 8)]?.id ?? null
      }
      await this.root.studioTemporaryChatContext.revealMessageById(id)
      return
    }
    this.jumpLoading = true
    try {
      const page = await invoke(
        'thread:loadMessagesAround',
        projectId,
        threadId,
        id,
        HISTORY_WINDOW_SIZE
      )
      if (!this.alive) return
      threadMessages.mergePage(projectId, threadId, page.messages)
      const targetIndex = this.messages.findIndex((message) => message.id === id)
      if (targetIndex >= 0) {
        this.olderMessagesAvailable = page.hasOlder
        if (!this.hasController && this.mountedStartIndex > targetIndex) {
          this.windowStartId = this.messages[Math.max(0, targetIndex - 8)]?.id ?? null
        }
        await this.root.studioTemporaryChatContext.revealMessageById(id)
      }
      // Page forward in the background so the transcript stays contiguous down
      // to the already-loaded thread tail after a far-back jump.
      if (page.hasNewer) {
        const newest = page.messages[page.messages.length - 1]
        if (newest) void this.root.editVideoNote.fillForwardFrom(projectId, threadId, newest.id)
      }
    } catch {
      // The target could not be located in the mirror   nothing else to do.
    } finally {
      this.jumpLoading = false
    }
  }

  /** Scroll the transcript to a section heading inside a specific message
   *  the jump target used by section sources in the Sources panel. Loads a
   *  window around the message when it lies outside the loaded cache. */
  async scrollToMessageSection(messageId: string, section: string): Promise<void> {
    const cachedIndex = this.messages.findIndex((message) => message.id === messageId)
    if (cachedIndex < 0) {
      if (this.jumpLoading) return
      this.jumpLoading = true
      try {
        const page = await invoke(
          'thread:loadMessagesAround',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          messageId,
          HISTORY_WINDOW_SIZE
        )
        if (!this.alive) return
        threadMessages.mergePage(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          page.messages
        )
        const targetIndex = this.messages.findIndex((message) => message.id === messageId)
        if (targetIndex < 0) return
        this.olderMessagesAvailable = page.hasOlder
        if (!this.hasController && this.mountedStartIndex > targetIndex) {
          this.windowStartId = this.messages[Math.max(0, targetIndex - 8)]?.id ?? null
        }
        await tick()
        if (page.hasNewer) {
          const newest = page.messages[page.messages.length - 1]
          if (newest)
            void this.root.editVideoNote.fillForwardFrom(
              this.root.handleAgentEvent.thread.projectId,
              this.root.handleAgentEvent.thread.id,
              newest.id
            )
        }
      } finally {
        this.jumpLoading = false
      }
    }
    const messageElement = document.getElementById(`msg-${messageId}`)
    const anchor = messageElement?.querySelector<HTMLElement>(
      `[data-section="${CSS.escape(section)}"]`
    )
    if (anchor) {
      anchor.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      messageElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  // ─── Chat scroll behaviour ───────────────────────────────────────────────
  //
  // Each thread remembers its scroll position in a module-level map so
  // switching threads snaps to the saved position instead of force-scrolling
  // to the bottom.

  scrollEl = $state<HTMLDivElement | undefined>()

  onScroll(): void {
    if (!this.scrollEl) return
    const away = !this.root.unmirroredTraceStartTime.isAtBottom(this.scrollEl)
    // Pin the window to what the reader is reading the moment they leave the
    // tail, and release it back to the tail-relative window when they return.
    // While pinned, a streaming turn grows the window instead of sliding it
    // the message and trace under the reader can never be unmounted by new
    // entries arriving at the tail.
    if (away && !this.userScrolledAway) {
      this.windowStartId = this.root.composerScope.mountedWindowStartId()
    } else if (
      !away &&
      this.userScrolledAway &&
      !this.loadingOlderMessages &&
      !this.viewportSettling
    ) {
      // A transcript that fits the viewport is at its bottom AND at its top at
      // the same time, so a page landing above the reader can leave them
      // "at the bottom" by measurement while they are reading history. The
      // release is skipped while a load is running or settling, otherwise it
      // unmounted the page that had just arrived and left the reader at a top
      // that refused to load again.
      this.windowStartId = null
    }
    this.userScrolledAway = away
    // Self-heal: the mounted window must never sit at zero while the store
    // holds messages   a windowed view that collapsed to nothing would leave
    // the reader staring at a blank transcript.
    if (!this.hasController && this.mountedCount === 0 && this.messages.length > 0) {
      this.mountedCount = Math.min(this.messages.length, HISTORY_WINDOW_SIZE)
    }
    threadScrollPositions.set(this.root.handleAgentEvent.thread.id, {
      top: this.scrollEl.scrollTop,
      awayFromBottom: this.userScrolledAway
    })
    this.root.steerQueuedMessage.scheduleResponseBubbleUpdate()
    // The reader owns the viewport, so the pin moves with them instead of
    // being dropped: a load can insert a page in the middle of a scroll, and
    // content above the seam keeps finding its height for a while after. Only
    // the delta between where this unit left the scroll and where it now is
    // belongs to the reader.
    this.followViewportScroll()
    // Nothing loads from here: the history row's own visibility observer (see
    // `watchHistoryHead`) is what triggers the conversation-level fetch, and
    // only once that row is genuinely on screen.
  }

  loadingOlderMessages = $state(false)

  /** The one element the reader's viewport is pinned to while history mounts:
   *  the seam, the first block of the mounted window, which every loaded page
   *  is inserted above. Pinning it pins every block below it, so the page the
   *  reader is looking at cannot move while older work lands on top of it.
   *  Plain, not reactive. */
  private viewportSeam: { node: HTMLElement; offset: number } | null = null

  /** The scroll amount this unit last wrote itself. A scroll position that is
   *  anything else came from the reader, who owns their viewport. Plain. */
  private viewportWriteTop = -1

  /** Set while the seam is being held after an insert. Plain. */
  private viewportSettling = false

  private viewportSettleFrame = 0

  /** How long the seam stays pinned after the last layout change it had to
   *  correct. Content inside a landed page can find its height well after the
   *  mount (a picture without an intrinsic size, a trace block the stream log
   *  delivers later, a clamped block that measures itself), and every one of
   *  those would push the reader's view down if nothing was watching. */
  private static readonly VIEWPORT_SETTLE_MS = 700

  /** A single load never holds the seam longer than this, however much keeps
   *  arriving: the hold is a correction for a mount, not a scroll lock. */
  private static readonly VIEWPORT_HOLD_MS = 4000

  /** True once the reader has scrolled up in this view. Plain, not reactive. */
  private readerReachedUp = false

  /** Move the pin with the reader.
   *
   *  Native scroll anchoring is off on this scroller, so nothing else adjusts
   *  the viewport when content above it grows. As long as a page is pinned,
   *  the reader's own scroll has to be reflected in the pin instead of cutting
   *  it loose   otherwise every load that lands while they are still scrolling
   *  is left uncorrected, which is exactly the jump they see. */
  private followViewportScroll(): void {
    const el = this.scrollEl
    if (!el) return
    const travelled = el.scrollTop - this.viewportWriteTop
    if (Math.abs(travelled) <= 0.5) return
    if (this.viewportSeam) this.viewportSeam.offset -= travelled
    this.viewportWriteTop = el.scrollTop
    // Upward travel is the reader asking for the past. Until that happens
    // once, nothing loads on its own: a thread that opens on a short turn
    // would otherwise pull history the reader never reached for.
    if (travelled < -0.5) this.readerReachedUp = true
  }

  /** Pin the viewport to the seam. Called once before a load inserts anything. */
  private holdViewportSeam(): void {
    const el = this.scrollEl
    const seam = this.root.studioTemporaryChatContext.historySeamElement()
    this.viewportSeam =
      el && seam instanceof HTMLElement
        ? { node: seam, offset: seam.getBoundingClientRect().top - el.getBoundingClientRect().top }
        : null
    if (el) this.viewportWriteTop = el.scrollTop
  }

  /** Put the seam back where it was. Idempotent, and cheap enough to run on
   *  every frame the guard is live. */
  private restoreViewportSeam(): void {
    const el = this.scrollEl
    const seam = this.viewportSeam
    if (!el || !seam || !seam.node.isConnected) return
    const contentOffset =
      seam.node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    const next = Math.max(0, contentOffset - seam.offset)
    if (Math.abs(next - el.scrollTop) > 0.5) {
      el.scrollTop = next
      // Read back: the browser clamps, and the reader's next scroll is measured
      // against what the scroller actually holds.
      this.viewportWriteTop = el.scrollTop
    }
  }

  /** Hold the seam for as long as content keeps arriving above the reader.
   *
   *  The mount itself is corrected once, in the same task, so it is never
   *  painted. What this covers is everything that lands after it   a block the
   *  stream log delivers a moment later, media without an intrinsic size, a
   *  self-measuring clamp   and it keeps covering it for a short while after
   *  the last correction, because one late block often follows another. It is
   *  never a scroll lock: the pin moves with the reader (`followViewportScroll`)
   *  and the whole hold expires on its own. */
  private settleViewportSeam(): void {
    this.stopViewportSettle()
    if (!this.viewportSeam) return
    const started = performance.now()
    this.viewportSettling = true
    let deadline = started + ThreadViewLoadOlderMessages.VIEWPORT_SETTLE_MS
    const step = (): void => {
      this.viewportSettleFrame = 0
      if (!this.alive || !this.viewportSettling) return
      const before = this.scrollEl?.scrollTop ?? 0
      this.restoreViewportSeam()
      const corrected = Math.abs((this.scrollEl?.scrollTop ?? 0) - before) > 0.5
      if (corrected) deadline = performance.now() + ThreadViewLoadOlderMessages.VIEWPORT_SETTLE_MS
      const now = performance.now()
      if (now < deadline && now - started < ThreadViewLoadOlderMessages.VIEWPORT_HOLD_MS) {
        this.viewportSettleFrame = requestAnimationFrame(step)
        return
      }
      this.viewportSettling = false
      this.viewportSeam = null
    }
    this.viewportSettleFrame = requestAnimationFrame(step)
  }

  private stopViewportSettle(): void {
    if (this.viewportSettleFrame) cancelAnimationFrame(this.viewportSettleFrame)
    this.viewportSettleFrame = 0
    this.viewportSettling = false
  }

  /** How many pages one arrival at the history row may pull. A page that lands
   *  above the reader moves the row up by exactly the height it inserted, so a
   *  row that is STILL on screen means the transcript has room for another
   *  page between it and the reader   that is what fills the pane instead of
   *  leaving a short page parked at the top. Bounded so the fill can never run
   *  away on a thread whose rows are tiny. */
  private static readonly HISTORY_FILL_LIMIT = 8

  /** True while the fill loop is running. Plain, not reactive. */
  private historyFilling = false

  /**
   * Load the next page of history the moment the "Load earlier messages" row
   * comes into view.
   *
   * The reader no longer has to reach for the button: reaching the top of the
   * transcript is the request itself. The row is the sentinel, so nothing loads
   * while it is still off screen above or still below the fold   only its
   * arrival in view does.
   *
   * This is the conversation-level fetch only. A working trace paging its own
   * older entries up is a separate observer on its own body (see
   * `WorkingTrace.svelte`), and both stop as soon as the row or the trace body
   * leaves the zone they watch.
   */
  watchHistoryHead(node: HTMLElement): () => void {
    let cancelled = false
    let observer: IntersectionObserver | undefined
    void tick().then(() => {
      if (cancelled) return
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) void this.autoLoadOlderMessages()
          }
        },
        // The transcript scroller is the frame: the row counts as arrived when
        // it is inside what the reader can actually see, not merely when it is
        // inside the document.
        { root: this.scrollEl ?? null, threshold: 0 }
      )
      observer.observe(node)
    })
    return () => {
      cancelled = true
      observer?.disconnect()
    }
  }

  /** Whether the transcript is currently shorter than the pane it sits in. */
  private transcriptCannotScroll(): boolean {
    const el = this.scrollEl
    if (!el) return false
    return el.scrollHeight - el.clientHeight <= 1
  }

  /** Whether the history row is inside the visible part of the transcript right
   *  now. Measured fresh, never latched: the row is the trigger, so a row still
   *  on screen after a page landed means the transcript wants another page. */
  private historyRowVisible(): boolean {
    const el = this.scrollEl
    const row = this.root.studioTemporaryChatContext.historyHeadEl
    if (!el || !row || !row.isConnected) return false
    const rect = row.getBoundingClientRect()
    const frame = el.getBoundingClientRect()
    return rect.bottom > frame.top + 1 && rect.top < frame.bottom - 1
  }

  /** The scroll-triggered load.
   *
   *  A click on the button is a deliberate leave from the live tail, so that
   *  path pins the viewport for good and mounts three turns of history at once.
   *  A reader whose transcript is shorter than the viewport sees the history
   *  row without ever scrolling, so the scroll path keeps filling while the row
   *  is still on screen: one turn per pass, and it stops the moment the page
   *  that landed pushed the row out of view or the thread has nothing older. */
  private async autoLoadOlderMessages(): Promise<void> {
    if (!this.alive || this.historyFilling) return
    // Loading is the reader's request, and one of two things makes it: they
    // scrolled up towards the row, or the transcript has nothing to scroll yet
    // because the turn it opened on fits the pane. The second case is a
    // dead end otherwise   an empty scrollbar is not a way to ask for history.
    if (!this.readerReachedUp && !this.transcriptCannotScroll()) return
    this.historyFilling = true
    try {
      for (let page = 0; page < ThreadViewLoadOlderMessages.HISTORY_FILL_LIMIT; page += 1) {
        if (!this.alive) return
        if (!this.historyRowVisible()) return
        if (!this.root.unmirroredTraceStartTime.hasOlderMessages) return
        const messagesBefore = this.messages.length
        const startBefore = this.mountedStartIndex
        await this.loadOlderMessages(true)
        if (!this.alive) return
        // A pass that neither fetched nor mounted anything would spin here.
        if (this.messages.length === messagesBefore && this.mountedStartIndex === startBefore)
          return
      }
    } finally {
      this.historyFilling = false
    }
  }

  async loadOlderMessages(auto = false): Promise<void> {
    if (
      !this.scrollEl ||
      this.loadingOlderMessages ||
      !this.root.unmirroredTraceStartTime.hasOlderMessages
    )
      return
    // The block every page below is inserted above. Pinning it is what keeps
    // the reader's view exactly where they left it, with the new page waiting
    // off screen above until they scroll up into it.
    this.holdViewportSeam()
    if (this.root.props.controller) {
      // A controller's transcript mounts every message it holds, so the page that
      // lands above the seam is the page the reader watches arrive.
      const seam = this.root.studioTemporaryChatContext.historySeamElement()
      await this.root.props.controller.loadOlder()
      if (!this.alive) return
      await tick()
      this.restoreViewportSeam()
      this.settleViewportSeam()
      playHistoryArrive(
        this.root.studioTemporaryChatContext.historyArrivedBlocks(seam),
        this.scrollEl ?? null
      )
      return
    }
    this.loadingOlderMessages = true
    // Loading history is an explicit request to inspect the past.
    this.userScrolledAway = true
    // Pin the window before anything prepends   with an anchor pinned, the
    // mounted content cannot change no matter what merges behind it, so the
    // fetch loop needs no scroll compensation at all. The pin is the window's
    // CURRENT start, never a tail-relative count: the two differ on a long
    // turn, and a count-based pin would start the window later than what is
    // already mounted and destroy the reader's viewport before the fetch even
    // begins.
    this.windowStartId ??= this.root.composerScope.mountedWindowStartId()
    try {
      // A click loads THREE turn-aligned pages; the scroll trigger loads ONE, so
      // the insert stays small, lands fast, and the reader keeps scrolling into
      // it as if the transcript were simply longer. The store usually already
      // holds some of it, so fetch only while it does not   each fetch is a
      // bounded 40-message page and turns that span more than one page keep it
      // fetching until enough deduped turn starts exist before the anchor.
      const turnPages = auto ? 1 : 3
      let pagesWithoutTurnStart = 0
      for (let attempt = 0; attempt < (auto ? 1 : 30); attempt++) {
        const startsBefore = turnStartPromptsBefore(
          this.root.buildSpecActionPrompt.structureMessages,
          this.mountedStartIndex,
          turnPages
        )
        if (startsBefore.length === turnPages) break
        const el = this.scrollEl
        if (!el || !this.olderMessagesAvailable) break
        const oldest = this.messages[0]
        if (!oldest) {
          this.olderMessagesAvailable = false
          break
        }
        const before: ThreadMessageCursor = { createdAt: oldest.createdAt, id: oldest.id }
        const page = await invoke(
          'thread:loadMessages',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          before,
          HISTORY_WINDOW_SIZE
        )
        if (!this.alive) return
        this.olderMessagesAvailable = page.hasOlder
        if (page.messages.length === 0) {
          this.olderMessagesAvailable = false
          break
        }
        threadMessages.mergePage(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          page.messages
        )
        this.mountedCount += page.messages.length
        await tick()
        if (startsBefore.length === 0) {
          pagesWithoutTurnStart += 1
          if (pagesWithoutTurnStart >= 3) break
        }
      }
      // Turn-align the store's oldest boundary: a raw 40-row page can end
      // mid-turn, cutting that turn's prompt out of the cache entirely   the
      // loaded page would then begin at a working trace with its prompt
      // missing above it. Extend the fetch until the oldest row is a turn's
      // prompt (or the thread truly has nothing older). A scroll-triggered load
      // allows itself one page for this: the reader is scrolling, and every
      // extra round trip is a stall they can feel.
      for (let align = 0; align < (auto ? 1 : 4); align++) {
        const oldest = this.messages[0]
        if (!oldest) break
        if (oldest.role === 'user' && !isActivityOnlyUserMessage(oldest)) break
        // Nothing to align to when the thread holds no user prompt at all:
        // keep the three pages already fetched instead of walking the whole
        // thread looking for a boundary that does not exist.
        if (
          !this.messages.some(
            (message) => message.role === 'user' && !isActivityOnlyUserMessage(message)
          )
        ) {
          break
        }
        if (!this.olderMessagesAvailable) break
        const before: ThreadMessageCursor = { createdAt: oldest.createdAt, id: oldest.id }
        const page = await invoke(
          'thread:loadMessages',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          before,
          HISTORY_WINDOW_SIZE
        )
        if (!this.alive) return
        this.olderMessagesAvailable = page.hasOlder
        if (page.messages.length === 0) {
          this.olderMessagesAvailable = false
          break
        }
        threadMessages.mergePage(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          page.messages
        )
        this.mountedCount += page.messages.length
        await tick()
      }
      // Move the window back to the turn the loaded page opens with   or to the
      // thread's very beginning when fewer complete turns exist. The block at
      // the old window start is the seam the pages land above, and it is held
      // exactly where it was, so the loaded page waits off screen above the
      // reader until they scroll into it.
      // The anchor must be the start of a turn   a user prompt   never a
      // trace row. Landing on a trace presented the loaded page cut off at
      // its beginning, with the turn's prompt missing above it.
      const starts = turnStartPromptsBefore(
        this.root.buildSpecActionPrompt.structureMessages,
        this.mountedStartIndex,
        turnPages
      )
      let target = starts.length >= turnPages ? starts[starts.length - 1] : 0
      const isRealPrompt = (index: number): boolean => {
        const message = this.messages[index]
        return !!message && message.role === 'user' && !isActivityOnlyUserMessage(message)
      }
      while (target < this.mountedStartIndex && !isRealPrompt(target)) target += 1
      // No user prompt exists before the mounted window (a worker thread whose
      // opening prompt is still hidden, or a trace-only run). There is no turn
      // boundary to align to, so mount everything that was just loaded instead
      // of refusing to move the window and leaving the click a no-op.
      if (target >= this.mountedStartIndex) target = 0
      if (target < this.mountedStartIndex) {
        const seam = this.root.studioTemporaryChatContext.historySeamElement()
        const previousHeight = this.scrollEl?.scrollHeight ?? 0
        const previousTop = this.scrollEl?.scrollTop ?? 0
        this.windowStartId = this.messages[target]?.id ?? null
        // Keep the tail-relative count in sync so releasing the anchor at
        // the bottom never shrinks the window below what is mounted.
        this.mountedCount = Math.max(this.mountedCount, this.messages.length - target)
        await tick()
        // Same task as the mount, so the shifted layout is never painted.
        this.restoreViewportSeam()
        const after = this.scrollEl
        if (after) {
          if (!this.viewportSeam) {
            // No seam element to hold on to   fall back to the height-delta
            // compensation rather than leaving the viewport unmoved.
            after.scrollTop = previousTop + (after.scrollHeight - previousHeight)
          }
          threadScrollPositions.set(this.root.handleAgentEvent.thread.id, {
            top: after.scrollTop,
            awayFromBottom: this.userScrolledAway
          })
        }
        // The page is mounted and the reader's view is exactly where they left
        // it, so what landed on screen can fade in instead of blinking on.
        // Blocks above the viewport are left alone, which is both what the
        // reader can watch and what keeps a large load from animating a hundred
        // blocks at once (`playHistoryArrive`).
        playHistoryArrive(
          this.root.studioTemporaryChatContext.historyArrivedBlocks(seam),
          after ?? null
        )
        // Content inside the page can still find its height a frame or two
        // later; hold the seam across that window so it never pushes the
        // reader's view down.
        this.settleViewportSeam()
      }
    } catch {
      // A transient page failure leaves the current window intact; the next
      // button press can retry from the same cursor.
    } finally {
      this.loadingOlderMessages = false
    }
  }

  scrollToLatest(): void {
    if (!this.scrollEl) return
    // Snap instantly   a smooth scroll races the agent's stream: its target
    // is captured once, so while it animates the bottom keeps growing and the
    // scroll lands short, re-locking the user as "away". Arming the follow
    // lock synchronously and re-anchoring a tick later keeps the tail engaged
    // even if the bottom grew between the click and this snap's scroll event.
    this.userScrolledAway = false
    this.windowStartId = null
    this.scrollEl.scrollTo({ top: this.scrollEl.scrollHeight, behavior: 'auto' })
    void tick().then(() => {
      if (!this.scrollEl || this.userScrolledAway) return
      if (!this.root.unmirroredTraceStartTime.isAtBottom(this.scrollEl)) {
        this.scrollEl.scrollTop = this.scrollEl.scrollHeight
      }
    })
  }

  async loadLocal(attempt = 0): Promise<void> {
    // Controller-driven conversations load themselves; ThreadView just renders.
    if (this.root.props.controller) return

    const { projectId, id } = this.root.handleAgentEvent.thread
    await threadMessages.waitForLoad(projectId, id)
    // The eager boot preload (or a hover preload) may have already landed while
    // the view was mounting. Mount the tail right here instead of holding the
    // conversation behind the settings and config reads below: those enrich the
    // chrome, never the transcript.
    if (threadMessages.messages(projectId, id).length > 0) {
      this.root.composerScope.beginInitialPaintReveal()
    }
    // New empty thread seeded as loaded before mount must render the
    // composer instantly   zero IPC on the critical path. All persistence
    // reads enrich state in the background without ever blocking typing
    // or voice, and never show "Loading conversation...".
    const alreadySeeded = threadMessages.loaded(projectId, id)
    if (alreadySeeded && threadMessages.messages(projectId, id).length === 0) {
      // Seeded empty thread: composer must paint on the very first frame with
      // zero synchronous work beyond the reactive `loaded` flag already set.
      // Every other hydration step is fully async and never blocks typing/voice;
      // git branch arrives later via the thread:update broadcast.
      this.olderMessagesAvailable = false
      // Defer all non-composer hydration off the paint   schedule as microtask
      // so the first frame only mounts ChatComposer.
      queueMicrotask(() => {
        if (!this.alive) return
        if (this.root.handleAgentEvent.thread.settings) {
          this.settings = this.root.sources.initialThreadSettings(this.root.handleAgentEvent.thread)
        }
        this.root.contextUsage.auditSettings = this.root.sources.auditSettingsForThread()
        this.root.abortRun.syncOpenSubagentTabs()
        if (!this.root.unmirroredTraceStartTime.liveStatusKnown) {
          this.root.buildSpecActionPrompt.restoreWorkingState(
            this.root.handleAgentEvent.thread.status,
            this.root.handleAgentEvent.thread.auditState === 'running'
          )
        }
        this.root.steerQueuedMessage.restoreQueuedMessage()
        this.root.composerScope.restoreResponseReferences()
      })
      // Background persistence/config enrichment   never blocks input, never shows loading
      void Promise.all([invoke('thread:get', projectId, id), invoke('config:get')])
        .then(([threadData, config]) => {
          if (!this.alive) return
          // Self-heal the history flag: a thread seeded empty must never stay
          // permanently unable to lazy-load. One bounded probe off the critical
          // path verifies against disk and merges real history if seeding raced
          // a non-empty thread.
          if (this.olderMessagesAvailable !== true) {
            void threadMessages
              .mergeTurnAlignedTail(projectId, id, HISTORY_WINDOW_SIZE)
              .then((hasOlder) => {
                if (!this.alive) return
                this.olderMessagesAvailable = hasOlder
              })
              .catch(() => {})
          }
          queueMicrotask(() => {
            if (!this.alive) return
            if (threadData?.settings) {
              this.settings = this.root.sources.initialThreadSettings(threadData)
            }
            this.root.sources.agentDefaults = config.agentDefaults
            this.root.unmirroredTraceStartTime.imageDescriptorAskAgain =
              config.imageDescriptorAskAgain === true
            this.root.unmirroredTraceStartTime.autoRetryAfterReset =
              config.autoRetryAfterReset === true
            this.root.contextUsage.auditSettings = this.root.sources.auditSettingsForThread()
            if (threadData?.sessionId) {
              threadMessages.setSessionId(projectId, id, threadData.sessionId)
            }
            this.root.abortRun.syncOpenSubagentTabs()
            this.root.studioTemporaryChatContext.seedContextUsageSnapshot(threadData?.contextUsage)
            this.root.steerQueuedMessage.restoreQueuedMessage()
            this.root.composerScope.restoreResponseReferences()
          })
        })
        .catch(() => {})
      return
    }
    try {
      const [threadData, , config] = await Promise.all([
        invoke('thread:get', projectId, id),
        // A warm cache is re-read, never trusted. A sibling instance writes the
        // same mirrored conversation this window holds, and its announcement is
        // best effort: a batch still waiting on the coalescing timer when the
        // sibling quits is lost, so a thread opened here after that write kept
        // showing only the prompt it had cached. The refresh is the same bounded
        // turn-aligned tail a cold open takes, and it merges additively, so
        // nothing already on screen is dropped.
        threadMessages.loaded(projectId, id)
          ? threadMessages.mergeTurnAlignedTail(projectId, id, THREAD_MESSAGE_PRELOAD_WINDOW)
          : threadMessages.load(projectId, id, THREAD_MESSAGE_PRELOAD_WINDOW),
        invoke('config:get')
      ])
      if (!this.alive) return
      this.olderMessagesAvailable = threadMessages.hasOlder(projectId, id)
      // Cold cache: the bounded preload just landed   stage the first paint
      // around the newest tail now. No-op when the warm path already revealed.
      this.root.composerScope.beginInitialPaintReveal()
      if (threadData?.settings) {
        this.settings = this.root.sources.initialThreadSettings(threadData)
      }
      this.root.sources.agentDefaults = config.agentDefaults
      this.root.unmirroredTraceStartTime.imageDescriptorAskAgain =
        config.imageDescriptorAskAgain === true
      this.root.unmirroredTraceStartTime.autoRetryAfterReset = config.autoRetryAfterReset === true
      this.root.contextUsage.auditSettings = this.root.sources.auditSettingsForThread()
      // Re-bind the thread's persisted session so its live events keep routing
      // to this cache (and the background queue dispatcher) even when the
      // renderer never sent a message on this mount.
      if (threadData?.sessionId) {
        threadMessages.setSessionId(projectId, id, threadData.sessionId)
      }
      this.root.abortRun.syncOpenSubagentTabs()
      // The live session status (connectSession) is authoritative; only fall
      // back to the persisted thread status when no live status was seen.
      if (!this.root.unmirroredTraceStartTime.liveStatusKnown) {
        this.root.buildSpecActionPrompt.restoreWorkingState(
          threadData?.status ?? this.root.handleAgentEvent.thread.status,
          (threadData?.auditState ?? this.root.handleAgentEvent.thread.auditState) === 'running'
        )
      }
      this.root.studioTemporaryChatContext.seedContextUsageSnapshot(threadData?.contextUsage)
      this.root.steerQueuedMessage.restoreQueuedMessage()
      this.root.composerScope.restoreResponseReferences()
    } catch {
      // A single transient failure must not silently drop the settings, mirror,
      // and status restore   retry once, then degrade gracefully. Anything the
      // failed pass already merged still paints: a metadata read failing is not
      // a reason to hide a transcript that is in memory.
      if (attempt === 0) {
        return this.loadLocal(1)
      }
      this.root.composerScope.beginInitialPaintReveal()
    }
  }

  /** Restore app-owned session state without contacting native harness transport. */
  async connectSession(): Promise<void> {
    // Controller-driven conversations own their own session handshake.
    if (this.root.props.controller) return

    const { projectId, id } = this.root.handleAgentEvent.thread
    // Independent extras   each lands as it resolves, none block the paint.
    void this.root.abortRun.refreshCheckpoints()
    void this.root.switchProject.loadProjectContext()
    // The durable fold is the one read the open path cannot answer from the
    // message mirror, and the session handshake below is a chain of round
    // trips of its own. Its request leaves first, so it is already in flight
    // while the status, permission, and question reads run. A hover preload has
    // usually warmed the fold and the main process's log reader, which makes
    // this a refresh rather than the first read.
    const latestTraceWindow = this.root.pollStreamParts.loadLatestTraceWindow()

    if (this.root.composerScope.shouldHydrateEngineeringState()) {
      try {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
        if (!this.alive) return
        await this.root.submitBrainstormDecision.reconcileReadySpec()
      } catch (error) {
        this.root.handleAgentEvent.errorMessage =
          error instanceof Error ? error.message : 'The specification could not be loaded.'
      }
    }

    try {
      this.root.handleAgentEvent.providerStatus = await invoke(
        'agent:getSessionStatus',
        projectId,
        id
      )
      if (!this.alive) return
      if (
        this.root.handleAgentEvent.providerStatus === null &&
        this.settings.harnessId === 'claude-code'
      ) {
        void this.root.submitBrainstormDecision.probeHarnessAuthentication()
      }
      // The live session status is the single source of truth on mount. Once
      // established, loadLocal's broader DB workflow status must not override
      // it. In particular, a coordinator can be persisted as executing while
      // only its workers or auditor are active; live idle must clear that fake
      // raw-busy state so messages go to the Sr. Engineer normally.
      // A null result is also a completed, authoritative answer: there is no
      // live session state to restore. The previous implementation left this
      // false for null, allowing later `thread:updated` events to re-apply the
      // stale persisted `planning`/`executing` status after we had cleared it.
      this.root.unmirroredTraceStartTime.liveStatusKnown = true
      if (this.root.handleAgentEvent.providerStatus?.state === 'working') {
        this.root.currentWorkingTraceAttribution.ensureLiveWorkingSelection()
        agentRuns.setBusy(
          projectId,
          id,
          true,
          this.root.submitBrainstormDecision.latestUserMessageId(),
          this.root.handleAgentEvent.providerStatus.state === 'working'
            ? this.root.handleAgentEvent.providerStatus.startedAt
            : undefined
        )
      } else if (
        this.root.handleAgentEvent.providerStatus?.state === 'waiting' ||
        this.root.handleAgentEvent.providerStatus?.state === 'error' ||
        this.root.handleAgentEvent.providerStatus?.state === 'idle'
      ) {
        this.root.buildSpecActionPrompt.setIdleFromRestore()
      }
      await this.root.editVideoNote.refreshPendingPermissions()
      if (!this.alive) return
      await this.root.sources.refreshPendingImageDescriptorError()
      if (!this.alive) return
      await this.root.composerScope.refreshPendingQuestions()
      if (!this.alive) return
      this.root.abortRun.syncOpenSubagentTabs()
      // A queued message restored from the recovery snapshot should be
      // dispatched as soon as the agent is known idle. Wait for the local
      // mirror + restore to finish so the queue is populated before deciding.
      await this.root.unmirroredTraceStartTime.localReady
      if (!this.alive) return
      // No live session record means the persisted in-flight status is stale: a
      // genuinely running turn always registers its session status (or a pending
      // spec/retry surfaces it). loadLocal may have optimistically restored busy
      // off a leftover `planning`/`executing` DB row   clear it so a finished or
      // never-started thread never keeps the composer/rows looking busy after a
      // view switch or refresh. The one exception is persisted evidence of a
      // mid-flight turn: if the saved latest turn has real working parts and no
      // terminal message, rehydrate that working trace (with a "restored /
      // saved-activity note) instead of dropping to idle, so the user can tell a
      // run was in progress even though the live stream is not confirming it.
      // The thread itself stays interactive (not busy) so a poke message can
      // still be sent normally. Paused retry waits are represented by the
      // provider status card, not by a misleading reconnecting trace.
      const liveSessionWorking = this.root.handleAgentEvent.providerStatus?.state === 'working'
      this.root.buildSpecActionPrompt.restoredBusy =
        this.root.handleAgentEvent.providerStatus === null &&
        this.root.handleAgentEvent.thread.status !== 'working-paused' &&
        this.root.pollStreamParts.hasPersistedInFlightWork()
      // Always rebuild the latest logical turn from the durable SSE log. The
      // bounded mirror can contain only the newest snapshot of a long turn,
      // and a finished thread still needs the same complete trace after a
      // refresh or thread switch. Only the newest page is read here; older
      // entries page in on the trace's own inner scroll.
      void this.root.pollStreamParts.loadCompletedTurns()
      const page = await latestTraceWindow
      if (!this.alive) return
      if (page) {
        if (
          this.root.handleAgentEvent.providerStatus === null &&
          this.root.handleAgentEvent.thread.status !== 'working-paused' &&
          !this.root.buildSpecActionPrompt.restoredBusy &&
          hasRenderableWorkingParts(page.parts)
        ) {
          // Only a saved run that is still the newest work may claim the
          // restored-trace state. Once the user has sent a newer message
          // (locally submitted turn, or a pending user message after the
          // last assistant turn), that stale trace is history: it must stay
          // folded with frozen durations while the new run gets its own
          // live trace.
          const latestStart = this.root.buildSpecActionPrompt.latestTurnInfo.startIndex
          let turnEnd = latestStart
          while (
            turnEnd + 1 < this.messages.length &&
            this.messages[turnEnd + 1]?.role !== 'user'
          ) {
            turnEnd += 1
          }
          const hasNewerUserWork =
            latestStart === -1 ||
            this.root.buildSpecActionPrompt.locallySubmittedTurnId !== null ||
            this.messages.slice(turnEnd + 1).some((message) => message.role === 'user')
          this.root.buildSpecActionPrompt.restoredBusy =
            !hasNewerUserWork && !this.root.unmirroredTraceStartTime.isLatestTurnCompleted()
        }
      }
      if (!liveSessionWorking && this.root.handleAgentEvent.providerStatus === null)
        this.root.buildSpecActionPrompt.setIdleFromRestore()
      // Never pull the full live harness transcript while mounting a thread.
      // `agent:loadMessages` is intentionally unbounded: a long-running agent
      // can return thousands of parts, and the main process then synchronizes
      // and serializes that whole transcript before the renderer can use it.
      // The bounded mirror page above keeps opening interactive immediately;
      // live events continue to populate the current turn, and the durable
      // stream log restores interrupted work when no live session exists.
      // A full provider transcript must only be loaded by an explicit workflow,
      // never as a side effect of opening a thread.
      if (this.root.handleAgentEvent.providerStatus?.state === 'idle') {
        this.root.steerQueuedMessage.scheduleIdleAttention()
      }
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'Could not connect to the agent.'
    }
  }
}
