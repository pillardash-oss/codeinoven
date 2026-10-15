<script lang="ts">
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import {
    AUTHORED_WORK_ICON_BY_KIND,
    AUTHORED_WORK_NAME_BY_KIND
  } from '$lib/authored-work-presentation'
  import { feature } from '$lib/feature-registry'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import ThreadDropdown from '$lib/components/shared/ThreadDropdown.svelte'
  import ThreadHoverPopover from '$lib/components/shared/ThreadHoverPopover.svelte'
  import { formatCompactAge, formatDateTime } from '$shared/date-time-format'
  import { createThreadActionsMenu } from '$lib/components/shared/thread-actions-menu.svelte'
  import {
    calculateThreadHoverPopoverPosition,
    resolveThreadHoverPopoverSize,
    THREAD_HOVER_POPOVER_SURFACE_CLASS,
    threadHoverPopoverStyle
  } from '$lib/components/shared/thread-hover-popover-layout'
  import ChangeScopeModal from '$lib/components/threads/ChangeScopeModal.svelte'
  import ThreadIndicatorSlot from '$lib/components/threads/ThreadIndicatorSlot.svelte'
  import type { ThreadIndicator } from '$lib/components/threads/thread-indicator'
  import {
    threadActionMark,
    threadStateMark,
    type ThreadStateMark
  } from '$lib/components/threads/thread-state-marks'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ThreadDeleteConfirm from '$lib/components/ui/ThreadDeleteConfirm.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { longPress } from '$lib/long-press.svelte'
  import { pickColorForSeed } from '$lib/project-colors'
  import { generateInitialsIconSvg, getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { speechController } from '$lib/speech/speech-controller.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { browserStore } from '$lib/stores/browser-access.svelte'
  import { browserAudio } from '$lib/stores/browser-audio.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { effectiveThreadTitle } from '$lib/stores/draft-label'
  import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
  import { pipState } from '$lib/stores/pip.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { ovens } from '$lib/stores/ovens.svelte'
  import { temporaryChatUnread } from '$lib/stores/temporary-chat-unread.svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { threadNotesState } from '$lib/stores/thread-notes.svelte'
  import { isThreadLiveWorking } from '$lib/thread-status-badge'
  import { threadScopeBucket } from '$lib/threads/thread-scope'
  import { threadBranchRowLabel } from '$lib/threads/thread-branch-label'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import type { AuthoredWorkKind } from '$shared/ipc-contract'
  import { threadStatusPolicy } from '$shared/thread-status-policy'
  import type { Thread } from '$shared/types'
  import {
    coordinatorHasActiveDelegates,
    coordinatorHasUnreadWorkers,
    DEFAULT_SCOPE_BUCKET_ID,
    isOrchestrationChildThread,
    isThreadBusy
  } from '$shared/types'
  import { LOCAL_OVEN_ID } from '$shared/ovens'
  import {
    AppWindow,
    Eye,
    Check,
    Clock,
    GitBranch,
    MessageCircleDashed,
    Monitor,
    Pin,
    Server
  } from '@lucide/svelte'
  import { Portal } from 'bits-ui'
  import type { Component } from 'svelte'
  import { tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    thread: Thread
    selected?: boolean
    /** Dense one/two-line rendering: the pinned section, scope slices, the
     *  board, and every other compact surface. */
    compact?: boolean
    /** Three-line rendering: the sidebar's Threads list and a project's own
     *  thread list. Every other view keeps the one/two-line row. */
    detailed?: boolean
    /** Hide the project name   the surrounding list already names the project
     *  (a project's own thread list sits under its folder). */
    hideProjectName?: boolean
    /** Presentation-only row for searchable thread pickers. */
    picker?: boolean
    /** Project icon URL to show before the status indicator. */
    projectIconUrl?: string | null
    /** Mark shown in the project-icon slot when the thread's container has no
     *  project icon of its own   the hidden Chats and Assistant containers. */
    projectIconGlyph?: Component | null
    /** Whether "Change Scope" appears in the actions menu. */
    showChangeScope?: boolean
    /** Hide the scope chip   used when the surrounding view is already scoped. */
    hideScope?: boolean
    onOpen?: (t: Thread) => void
    onRename?: (t: Thread, newName: string) => Promise<void>
    onTogglePin?: (t: Thread) => void
    onDelete?: (t: Thread) => Promise<void>
    onFork?: (t: Thread) => void
    /** Optional callback fired when the rename input changes (for move-on-edit behaviour). */
    onRenameInputChange?: (t: Thread) => void
    /** Callback for drag-to-reorder within the same list; position is relative to this item. */
    onMoveThread?: (id: string, targetId: string, position: 'before' | 'after') => void
  }

  let {
    thread,
    selected = false,
    compact = false,
    detailed = false,
    hideProjectName = false,
    picker = false,
    projectIconUrl = null,
    projectIconGlyph = null,
    showChangeScope = true,
    hideScope = false,
    onOpen = () => {},
    onRename = async () => {},
    onTogglePin = () => {},
    onDelete = async () => {},
    onFork = () => {},
    onRenameInputChange,
    onMoveThread
  }: Props = $props()

  const componentId = $props.id()
  let renameThreadFormId = $derived(`${componentId}-thread-${thread.id}-rename-form`)

  /** Title shown in the UI   the real title once generated, else a draft label. */
  let displayTitle = $derived(effectiveThreadTitle(thread))

  /** Project that owns this thread, resolved for the row's meta line. Hidden
   *  containers (Chats, Assistant) have no project record, so the name falls
   *  back to nothing and only the glyph shows. */
  let project = $derived(
    scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ?? null
  )
  let projectName = $derived(project?.name ?? null)

  /** Live temporary (side) chats hanging off this thread. A side chat is
   *  conversation started off this thread, so the row marks it wherever the row
   *  is shown. The mark is a fact about the thread, never a control: clicking
   *  the row already opens the thread the side chat hangs off. */
  let temporaryChats = $derived(contextSidebarState.temporaryChatsFor(thread.projectId, thread.id))
  let hasTemporaryChat = $derived(temporaryChats.length > 0)
  let temporaryChatLabel = $derived(
    temporaryChats.length > 1 ? `${temporaryChats.length} temporary chats` : 'Temporary chat'
  )

  /** How long the "todo" dot is held after a draft is cleared on send, so the
   *  badge does not flash to the thread's stale status before the harness
   *  confirms the new working state. */
  const DRAFT_GRACE_MS = 2000

  let effectivePinned = $derived(thread.pinned)

  let dropIndicator = $state<'before' | 'after' | null>(null)

  function setDragImage(e: DragEvent, label: string): void {
    const ghost = document.createElement('div')
    ghost.textContent = label
    ghost.style.cssText =
      'position:absolute;top:-1000px;left:-1000px;padding:3px 8px;background:var(--color-surface);border:1px solid var(--color-border);font-size:13px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    document.body.appendChild(ghost)
    e.dataTransfer!.setDragImage(ghost, 0, 0)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }

  function handleDragStart(e: DragEvent): void {
    e.dataTransfer!.setData('text/plain', thread.id)
    e.dataTransfer!.effectAllowed = 'move'
    setDragImage(e, thread.title)
  }

  function handleDragOver(e: DragEvent): void {
    // A folder/file dragged in from the OS belongs to the sidebar's drop target,
    // not to a thread reorder.
    if (e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    if (!onMoveThread) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dropIndicator = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  function handleDrop(e: DragEvent): void {
    if (e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    const draggedId = e.dataTransfer!.getData('text/plain')
    if (draggedId && draggedId !== thread.id && onMoveThread) {
      onMoveThread(draggedId, thread.id, dropIndicator ?? 'after')
    }
    dropIndicator = null
  }

  function handleDragLeave(): void {
    dropIndicator = null
  }

  let hovered = $state(false)
  /** The ellipsis was revealed by a long press, so closing the menu hides it again. */
  let touchRevealed = $state(false)
  let showMenu = $state(false)
  let showPopover = $state(false)
  let rowEl = $state<HTMLDivElement>()
  let popoverEl = $state<HTMLDivElement>()
  let popoverPos = $state({ x: 0, y: 0 })
  let popoverTimer: ReturnType<typeof setTimeout> | undefined
  /** Debounces the message warmup so a fast mouse pass never fires an IPC call. */
  let preloadTimer: ReturnType<typeof setTimeout> | undefined
  const PRELOAD_DEBOUNCE_MS = 200

  /** Warm the thread's message cache so a click opens without the "Loading
   *  conversation…" spinner. The bounded load is non-destructive and skipped
   *  once the thread has messages (the currently selected row is already
   *  loading through the open view, so it never needs this). */
  function preloadMessages(): void {
    if (picker || selected) return
    if (threadMessages.loaded(thread.projectId, thread.id)) return
    void threadMessages.preload(thread.projectId, thread.id)
  }

  /** Distinct harnesses used in this thread's session, newest first. */
  let harnessIds = $derived.by((): string[] => {
    // Defensive dedupe: a harness may appear more than once in the source data
    // (rows without usage-table entries), and a keyed each
    // block over it must never see the same key twice.
    const ids = Array.from(new Set(thread.usedHarnessIds ?? []))
    if (thread.settings?.harnessId && !ids.includes(thread.settings.harnessId)) {
      return [...ids, thread.settings.harnessId]
    }
    return ids
  })

  /** How many harness icons fit on the single bottom line before the +n chip. */
  let visibleHarnessCount = $state(0)
  let harnessRowEl = $state<HTMLSpanElement>()

  const captureHarnessRowElement: Attachment<HTMLSpanElement> = (element) => {
    harnessRowEl = element
    return () => {
      if (harnessRowEl === element) harnessRowEl = undefined
    }
  }

  function harnessName(id: string): string {
    return getAgentIcon(id)?.name ?? id
  }

  /** Harness icons shown on the full row's footer line before the `+n` chip. */
  const MAX_HARNESS_ICONS = 3

  /** Provider name for the thread's current model, resolved for its vendor icon. */
  let currentModelProviderName = $derived.by((): string | null => {
    const providerId = thread.settings?.providerId
    if (!providerId) return null
    const providers = providerCatalog.cached(thread.projectId) ?? providerCatalog.allCached()
    return providers.find((provider) => provider.id === providerId)?.name ?? null
  })

  /** Provider id of the thread's current model   ids drive icon resolution so
   *  custom CodeInOven providers (`cio-…`) always render the CodeInOven mark. */
  const currentModelProviderId = $derived(thread.settings?.providerId ?? null)

  $effect(() => {
    const row = harnessRowEl
    if (!row) return
    let frame = 0
    const measure = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const total = harnessIds.length
        if (total === 0) {
          visibleHarnessCount = 0
          return
        }
        // Each icon is 14px with a 4px gap. Show as many harness icons as fit,
        // favouring icons over a +n number; only reserve space for the +n chip
        // once something actually overflows. Never render more icons than fit
        // so overflow-hidden can't clip a partial icon off the edge.
        const ICON = 14
        const GAP = 4
        const PLUS = 22
        const perIcon = ICON + GAP
        let count = Math.floor((row.clientWidth + GAP) / perIcon)
        count = Math.min(total, count)
        if (count < total) {
          const withPlus = Math.floor((row.clientWidth - PLUS + GAP) / perIcon)
          count = Math.max(1, Math.min(total, withPlus))
        }
        visibleHarnessCount = count
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  })

  const captureRowElement: Attachment<HTMLDivElement> = (element) => {
    rowEl = element
    return () => {
      if (rowEl === element) rowEl = undefined
    }
  }

  const capturePopoverElement: Attachment<HTMLDivElement> = (element) => {
    popoverEl = element
    return () => {
      if (popoverEl === element) popoverEl = undefined
    }
  }

  const actionsMenu = createThreadActionsMenu({
    getThread: () => thread,
    onRename: (t, newName) => onRename(t, newName),
    onTogglePin: (t) => onTogglePin(t),
    onFork: (t) => onFork(t),
    onDelete: (t) => onDelete(t),
    onDeleteError: (error) =>
      reportError(error, 'Could not delete thread', {
        projectId: thread.projectId,
        threadId: thread.id
      }),
    onOpenNotes: (t) => {
      onOpen(t)
      contextSidebarState.openThreadNote(t.projectId, t.id, t.title, {
        edit: true,
        focusEditor: true
      })
    },
    showChangeScope: () => showChangeScope,
    showNotes: () => true,
    showCopyId: () => true
  })

  // ─── Status vs Stage ──────────────────────────────────────────────────────
  //
  //   Status  = overall thread state for the dot indicator
  //             working | spec | unread | error | completed | approval | read
  //   Stage   = what the agent is currently DOING (only when working)
  //             planning | executing
  //   Stage appears only in the hover popover, never on the row itself.
  //
  //   Badge dot conventions: todo = filled gray, done/read = transparent ring.

  type ThreadState =
    | 'unread'
    | 'temporary-unread'
    | 'read'
    | 'todo'
    | 'completed'
    | 'working'
    | 'working-paused'
    | 'spec'
    | 'approval'
    | 'error'
    | 'scheduled'
    | 'queued'

  /** Threads with any unsent composer content read as "todo" (filled gray dot).
   *  Live dictation counts too: from the first mic press through transcription
   *  the user is drafting with their voice, so the row must read as draft
   *  before the transcript ever reaches the composer. */
  let isDraft = $derived(
    rendererRecovery.hasDraftContent(thread.projectId, thread.id) ||
      speechController.isCapturingThread(thread.id)
  )

  /** Queued messages get a clock instead of the draft dot, including during live work. */
  let hasQueuedMessage = $derived(
    rendererRecovery.queuedMessageCount(thread.projectId, thread.id) > 0
  )

  /** A message scheduled behind other threads also gets the working-colour clock. */
  let hasStartAfterPending = $derived(
    rendererRecovery.hasStartAfterPending(thread.projectId, thread.id)
  )

  /** Orchestration worker/auditor threads stay silent: never presented as unread.
   *  A coordinator row, though, stays unread while any of its non-reporting
   *  workers is unread: it clears only once the coordinator itself and all of
   *  its workers are read. Reporting workers hold nothing open, since their
   *  progress shows through the Assignment lifecycle instead. */
  let effectiveRead = $derived(
    isOrchestrationChildThread(thread) ||
      (thread.read && !coordinatorHasUnreadWorkers(thread, scopeState.allScopeThreads))
  )

  /** A finished temporary (side) chat on this thread is still unread   the
   *  parent thread's own `read` flag never changes for side chats, so the
   *  badge comes from the side-chat store instead. */
  let hasTemporaryChatUnread = $derived(temporaryChatUnread.hasUnread(thread.projectId, thread.id))

  /** When the most recent unread side chat of this thread landed (0 if none). */
  let temporaryChatUnreadAt = $derived(
    temporaryChatUnread.lastUnreadAt(thread.projectId, thread.id)
  )

  /** When the parent thread's own run last settled (0 if never in this window). */
  let primarySettledAt = $derived(agentRuns.settledAt(thread.projectId, thread.id))

  /** Aggregate child activity onto the Sr. Engineer row   the public source of truth. */
  let delegatedWorkActive = $derived(
    coordinatorHasActiveDelegates(thread, scopeState.allScopeThreads)
  )

  /** Whether the agent is producing work right now. The one live-working rule
   *  (`isThreadLiveWorking`) keeps a thread parked on the user out of this, so a
   *  permission, question, or secret card never reads as work in progress   its
   *  status is the authority until the user answers. */
  let isWorking = $derived(isThreadLiveWorking(thread) || delegatedWorkActive)
  let isRetryPaused = $derived(thread.status === 'working-paused')
  /** Another CodeInOven instance owns this thread's in-flight turn, so its live
   *  output and its stop control are there rather than here. */
  let isForeignRun = $derived(foreignRuns.isForeign(thread.projectId, thread.id))
  let isBusyIndicator = $derived(
    isWorking || isRetryPaused || (Boolean(thread.sessionId) && isThreadBusy(thread) && !isDraft)
  )
  let isRecording = $derived(speechController.isRecordingThread(thread.id))
  /** The thread's agent is driving the computer right now   window-scoped or
   *  desktop-scoped. Shares the recorder's indicator slot via `indicator`. */
  let isUsingComputerUse = $derived(pipState.isThreadUsingComputerUse(thread.id))
  /** When a browser tab owned by this thread started playing sound, or null while
   *  the thread's browser is silent. Shares the recorder's indicator slot. */
  let browserAudioAt = $derived(browserAudio.threadAudioStartedAt(thread.id))
  /** TTS playing on this thread   shares the recorder's indicator slot. */
  let isSpeaking = $derived(!isRecording && speechController.isSpeakingThread(thread.id))
  /** The mic has closed but the transcript has not landed yet   same indicator
   *  slot, distinct label, shown only when neither recording nor speaking. */
  let isTranscribing = $derived(
    !isRecording && !isSpeaking && speechController.isTranscribingThread(thread.id)
  )
  /** Armed delivery of the transcription in flight: the user has told the app to
   *  send (or steer) the transcript the moment it lands. */
  let voiceSendStage = $derived(
    isTranscribing ? speechController.voiceSendStageForThread(thread.id) : null
  )
  /**
   * The row has one indicator slot and this is what owns it. Last action wins:
   * of listening, speaking, transcribing, and the agent using the computer, the
   * action that began most recently is shown. Recording start already cancels
   * playback, so the speech candidates cannot both be live; the speech
   * controller reports when each began and computer use reports the agent's
   * most recent action.
   *
   * The durable Engineering mark is not an action in flight. It is pushed last
   * with the oldest candidate time, so any live action takes the slot and the
   * mark returns the moment the slot is free.
   */
  /** Every live action on this thread right now, each kept rather than ranked
   *  away.
   *
   *  The old row resolved these to one winner because it had one status slot and
   *  a spinner, a clock and a vendor mark all had to share it. The state now
   *  lives on the rail, so the row can afford to say all of it: a thread that is
   *  recording while a browser tab of its own plays sound shows both, and a
   *  thread that is engineering while recording keeps its engineering mark. */
  let activeIndicators = $derived.by((): ThreadIndicator[] => {
    const live: ThreadIndicator[] = []
    if (isRecording) live.push('recording')
    if (isSpeaking) live.push('speaking')
    if (isTranscribing) {
      live.push(
        voiceSendStage === 'steer'
          ? 'transcribing-steer'
          : voiceSendStage === 'send'
            ? 'transcribing-send'
            : 'transcribing'
      )
    }
    if (isUsingComputerUse) live.push('computer-use')
    if (browserAudioAt !== null) live.push('browser-audio')
    if (thread.engineering === true) live.push('engineering')
    return live
  })

  /**
   * Sending clears the draft, which would otherwise flash the badge back to the
   * thread's stale status before the harness confirms the working state. Hold
   * the todo dot for a short grace after the draft clears so the transition
   * reads as draft → (briefly todo) → working instead of draft → default.
   */
  let holdingDraft = $state(false)

  function holdDraftDot(): void {
    holdingDraft = true
  }

  function releaseDraftDot(): void {
    holdingDraft = false
  }

  $effect(() => {
    if (isDraft) {
      holdDraftDot()
      return
    }
    if (!holdingDraft) return
    const timer = setTimeout(releaseDraftDot, DRAFT_GRACE_MS)
    return () => clearTimeout(timer)
  })

  let threadState = $derived.by((): ThreadState => {
    // A settled thread the user has not read reads as unread: an errored run
    // they never opened falls through to the unread dot below, and the Error
    // badge returns the moment it is read (see `settledThreadReadsUnread`).
    if (thread.status === 'failed' && effectiveRead) return 'error'
    if (hasQueuedMessage && thread.status !== 'awaiting_approval' && thread.status !== 'spec')
      return 'queued'
    if (thread.status === 'working-paused') return 'working-paused'
    if (thread.status === 'awaiting_approval') return 'approval'
    if (thread.status === 'spec') return 'spec'
    // An unread side chat must surface even while the parent thread itself is
    // still working: the row keeps pulsing (the busy indicator is independent
    // of the badge) but shows the unread dot instead of swallowing it.
    // Last action wins between the side chat and the parent thread's own turn:
    // a primary turn that settled after the side chat landed keeps the green
    // unread dot, and otherwise the side-chat unread keeps that same dot under
    // its own state. The marker that says "side chat" is the row's dashed glyph,
    // so no colour has to carry that meaning. Opening the thread reads the
    // primary turn but leaves the side chat unread, so the dot returns and stays
    // until the side-chat panel is focused (or the chat expires or is closed).
    if (hasTemporaryChatUnread) {
      if (!effectiveRead && primarySettledAt > temporaryChatUnreadAt) return 'unread'
      return 'temporary-unread'
    }
    // A scheduled message (queued behind other threads) reads as pending work
    // and shows the timer badge   it is a draft in the sorting/pinning sense but
    // not something still being typed.
    if (hasStartAfterPending) return 'scheduled'
    // Drafting (or the brief post-send grace) shows the todo dot.
    if (holdingDraft) return 'todo'
    if (isDraft) return 'todo'
    if (isWorking) return 'working'
    // The confirmed terminal state wins over the busy flag so a finished turn
    // flips straight to done/unread instead of lingering on the spinner.
    if (!effectiveRead) return 'unread'
    if (thread.status === 'completed') return 'completed'
    if (isBusyIndicator) return 'working'
    if (thread.status === 'created') return 'todo'
    return 'read'
  })

  /** The word a state that wants the user shows in the detailed row's end slot,
   *  or null when the state is quiet. Four states want them: parked on the user
   *  (approval), a failed run they have read, a spec ready for review, and a run
   *  paused on a retry. Every other state keeps its age. */
  let stateWord = $derived.by((): { label: string; color: string } | null => {
    switch (threadState) {
      case 'approval':
        return { label: 'Your call', color: 'var(--color-warning)' }
      case 'error':
        return { label: 'Failed', color: 'var(--color-danger)' }
      case 'spec':
        return { label: 'Spec ready', color: 'var(--color-thread-spec)' }
      case 'working-paused':
        return { label: 'Retrying', color: 'var(--color-warning)' }
      default:
        return null
    }
  })

  /** The row's state rail: a mark down the left edge of the whole row.
   *
   *  Every value `threadState` can take gets a shape, not only a hue, so the
   *  state survives for a reader who cannot tell the greens and violets apart:
   *  solid for a live or settled state, dashed for one that is waiting, dotted
   *  for one queued behind another. Width carries the two states that want the
   *  user, so approval and error are findable from across the sidebar.
   *
   *  Read and completed draw the same quiet hairline. They are one settled state
   *  to the eye, and the distinction that matters is carried by the title, the
   *  tooltip and the accessible name instead of by two nearly identical rings. */
  /** The action mark riding this row's rail, if any.
   *
   *  A draft, a queued message and a start-after are not states: they are things
   *  waiting on the thread. They ride the rail as a mark rather than replacing
   *  what the thread is doing, so a thread that is working with a draft waiting
   *  shows the pen and its rail still says working. */
  let pendingAction = $derived.by((): ThreadStateMark | null => {
    if (hasQueuedMessage) return threadActionMark('queued')
    if (hasStartAfterPending) return threadActionMark('scheduled')
    if (holdingDraft) return threadActionMark('todo')
    return null
  })

  /** The glyph the rail carries, and the name it answers to. The action rides on
   *  top of the state; with no action, the state speaks for itself. */
  let spineMark = $derived.by((): ThreadStateMark => pendingAction ?? threadStateMark(threadState))

  /** The rail's paint: the state's own colour, and its dash pattern. The rail is
   *  the same width as the glyph above it, so the mark reads as one column. */
  let spineRailPaint = $derived.by((): string => {
    if (spineMark.dash === 'solid') return spineMark.colour
    const stripe = spineMark.dash === 'dashed' ? ['0.25rem', '0.4375rem'] : ['0.125rem', '0.25rem']
    return `repeating-linear-gradient(to bottom, ${spineMark.colour} 0 ${stripe[0]}, transparent ${stripe[0]} ${stripe[1]})`
  })

  /** The row's own ground, when the state wants the user. A tint is the second
   *  carrier beside the rail, so approval and error are findable from across the
   *  sidebar. It is written as an inline style, the same way the scope chip draws
   *  its mixed border, rather than as an arbitrary utility class: this keeps the
   *  colour honest against the theme tokens and adds no class the build has to
   *  discover. It never pulses. */
  let rowTintStyle = $derived(
    threadState === 'approval'
      ? 'background: color-mix(in srgb, var(--color-warning) 8%, transparent);'
      : threadState === 'error'
        ? 'background: color-mix(in srgb, var(--color-danger) 8%, transparent);'
        : ''
  )

  /** Title colour, shared by every row layout. */
  let titleClass = $derived(
    threadState === 'approval'
      ? 'font-medium text-warning'
      : threadState === 'unread' || threadState === 'temporary-unread'
        ? 'font-medium text-foreground'
        : 'text-foreground'
  )

  /** Row padding and line rhythm. The detailed row keeps its own lines tight
   *  and spends its space between rows instead, so consecutive entries read as
   *  separate cards rather than one tall block. Its left padding also clears the
   *  state rail, which runs the full height of the row. */
  let rowLayoutClass = $derived(
    detailed
      ? 'gap-1 py-1.5 pl-[1.625rem] pr-2.5 mb-3 relative'
      : compact
        ? 'gap-1 px-2 py-1 mb-1'
        : 'gap-1 px-2 py-1.5 mb-1'
  )

  /** Human-readable stage label, only meaningful when isWorking is true. */
  let stageLabel = $derived.by((): string => {
    switch (thread.status) {
      case 'planning':
        return 'Planning'
      case 'executing':
        return 'Working'
      case 'working-paused':
        return threadStatusPolicy(thread.status).label
      default:
        return delegatedWorkActive ? 'Coordinating delegated work' : ''
    }
  })

  let scopeBucket = $derived(threadScopeBucket(thread))

  /** Whether the scope chip shows at all. The detailed row draws it on its
   *  context line, beside the project name; the one/two-line row keeps it on its
   *  footer. `hideScope` is the caller saying the surrounding view is already
   *  scoped. */
  let scopeVisible = $derived(scopeBucket !== null && !hideScope)

  /** Whether the thread runs on an Oven rather than this computer. */
  let isRemote = $derived(
    Boolean(thread.settings?.ovenId && thread.settings.ovenId !== LOCAL_OVEN_ID)
  )

  /** Oven the thread runs on, resolved for its mark. Its name lives on the
   *  hover card, so a row only carries the box icon. */
  let oven = $derived(isRemote ? ovens.identity(thread.settings?.ovenId) : null)

  /** Git branch the thread's checkout is on, when main resolved one. */
  let branch = $derived(thread.branch?.trim() || null)

  /** The branch as the row shows it: four characters, full name on the popover. */
  let branchLabel = $derived(branch ? threadBranchRowLabel(branch) : null)

  $effect(() => {
    if (isRemote) void ovens.ensure()
  })

  /** The authored-work session this thread is in, or null when it is in none.
   *  Drawn from the persisted thread field: main writes it the moment the thread
   *  enters a session and pushes the row over `thread:updated`, so no scan and no
   *  per-row round trip stands behind the marker. */
  let authoredWorkKind = $derived(thread.authoredWorkKind ?? null)

  let hasNote = $derived(threadNotesState.has(thread.id))

  /** Whether the bottom line (harnesses, scope, branch, time) is shown. A remote
   *  thread always shows it: the Oven and the branch belong on every row of it,
   *  and a temporary chat's mark lives on that line. */
  let showBottomRow = $derived(
    authoredWorkKind !== null ||
      scopeBucket !== null ||
      harnessIds.length > 1 ||
      hasNote ||
      hasTemporaryChat ||
      isRemote ||
      branch !== null
  )

  /** The detailed row's own context line, shown only when it has something to
   *  carry: a project icon, a project name, or the scope chip. A project's own
   *  thread list hides the name and brings no icon, but it still shows the scope,
   *  so the line must survive on the scope alone or the chip would be lost. */
  let showProjectLine = $derived(
    Boolean(projectIconUrl || projectIconGlyph || (projectName && !hideProjectName) || scopeVisible)
  )

  /** Whether the detailed row has anything for its meta line besides the
   *  last-edited time: what the thread ran with, where it ran, the branch and
   *  every marker it carries. With none of those, the time rides on the primary
   *  line and the row stays two lines tall. The scope is not counted here: it
   *  lives on the context line above, so a thread whose only extra is a scope
   *  does not open a meta line just to fill it. */
  let hasRowExtras = $derived(
    harnessIds.length > 0 ||
      branch !== null ||
      isRemote ||
      hasNote ||
      hasTemporaryChat ||
      authoredWorkKind !== null
  )

  let scopeColor = $derived(
    scopeBucket ? (scopeBucket.color ?? pickColorForSeed(scopeBucket.id)) : ''
  )

  let scopeIconUrl = $derived.by((): string | null => {
    if (!scopeBucket) return null
    if (scopeBucket.iconType) return getIconSvgDataUrl(scopeBucket.iconType, scopeColor)
    if (scopeBucket.color) return generateInitialsIconSvg(scopeBucket.name, scopeColor)
    return null
  })

  /** Status remains visible for pinned threads; hover temporarily reveals the pin action. */
  let pinVisible = $derived(hovered)

  /** Tooltip for the state badge: the only place a collapsed row can explain
   *  itself, since the badge is a bare dot or spinner. */
  let badgeTitle = $derived.by((): string => {
    if (threadState === 'queued')
      return isWorking ? 'Working · Queued' : isRetryPaused ? 'Waiting to retry · Queued' : 'Queued'
    if (isForeignRun) return 'Running in another instance'
    if (isRetryPaused || isWorking) return stageLabel
    if (thread.status === 'spec') return 'Spec ready'
    // A parked thread says what it waits for in the app's own words, and says it
    // for as long as the status holds   opening or reading the row never
    // changes it.
    if (threadState === 'approval') return threadStatusPolicy(thread.status).label
    if (threadState === 'scheduled') return 'Scheduled'
    if (threadState === 'temporary-unread') return 'Temporary chat unread'
    return threadState
  })

  /** Maps ThreadState to StatusBadge props   all colours flow through the
   *  canonical StatusBadge component so every indicator stays consistent. */
  let badgeProps = $derived.by(
    (): {
      stage?: 'todo' | 'working' | 'spec' | 'issue' | 'unread' | 'done' | 'pinned'
      tone?: 'todo' | 'working' | 'working-paused' | 'attention' | 'spec' | 'done' | 'error'
      kind?: 'completed' | 'attention' | 'error'
      variant?: 'dot' | 'spinner' | 'icon'
      icon?: Component | null
      color?: string
    } | null => {
      switch (threadState) {
        case 'unread':
          return { stage: 'unread' }
        case 'todo':
          return { stage: 'todo' }
        case 'working':
          // Work owned by another instance keeps the working colour but gets a
          // distinct, still icon: a spinner here would promise live output this
          // window never receives.
          return isForeignRun
            ? { variant: 'icon', icon: AppWindow, tone: 'working' }
            : { variant: 'spinner', stage: 'working' }
        case 'queued':
        case 'scheduled':
          return { variant: 'icon', stage: 'working', icon: Clock }
        case 'working-paused':
          return { variant: 'spinner', tone: 'working-paused' }
        case 'spec':
          return { stage: 'spec' }
        case 'approval':
          return { kind: 'attention' }
        case 'temporary-unread':
          // The same circular unread dot as a primary thread: what is waiting, not
          // which kind of thing is waiting. The row's own dashed side-chat marker
          // names the side chat, so no second colour does the talking.
          return { stage: 'unread' }
        case 'error':
          return { kind: 'error' }
        default:
          // completed / read → transparent ring
          return null
      }
    }
  )

  /** A busy row never paints a working/warning background tint and never
   *  pulses. The badge is the authority on the thread's state (spinner, clock,
   *  or another instance's icon), so selecting the thread is the only thing
   *  that changes a row's background. A tinted working row reads as "this is
   *  the open thread" at a glance when it is not, and a running pulse is a
   *  frame cost for as long as the state lasts, so both were removed on
   *  purpose. */

  // ─── Hover interactions ──────────────────────────────────────────────────

  async function revealPopover(): Promise<void> {
    if (!rowEl || showMenu || !hovered) return

    const size = resolveThreadHoverPopoverSize()
    popoverPos = calculateThreadHoverPopoverPosition(
      rowEl.getBoundingClientRect(),
      size.width,
      size.height
    )
    showPopover = true
    await tick()

    if (!rowEl || !popoverEl || showMenu || !hovered) return
    const popoverRect = popoverEl.getBoundingClientRect()
    popoverPos = calculateThreadHoverPopoverPosition(
      rowEl.getBoundingClientRect(),
      popoverRect.width,
      popoverRect.height
    )
  }

  function onRowEnter(): void {
    hovered = true
    clearTimeout(popoverTimer)
    // Warm the cache early   before the popover (550ms)   so the click path
    // into the thread is already fast by the time the user acts.
    clearTimeout(preloadTimer)
    preloadTimer = setTimeout(preloadMessages, PRELOAD_DEBOUNCE_MS)
    popoverTimer = setTimeout(() => {
      void revealPopover()
    }, 550)
  }

  function onRowLeave(): void {
    hovered = false
    clearTimeout(popoverTimer)
    clearTimeout(preloadTimer)
    showPopover = false
  }

  /**
   * Touch has no hover and no right click, so a long press stands in for both:
   * it reveals the row's ellipsis and opens the same actions menu.
   */
  function openActionsByTouch(): void {
    touchRevealed = true
    hovered = true
    showPopover = false
    clearTimeout(popoverTimer)
    showMenu = true
  }

  /** Right-click anywhere on the row opens the actions menu. */
  function openContextMenu(e: MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    showPopover = false
    clearTimeout(popoverTimer)
    showMenu = true
  }
</script>

{#snippet peekIndicator()}
  {#if browserStore()?.hasThreadPeek(thread.projectId, thread.id)}
    <span
      role="img"
      class="flex shrink-0 items-center text-accent"
      title="Peek open in this thread"
      aria-label="Peek open in this thread"><Eye size={12} /></span
    >
  {/if}
{/snippet}

{#snippet authoredWorkMarker(kind: AuthoredWorkKind | null)}
  {#if kind}
    {@const WorkIcon = AUTHORED_WORK_ICON_BY_KIND[kind]}
    <span
      class="flex shrink-0 items-center text-muted"
      title="{AUTHORED_WORK_NAME_BY_KIND[kind]} thread"
      aria-label="{AUTHORED_WORK_NAME_BY_KIND[kind]} thread"
    >
      <WorkIcon size={11} strokeWidth={1.8} aria-hidden="true" />
    </span>
  {/if}
{/snippet}

{#snippet temporaryChatMarker()}
  {#if hasTemporaryChat}
    <!-- The context sidebar's temporary-chat tab mark, carried onto the row so a
         side chat is visible from the list that spawned it. It keeps the row's
         neutral icon colour: the dashed circle is the mark, never a hue. -->
    <span
      class="flex shrink-0 items-center text-muted"
      role="img"
      aria-label={temporaryChatLabel}
      title={temporaryChatLabel}
    >
      <MessageCircleDashed size={11} strokeWidth={2} aria-hidden="true" />
    </span>
  {/if}
{/snippet}

{#snippet scopeChip(classes: string)}
  {#if scopeBucket}
    <!-- The chip is allowed to shrink: its track is the flexible one, so a
         crowded footer narrows the scope (name truncates with an ellipsis)
         rather than letting the chip run under the neighbouring marks. -->
    <span
      class="relative flex min-w-0 max-w-full items-center gap-1 overflow-hidden border-b px-1 text-[0.5625rem] text-muted {classes}"
      title={scopeBucket.name}
      style="border-bottom-color: color-mix(in srgb, {scopeColor} 30%, var(--color-muted));"
    >
      {#if scopeIconUrl}
        <img
          src={scopeIconUrl}
          alt=""
          class="h-2 w-2 shrink-0 object-contain opacity-50 grayscale"
          draggable="false"
        />
      {/if}
      {#if scopeBucket.pinned}
        <Pin size={8} class="shrink-0 text-accent" aria-hidden="true" />
      {/if}
      <span class="min-w-0 truncate">{scopeBucket.name}</span>
    </span>
  {/if}
{/snippet}

{#snippet threadStatusSlot(centered: boolean)}
  <span class="relative h-4 w-4 shrink-0">
    <span
      class="absolute inset-0 flex items-center transition-opacity duration-150 {centered
        ? 'justify-center'
        : 'justify-start'} {pinVisible ? 'opacity-0' : 'opacity-100'}"
      aria-hidden={pinVisible}
    >
      {#if badgeProps}
        <StatusBadge
          stage={badgeProps.stage}
          tone={badgeProps.tone}
          kind={badgeProps.kind}
          color={badgeProps.color}
          variant={badgeProps.variant ?? 'dot'}
          icon={badgeProps.icon}
          size="md"
          title={badgeTitle}
        />
      {:else}
        <span
          class="h-2 w-2 border border-border-strong bg-transparent"
          aria-label={threadState}
          title={threadState}
        ></span>
      {/if}
    </span>
    <span
      role="button"
      tabindex={-1}
      class="absolute inset-0 flex items-center justify-center transition-opacity duration-150 hover:bg-overlay {pinVisible
        ? 'opacity-100'
        : 'pointer-events-none opacity-0'}"
      aria-label={effectivePinned ? 'Unpin thread' : 'Pin thread'}
      aria-hidden={!pinVisible}
      title={effectivePinned ? 'Unpin' : 'Pin'}
      onclick={(e: MouseEvent) => {
        e.stopPropagation()
        onTogglePin(thread)
      }}
      onkeydown={(e: KeyboardEvent) => {
        if (keymapState.matches('thread-pin', e)) {
          e.stopPropagation()
          onTogglePin(thread)
        }
      }}
    >
      <Pin size={11} class={effectivePinned ? 'text-accent' : 'text-dimmed'} />
    </span>
  </span>
{/snippet}

{#if picker}
  <div
    class="flex min-h-11 w-full flex-col gap-1 px-2.5 py-1.5 text-left transition-colors {selected
      ? 'bg-selected'
      : ''}"
    title={displayTitle}
  >
    <span class="flex w-full min-w-0 items-center gap-2">
      {#if projectIconUrl}
        <img src={projectIconUrl} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
      {:else if projectIconGlyph}
        {@const ContainerIcon = projectIconGlyph}
        <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted">
          <ContainerIcon size={12} strokeWidth={1.8} aria-hidden="true" />
        </span>
      {/if}
      <span class="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
        {#if badgeProps}
          <StatusBadge
            stage={badgeProps.stage}
            tone={badgeProps.tone}
            kind={badgeProps.kind}
            color={badgeProps.color}
            variant={badgeProps.variant ?? 'dot'}
            icon={badgeProps.icon}
            size="md"
            title={badgeTitle}
          />
        {:else}
          <span
            class="h-2 w-2 border border-border-strong bg-transparent"
            aria-label={threadState}
            title={threadState}
          ></span>
        {/if}
      </span>
      <span
        class="min-w-0 flex-1 truncate text-[0.75rem] {threadState === 'approval'
          ? 'font-medium text-warning'
          : threadState === 'unread' || threadState === 'temporary-unread'
            ? 'font-medium text-foreground'
            : 'text-foreground'}"
      >
        {displayTitle}
      </span>
      {@render peekIndicator()}
      {#if !showBottomRow}
        {#if activeIndicators.length > 0}
          {#each activeIndicators as live (live)}
            <ThreadIndicatorSlot indicator={live} />
          {/each}
        {:else if isBusyIndicator && currentModelProviderName}
          <span class="flex shrink-0 items-center" title={thread.settings?.modelId ?? 'Model'}>
            <VendorIcon
              name={currentModelProviderName}
              id={currentModelProviderId ?? undefined}
              size={13}
            />
          </span>
        {:else}
          <span class="whitespace-nowrap text-[0.625rem] text-dimmed">
            {formatCompactAge(thread.lastActivity)}
          </span>
        {/if}
      {:else if currentModelProviderName}
        <span class="flex shrink-0 items-center" title={thread.settings?.modelId ?? 'Model'}>
          <VendorIcon
            name={currentModelProviderName}
            id={currentModelProviderId ?? undefined}
            size={13}
          />
        </span>
      {/if}
      {#if selected}
        <Check size={13} class="shrink-0 text-primary" />
      {/if}
    </span>

    {#if showBottomRow}
      <!-- Scope is the track that gives way: the harness track keeps its icons
           (`max-content` minimum) and the marks track keeps its own content, so
           a crowded row narrows the scope instead of overlapping it. -->
      <span
        class="grid w-full min-w-0 grid-cols-[minmax(max-content,1fr)_minmax(0,max-content)_minmax(max-content,1fr)] items-center gap-1.5"
      >
        {#if harnessIds.length > 0}
          <span class="col-start-1 flex min-w-0 items-center gap-1 overflow-hidden">
            {#each harnessIds.slice(0, 3) as harnessId (harnessId)}
              <AgentIcon agentId={harnessId} label={harnessName(harnessId)} size={14} />
            {/each}
            {#if harnessIds.length > 3}
              <span class="shrink-0 text-[0.625rem] tabular-nums text-dimmed">
                +{harnessIds.length - 3}
              </span>
            {/if}
          </span>
        {/if}

        {@render scopeChip('col-start-2 pb-1 pt-0.5')}

        <span class="col-start-3 flex min-w-0 items-center justify-end gap-1 overflow-hidden">
          {#if isRemote}
            <span
              class="flex h-3 w-3 shrink-0 items-center justify-center text-muted"
              title={`Oven: ${oven?.name ?? 'unknown'}`}
              aria-label={`Oven: ${oven?.name ?? 'unknown'}`}
            >
              {#if oven?.iconUrl}
                <img src={oven.iconUrl} alt="" class="h-3 w-3 object-contain" draggable="false" />
              {:else}
                <Server size={11} class="shrink-0" />
              {/if}
            </span>
          {/if}
          {#if branch}
            <span
              class="flex min-w-0 items-center gap-1 text-[0.625rem] text-muted"
              title={`Branch: ${branch}`}
            >
              <GitBranch size={10} class="shrink-0" aria-hidden="true" />
              <span>{branchLabel}</span>
            </span>
          {/if}
          {#if hasNote}
            {@const ThreadNoteIcon = feature('thread-note').icon}
            <span
              class="flex shrink-0 items-center text-warning"
              title={`${feature('thread-note').name} attached`}
            >
              <ThreadNoteIcon size={11} />
            </span>
          {/if}
          {@render authoredWorkMarker(authoredWorkKind)}
          {#each activeIndicators as live (live)}
            <ThreadIndicatorSlot indicator={live} />
          {/each}
          {#if activeIndicators.length === 0}
            <span class="whitespace-nowrap text-[0.625rem] text-dimmed">
              {formatCompactAge(thread.lastActivity)}
            </span>
          {/if}
        </span>
      </span>
    {/if}
  </div>
{/if}

<div
  {@attach captureRowElement}
  {@attach longPress({ onLongPress: openActionsByTouch, enabled: !picker })}
  class="relative {picker ? 'hidden' : ''}"
  role="listitem"
  data-thread-row={thread.id}
  aria-hidden={picker}
  draggable={!picker}
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondrop={handleDrop}
  ondragleave={handleDragLeave}
  onmouseenter={onRowEnter}
  onmouseleave={onRowLeave}
>
  <!-- Stable drop indicator   always rendered, opacity toggled to avoid layout shift -->
  <div
    class="pointer-events-none absolute left-0 right-0 top-0 h-[2px] transition-opacity duration-100 {dropIndicator ===
    'before'
      ? 'bg-primary opacity-100'
      : 'opacity-0'}"
  ></div>
  <div
    class="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] transition-opacity duration-100 {dropIndicator ===
    'after'
      ? 'bg-primary opacity-100'
      : 'opacity-0'}"
  ></div>
  <button
    class="relative flex w-full flex-col text-left transition-colors {rowLayoutClass} {selected
      ? 'bg-selected'
      : 'hover:bg-elevated'}"
    style={rowTintStyle}
    title={displayTitle}
    aria-current={selected ? 'true' : undefined}
    onpointerdown={() => preloadMessages()}
    onclick={() => {
      showPopover = false
      clearTimeout(popoverTimer)
      onOpen(thread)
    }}
    oncontextmenu={openContextMenu}
  >
    {#if detailed}
      <!-- State mark: one column holding the glyph above a rail of the same
           width. The glyph names the state and wears its colour; the rail repeats
           that colour in a line beneath it, so both are centred on one axis and
           the title's gutter stays flush and even.
           A pinned thread wears a real pin above the glyph, and something waiting
           on the thread (a draft, a queue, a start-after) takes the glyph's place. -->
      <span
        class="pointer-events-none absolute inset-y-0 left-0 flex w-[1.125rem] flex-col items-center"
        style="color: {spineMark.colour};"
      >
        {#if effectivePinned}
          <span
            class="flex h-[0.875rem] w-[0.875rem] flex-none items-center justify-center text-thread-pinned"
            role="img"
            title="Pinned"
            aria-label="Pinned"
          >
            <Pin size={14} fill="currentColor" aria-hidden="true" />
          </span>
        {/if}
        <span
          class="flex h-[0.875rem] w-[0.875rem] flex-none items-center justify-center"
          role="img"
          title={spineMark.label}
          aria-label={spineMark.label}
        >
          {#if spineMark}
            {@const SpineIcon = spineMark.icon}
            <SpineIcon size={14} strokeWidth={1.8} aria-hidden="true" />
          {/if}
        </span>
        <span
          class="mt-px min-h-[0.3125rem] w-[0.875rem] flex-1"
          style="background: {spineRailPaint};"
          aria-hidden="true"
        ></span>
      </span>
    {/if}
    <!-- Clear gradient bottom edge so a row's end is obvious even with 2-colour rows -->
    <span
      class="pointer-events-none absolute inset-x-0 bottom-0 h-px"
      aria-hidden="true"
      style="background: linear-gradient(to right, transparent, var(--color-border-strong), transparent);"
    ></span>
    {#if !detailed}
      <!-- One/two-line row: every view except the Threads list and a project's
           own thread list -->
      <span class="flex w-full min-w-0 items-center gap-2">
        <!-- Project icon -->
        {#if projectIconUrl}
          <img src={projectIconUrl} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
        {:else if projectIconGlyph}
          {@const ContainerIcon = projectIconGlyph}
          <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted">
            <ContainerIcon size={12} strokeWidth={1.8} aria-hidden="true" />
          </span>
        {/if}

        <!-- State indicator / pin toggle   fixed slot, opacity crossfade, zero layout shift -->
        {@render threadStatusSlot(Boolean(projectIconUrl || projectIconGlyph))}

        <!-- Title -->
        <span class="min-w-0 flex-1 truncate text-[0.75rem] {titleClass}">
          {displayTitle}
        </span>
        {@render peekIndicator()}

        <!-- Single-line default: time rides on the top line, swapped for the
           working model's provider icon while the thread is working -->
        {#if !showBottomRow}
          {#if activeIndicators.length > 0}
            {#each activeIndicators as live (live)}
              <ThreadIndicatorSlot indicator={live} />
            {/each}
          {:else if isBusyIndicator && currentModelProviderName}
            <span
              class="flex shrink-0 items-center transition-opacity duration-150 {hovered
                ? 'opacity-0'
                : 'opacity-100'}"
              aria-hidden={hovered}
              title={thread.settings?.modelId ?? 'Model'}
            >
              <VendorIcon
                name={currentModelProviderName}
                id={currentModelProviderId ?? undefined}
                size={13}
              />
            </span>
          {:else}
            <span
              class="whitespace-nowrap text-[0.625rem] text-dimmed transition-opacity duration-150 {hovered
                ? 'opacity-0'
                : 'opacity-100'}"
              aria-hidden={hovered}
            >
              {formatCompactAge(thread.lastActivity)}
            </span>
          {/if}
        {:else}
          <!-- Current working / last worked model   provider icon alone -->
          {#if currentModelProviderName}
            <span
              class="flex shrink-0 items-center transition-opacity duration-150 {hovered
                ? 'opacity-0'
                : 'opacity-100'}"
              aria-hidden={hovered}
              title={thread.settings?.modelId ?? 'Model'}
            >
              <VendorIcon
                name={currentModelProviderName}
                id={currentModelProviderId ?? undefined}
                size={13}
              />
            </span>
          {/if}
        {/if}
      </span>

      {#if showBottomRow}
        <!-- Bottom line: harnesses (left), scope (center), time (right) -->
        <span
          class="grid w-full min-w-0 items-center gap-3 {harnessIds.length > 0
            ? 'grid-cols-[minmax(3.2rem,1fr)_minmax(0,max-content)_minmax(max-content,1fr)]'
            : 'grid-cols-[minmax(0,1fr)_minmax(0,max-content)_minmax(max-content,1fr)]'}"
        >
          {#if harnessIds.length > 0}
            <span
              {@attach captureHarnessRowElement}
              class="col-start-1 flex min-w-0 items-center gap-1 overflow-hidden"
            >
              {#each harnessIds.slice(0, visibleHarnessCount) as harnessId (harnessId)}
                <AgentIcon agentId={harnessId} label={harnessName(harnessId)} size={14} />
              {/each}
              {#if visibleHarnessCount < harnessIds.length}
                <span class="shrink-0 text-[0.625rem] tabular-nums text-dimmed">
                  +{harnessIds.length - visibleHarnessCount}
                </span>
              {/if}
            </span>
          {/if}

          {#if !hideScope}
            {@render scopeChip('col-start-2 max-w-[7rem] pb-1 pt-0.5')}
          {/if}

          <span class="col-start-3 flex min-w-0 items-center justify-end gap-1 overflow-hidden">
            {#if isRemote}
              <span
                class="flex h-3 w-3 shrink-0 items-center justify-center text-muted"
                title={`Oven: ${oven?.name ?? 'unknown'}`}
                aria-label={`Oven: ${oven?.name ?? 'unknown'}`}
              >
                {#if oven?.iconUrl}
                  <img src={oven.iconUrl} alt="" class="h-3 w-3 object-contain" draggable="false" />
                {:else}
                  <Server size={11} class="shrink-0" />
                {/if}
              </span>
            {/if}
            {#if branch}
              <span
                class="flex min-w-0 items-center gap-1 text-[0.625rem] text-muted"
                title={`Branch: ${branch}`}
              >
                <GitBranch size={10} class="shrink-0" aria-hidden="true" />
                <span>{branchLabel}</span>
              </span>
            {/if}
            {#if hasNote}
              {@const ThreadNoteIcon = feature('thread-note').icon}
              <span
                class="flex shrink-0 items-center text-warning"
                title={`${feature('thread-note').name} attached`}
              >
                <ThreadNoteIcon size={11} />
              </span>
            {/if}
            {@render temporaryChatMarker()}
            {@render authoredWorkMarker(authoredWorkKind)}
            {#each activeIndicators as live (live)}
              <ThreadIndicatorSlot indicator={live} />
            {/each}
            {#if activeIndicators.length === 0}
              <span
                class="whitespace-nowrap text-[0.625rem] text-dimmed transition-opacity duration-150 {hovered
                  ? 'opacity-0'
                  : 'opacity-100'}"
                aria-hidden={hovered}
              >
                {formatCompactAge(thread.lastActivity)}
              </span>
            {/if}
          </span>
        </span>
      {/if}
    {:else}
      {#if showProjectLine}
        <!-- Context line: which project the thread belongs to, and which slice of
             it this thread works on. The project mark, the project name and the
             scope all answer that one question, so they share this line, exactly
             as the project mark and the project name already did. A project's own
             thread list skips the name, since the folder above already names it. -->
        <span class="flex w-full min-w-0 items-center gap-2">
          <span class="flex h-4 w-4 shrink-0 items-center justify-center">
            {#if projectIconUrl}
              <img src={projectIconUrl} alt="" class="h-3.5 w-3.5 object-contain" />
            {:else if projectIconGlyph}
              {@const ContainerIcon = projectIconGlyph}
              <ContainerIcon size={12} strokeWidth={1.8} class="text-muted" aria-hidden="true" />
            {/if}
          </span>
          {#if projectName && !hideProjectName}
            <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-muted" title={projectName}
              >{projectName}</span
            >
          {/if}
          {#if scopeVisible}
            <!-- The scope gives way: the project name truncates first and the
                 scope chip narrows rather than pushing a neighbour off the line. -->
            {@render scopeChip('min-w-0 shrink max-w-[8rem]')}
          {/if}
        </span>
      {/if}

      <!-- Primary line: the title, and the end slot. The rail down the left edge
           carries the state, so this line spends its width on one thing: every
           live action the thread has, else the word for a state that wants the
           user, else the age. Pinning is not here: the row's context menu and
           the pin keymap already do it, so the line keeps no reserved space. -->
      <span class="flex w-full min-w-0 items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-[0.75rem] {titleClass}">{displayTitle}</span>
        {@render peekIndicator()}
        {#if activeIndicators.length > 0}
          <!-- Every live action the thread has, not only the loudest one. A thread
               can be recording while a browser tab of its own plays sound, and
               the row must be able to say both at once. -->
          {#each activeIndicators as live (live)}
            <span class="flex shrink-0 items-center">
              <ThreadIndicatorSlot indicator={live} />
            </span>
          {/each}
        {:else if stateWord}
          <!-- A state that wants the user says so in a word. The hue fills the
               stamp; the letters stay in the foreground colour, so contrast
               never depends on an amber or a violet passing AA. -->
          <span
            class="flex shrink-0 items-center border-l-2 bg-elevated py-0.5 pl-1 pr-1.5 text-[0.5625rem] font-bold uppercase tracking-[0.08em] text-foreground"
            style="border-left-color: {stateWord.color};"
          >
            {stateWord.label}
          </span>
        {:else if currentModelProviderName}
          <!-- The mark of the model that ran this thread. It sits here whenever
               nothing louder owns the slot, and the age has the meta line below,
               so both are on the row at once instead of one displacing the
               other. -->
          <span
            class="flex shrink-0 items-center transition-opacity duration-150 {hovered
              ? 'opacity-0'
              : 'opacity-100'}"
            aria-hidden={hovered}
            title={thread.settings?.modelId ?? 'Model'}
          >
            <VendorIcon
              name={currentModelProviderName}
              id={currentModelProviderId ?? undefined}
              size={13}
            />
          </span>
        {:else if !hasRowExtras}
          <span
            class="shrink-0 whitespace-nowrap text-[0.625rem] tabular-nums text-muted transition-opacity duration-150 {hovered
              ? 'opacity-0'
              : 'opacity-100'}"
            aria-hidden={hovered}
            title={`Edited ${formatDateTime(thread.lastActivity)}`}
            >{formatCompactAge(thread.lastActivity)}</span
          >
        {/if}
      </span>

      {#if hasRowExtras}
        <!-- Footer line: what the thread runs with on the left, then where it
             runs, its branch, every marker it carries and its last-edited time
             on the right. Both tracks reserve their own content width
             (`max-content` minimum), so neither the harness icons nor the marks
             can be squeezed or overlapped. The scope is no longer here: it moved
             up to the context line, where it belongs with the project name. -->
        <span
          class="grid w-full min-w-0 grid-cols-[minmax(max-content,1fr)_minmax(max-content,1fr)] items-center gap-2 overflow-hidden"
        >
          {#if harnessIds.length > 0}
            <span class="col-start-1 flex min-w-0 items-center gap-1 overflow-hidden">
              {#each harnessIds.slice(0, MAX_HARNESS_ICONS) as harnessId (harnessId)}
                <AgentIcon agentId={harnessId} label={harnessName(harnessId)} size={14} />
              {/each}
              {#if harnessIds.length > MAX_HARNESS_ICONS}
                <span class="shrink-0 text-[0.625rem] tabular-nums text-dimmed"
                  >+{harnessIds.length - MAX_HARNESS_ICONS}</span
                >
              {/if}
            </span>
          {/if}
          <span class="col-start-2 flex min-w-0 items-center justify-end gap-1.5 overflow-hidden">
            <!-- Where it runs, and the branch it runs on: both always, so a
                 branch never disappears just because the row also has a scope. -->
            <span
              class="flex h-3 w-3 shrink-0 items-center justify-center text-muted"
              title={isRemote ? `Oven: ${oven?.name ?? 'unknown'}` : 'Runs on this computer'}
              aria-label={isRemote ? `Oven: ${oven?.name ?? 'unknown'}` : 'Runs on this computer'}
            >
              {#if isRemote}
                {#if oven?.iconUrl}
                  <img src={oven.iconUrl} alt="" class="h-3 w-3 object-contain" draggable="false" />
                {:else}
                  <Server size={11} class="shrink-0" />
                {/if}
              {:else}
                <Monitor size={10} class="shrink-0" aria-hidden="true" />
              {/if}
            </span>
            {#if branch}
              <span
                class="flex min-w-0 items-center gap-0.5 text-[0.625rem] text-muted"
                title={`Branch: ${branch}`}
              >
                <GitBranch size={10} class="shrink-0" aria-hidden="true" />
                <span class="truncate">{branchLabel}</span>
              </span>
            {/if}
            {#if hasNote}
              {@const ThreadNoteIcon = feature('thread-note').icon}
              <span
                class="flex shrink-0 items-center text-warning"
                title={`${feature('thread-note').name} attached`}
              >
                <ThreadNoteIcon size={11} />
              </span>
            {/if}
            {@render temporaryChatMarker()}
            {@render authoredWorkMarker(authoredWorkKind)}
            <span
              class="shrink-0 whitespace-nowrap text-[0.625rem] tabular-nums text-muted"
              title={`Edited ${formatDateTime(thread.lastActivity)}`}
              >{formatCompactAge(thread.lastActivity)}</span
            >
          </span>
        </span>
      {/if}
    {/if}

    <!-- Ellipsis   far right, vertically centered across the whole row, shown on hover -->
    <span
      class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center transition-opacity duration-150 {hovered
        ? 'opacity-100'
        : 'pointer-events-none opacity-0'}"
      aria-hidden={!hovered}
    >
      <ThreadDropdown
        bind:open={showMenu}
        items={actionsMenu.items}
        vertical={compact ? showBottomRow : true}
        onOpen={() => {
          showPopover = false
          clearTimeout(popoverTimer)
        }}
        onClose={() => {
          if (!touchRevealed) return
          touchRevealed = false
          hovered = false
        }}
      />
    </span>
  </button>

  <!-- Hover popover with thread info -->
  {#if showPopover}
    <Portal>
      <div
        {@attach capturePopoverElement}
        class={THREAD_HOVER_POPOVER_SURFACE_CLASS}
        style={threadHoverPopoverStyle(popoverPos.x, popoverPos.y)}
      >
        <ThreadHoverPopover
          {thread}
          {isWorking}
          {isRetryPaused}
          {stageLabel}
          threadState={threadState === 'queued'
            ? hasStartAfterPending
              ? 'scheduled'
              : 'working'
            : threadState}
          {isForeignRun}
        />
      </div>
    </Portal>
  {/if}
</div>

{#if actionsMenu.renameError}
  <div class="fixed bottom-4 right-4 z-60 bg-danger px-4 py-2 text-sm text-white shadow-lg">
    {actionsMenu.renameError}
  </div>
{/if}

<Modal open={actionsMenu.showRenameModal} title="Rename Thread" onClose={actionsMenu.cancelRename}>
  <form
    id={renameThreadFormId}
    class="space-y-4"
    onsubmit={(e: SubmitEvent) => {
      e.preventDefault()
      void actionsMenu.confirmRename()
    }}
  >
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="thread-rename-input"
        >Title</label
      >
      <input
        id="thread-rename-input"
        type="text"
        class="w-full border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        bind:value={actionsMenu.renameValue}
        oninput={() => onRenameInputChange?.(thread)}
      />
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      onclick={actionsMenu.cancelRename}
    >
      Cancel
    </button>
    <button
      type="submit"
      form={renameThreadFormId}
      class="bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
      disabled={!actionsMenu.renameValue.trim()}
    >
      Save
    </button>
  {/snippet}
</Modal>

<ThreadDeleteConfirm
  open={actionsMenu.showDeleteModal}
  threadTitle={thread.title}
  onClose={actionsMenu.cancelDelete}
  onConfirm={actionsMenu.confirmDelete}
/>

{#if actionsMenu.showChangeScopeModal && !picker}
  <ChangeScopeModal
    open={actionsMenu.showChangeScopeModal}
    onClose={actionsMenu.cancelChangeScope}
    threadId={thread.id}
    projectId={thread.projectId}
    currentBucketId={thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID}
  />
{/if}
