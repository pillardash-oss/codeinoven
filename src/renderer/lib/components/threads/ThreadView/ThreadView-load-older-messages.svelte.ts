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
/** One concern of the ThreadView board. */
export class ThreadViewLoadOlderMessages {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root)
      throw new Error('ThreadViewLoadOlderMessages read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
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

  alive = $state(true)

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
   *  deriveds must stay pure. A minimum of TWO pages is always mounted: the
   *  current working page ([prompt][trace][output]) and the previous page,
   *  even when it sits out of the viewport. */
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
        return Math.min(countStart, index)
      }
      return countStart
    }
    const covered = promptPagesBefore(this.messages, turnStart, 2)
    return Math.min(countStart, covered === -1 ? 0 : covered)
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

  jumpLoading = $state(false)

  // svelte-ignore state_referenced_locally
  settings = $state<ThreadSettings>(
    this.hasController
      ? normalizeChatSettings(this.root.props.controller!.settings)
      : this.root.sources.initialThreadSettings(this.root.handleAgentEvent.thread)
  )

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
    } else if (!away && this.userScrolledAway) {
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
    // History is button-driven by design: scrolling to the top of the
    // conversation never auto-loads older pages. The "Load earlier messages"
    // button is the only trigger for the conversation-level history fetch.
  }

  loadingOlderMessages = $state(false)

  async loadOlderMessages(): Promise<void> {
    if (
      !this.scrollEl ||
      this.loadingOlderMessages ||
      !this.root.unmirroredTraceStartTime.hasOlderMessages
    )
      return
    if (this.root.props.controller) {
      // A controller's transcript mounts every message it holds, so the page that
      // lands above the seam is the page the reader watches arrive.
      const seam = this.root.studioTemporaryChatContext.historySeamElement()
      await this.root.props.controller.loadOlder()
      if (!this.alive) return
      await tick()
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
      // One click loads THREE turn-aligned pages: the store usually already
      // holds some of them, so fetch only while it does not   each fetch is a
      // bounded 40-message page and turns that span more than one page keep
      // it fetching until three deduped turn starts exist before the anchor.
      let pagesWithoutTurnStart = 0
      for (let attempt = 0; attempt < 30; attempt++) {
        const startsBefore = turnStartPromptsBefore(
          this.root.buildSpecActionPrompt.structureMessages,
          this.mountedStartIndex,
          3
        )
        if (startsBefore.length === 3) break
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
        // A prompt-less run (a worker trace, or a thread whose opening prompt
        // is still hidden) has no turn boundary to align to. Three pages is
        // the whole chunk one click should mount; stop before over-fetching.
        if (startsBefore.length === 0) {
          pagesWithoutTurnStart += 1
          if (pagesWithoutTurnStart >= 3) break
        }
      }
      // Turn-align the store's oldest boundary: a raw 40-row page can end
      // mid-turn, cutting that turn's prompt out of the cache entirely   the
      // loaded page would then begin at a working trace with its prompt
      // missing above it. Extend the fetch until the oldest row is a turn's
      // prompt (or the thread truly has nothing older).
      for (let align = 0; align < 4; align++) {
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
      // Move the anchor back three pages   or to the thread's very beginning
      // when fewer complete pages exist   then keep the reader's viewport
      // stable across the mount. The restore is anchored to the first on-screen
      // message element, not a height delta: a height-delta write drifts
      // whenever the newly mounted pages' real laid-out height differs from
      // the height measured at tick time, and the taller the loaded pages the
      // further that drift throws the reader (all the way to the bottom).
      const el = this.scrollEl
      const firstVisibleId = this.root.composerScope.visibleMessages[0]?.id
      const firstVisibleEl = firstVisibleId
        ? document.getElementById(`msg-${firstVisibleId}`)
        : undefined
      const viewportOffset =
        el && firstVisibleEl
          ? firstVisibleEl.getBoundingClientRect().top - el.getBoundingClientRect().top
          : undefined
      const previousHeight = el?.scrollHeight ?? 0
      const previousTop = el?.scrollTop ?? 0
      // The anchor must be the start of a turn   a user prompt   never a
      // trace row. Landing on a trace presented the loaded page cut off at
      // its beginning, with the turn's prompt missing above it.
      const starts = turnStartPromptsBefore(
        this.root.buildSpecActionPrompt.structureMessages,
        this.mountedStartIndex,
        3
      )
      let target = starts.length === 3 ? starts[starts.length - 1] : 0
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
        this.windowStartId = this.messages[target]?.id ?? null
        // Keep the tail-relative count in sync so releasing the anchor at
        // the bottom never shrinks the window below what is mounted.
        this.mountedCount = Math.max(this.mountedCount, this.messages.length - target)
        await tick()
        const after = this.scrollEl
        if (after) {
          const afterEl = firstVisibleId
            ? document.getElementById(`msg-${firstVisibleId}`)
            : undefined
          if (afterEl && viewportOffset !== undefined) {
            // Position of the anchor message within the scroll content, then
            // place it back at the exact viewport offset it had before the
            // prepended pages mounted above it.
            const contentOffset =
              afterEl.getBoundingClientRect().top -
              after.getBoundingClientRect().top +
              after.scrollTop
            after.scrollTop = Math.max(0, contentOffset - viewportOffset)
          } else {
            // Element anchor unavailable   fall back to the height-delta
            // compensation rather than leaving the viewport unmoved.
            after.scrollTop = previousTop + (after.scrollHeight - previousHeight)
          }
          threadScrollPositions.set(this.root.handleAgentEvent.thread.id, {
            top: after.scrollTop,
            awayFromBottom: this.userScrolledAway
          })
        }
        // The loaded page is in the document and the viewport is back where the
        // reader left it, so the blocks that landed inside it can settle into
        // place instead of blinking on. Blocks above the viewport are left alone,
        // which is both what the reader can watch and what keeps a three-page
        // load from animating a hundred blocks at once (`playHistoryArrive`).
        playHistoryArrive(
          this.root.studioTemporaryChatContext.historyArrivedBlocks(seam),
          after ?? null
        )
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
      // and status restore   retry once, then degrade gracefully.
      if (attempt === 0) {
        return this.loadLocal(1)
      }
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
