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
  import { resolveThreadIndicator } from '$lib/components/threads/thread-indicator'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ThreadDeleteConfirm from '$lib/components/ui/ThreadDeleteConfirm.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { longPress } from '$lib/long-press.svelte'
  import { pickColorForSeed } from '$lib/project-colors'
  import { generateInitialsIconSvg, getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { speechController } from '$lib/speech/speech-controller.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
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
      'position:absolute;top:-1000px;left:-1000px;padding:3px 8px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:6px;font-size:13px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
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
   */
  let indicator = $derived.by((): ThreadIndicator | null => {
    const candidates: Array<{ indicator: ThreadIndicator; at: number }> = []
    const speechAt = speechController.threadIndicatorActionAt(thread.id) ?? 0
    if (isRecording) candidates.push({ indicator: 'recording', at: speechAt })
    if (isSpeaking) candidates.push({ indicator: 'speaking', at: speechAt })
    if (isTranscribing) {
      candidates.push({
        indicator:
          voiceSendStage === 'steer'
            ? 'transcribing-steer'
            : voiceSendStage === 'send'
              ? 'transcribing-send'
              : 'transcribing',
        at: speechAt
      })
    }
    if (isUsingComputerUse) {
      candidates.push({ indicator: 'computer-use', at: pipState.threadActivityAt(thread.id) })
    }
    return resolveThreadIndicator(candidates)
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
    if (thread.status === 'failed') return 'error'
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
    // unread dot; otherwise the side-chat unread shows in the working colour
    // (the temporary-chat icon colour) so it never masquerades as an unread
    // primary thread. Opening the thread reads the primary turn but leaves the
    // side chat unread, so the working-coloured dot returns and stays until the
    // side-chat panel is focused (or the chat expires or is closed).
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
   *  separate cards rather than one tall block. */
  let rowLayoutClass = $derived(
    detailed
      ? 'gap-1 px-2.5 py-1.5 mb-3'
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

  /** The detailed row's own project line, shown only when it has an icon or a
   *  name to carry. A project's own thread list hides the name and passes no
   *  icon, so that list skips the line and its rows stay two lines tall. */
  let showProjectLine = $derived(
    Boolean(projectIconUrl || projectIconGlyph || (projectName && !hideProjectName))
  )

  /** Whether the detailed row has anything for its footer line besides the
   *  last-edited time. With nothing else to show, the time rides on the primary
   *  line and the row stays a single line. When the project line is shown it
   *  carries the Oven/branch marks instead, so they no longer count here. */
  let hasRowExtras = $derived(
    harnessIds.length > 0 ||
      (scopeBucket !== null && !hideScope) ||
      (!showProjectLine && (branch !== null || isRemote)) ||
      hasNote ||
      hasTemporaryChat ||
      authoredWorkKind !== null ||
      indicator !== null
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
      animated?: boolean
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
          return { kind: 'attention', animated: true }
        case 'temporary-unread':
          // Same circular dot as the primary unread badge but in the working
          // colour (the temporary-chat tab icon colour) so the user reads it
          // as "side chat waiting", not as an unread primary thread.
          return { stage: 'unread', color: 'var(--color-thread-working)' }
        case 'error':
          return { kind: 'error' }
        default:
          // completed / read → transparent ring
          return null
      }
    }
  )

  /** A busy row's own pulse is the fallback animation for a state whose badge
   *  cannot animate itself: a queued thread shows a static clock, so the row
   *  pulses. When the badge already spins (the local working spinner) the pulse
   *  adds nothing, and animating a whole row subtree is the expensive part. */
  let rowPulses = $derived(badgeProps?.variant !== 'spinner')

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
         side chat is visible from the list that spawned it. -->
    <span
      class="flex shrink-0 items-center text-info"
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
    <span
      class="relative flex min-w-0 items-center gap-1 border-b px-1 text-[0.5625rem] text-muted {classes}"
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
      <span class="truncate">{scopeBucket.name}</span>
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
          animated={badgeProps.animated}
          size="md"
          title={badgeTitle}
        />
      {:else}
        <span
          class="h-2 w-2 rounded-full border border-border-strong bg-transparent"
          aria-label={threadState}
          title={threadState}
        ></span>
      {/if}
    </span>
    <span
      role="button"
      tabindex={-1}
      class="absolute inset-0 flex items-center justify-center rounded transition-opacity duration-150 hover:bg-overlay {pinVisible
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
      : isBusyIndicator
        ? isRetryPaused
          ? 'bg-warning/5'
          : 'bg-thread-working/5'
        : ''}"
    title={displayTitle}
  >
    <span class="flex w-full min-w-0 items-center gap-2">
      {#if projectIconUrl}
        <img src={projectIconUrl} alt="" class="h-3.5 w-3.5 shrink-0 rounded object-contain" />
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
            animated={badgeProps.animated}
            size="md"
            title={badgeTitle}
          />
        {:else}
          <span
            class="h-2 w-2 rounded-full border border-border-strong bg-transparent"
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
      {#if !showBottomRow}
        {#if indicator}
          <ThreadIndicatorSlot {indicator} />
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
      <span
        class="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5"
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
          {#if indicator}
            <ThreadIndicatorSlot {indicator} />
          {:else}
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
      : isBusyIndicator
        ? isRetryPaused
          ? 'bg-warning/5 hover:bg-elevated'
          : isForeignRun
            ? 'bg-thread-working/5 hover:bg-elevated'
            : `${rowPulses ? 'animate-pulse ' : ''}bg-thread-working/5 hover:bg-elevated`
        : 'hover:bg-elevated'}"
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
          <img src={projectIconUrl} alt="" class="h-3.5 w-3.5 shrink-0 rounded object-contain" />
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

        <!-- Single-line default: time rides on the top line, swapped for the
           working model's provider icon while the thread is working -->
        {#if !showBottomRow}
          {#if indicator}
            <ThreadIndicatorSlot {indicator} />
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
            ? 'grid-cols-[minmax(3.2rem,1fr)_auto_minmax(0,1fr)]'
            : 'grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'}"
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
            {#if indicator}
              <ThreadIndicatorSlot {indicator} />
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
          </span>
        </span>
      {/if}
    {:else}
      {#if showProjectLine}
        <!-- Project line: which project the thread belongs to. A project's own
             thread list skips it, since the folder above already names it. -->
        <span class="flex w-full min-w-0 items-center gap-2">
          {#if projectIconUrl || projectIconGlyph}
            <span class="flex h-4 w-4 shrink-0 items-center justify-center">
              {#if projectIconUrl}
                <img src={projectIconUrl} alt="" class="h-3.5 w-3.5 rounded object-contain" />
              {:else if projectIconGlyph}
                {@const ContainerIcon = projectIconGlyph}
                <ContainerIcon size={12} strokeWidth={1.8} class="text-muted" aria-hidden="true" />
              {/if}
            </span>
          {/if}
          {#if projectName && !hideProjectName}
            <span class="min-w-0 truncate text-[0.6875rem] text-muted" title={projectName}
              >{projectName}</span
            >
          {/if}
          <!-- Where it runs and its branch ride on this line: the project line
               has the room the footer does not. -->
          <span class="ml-auto flex shrink-0 items-center justify-end gap-1.5">
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
          </span>
        </span>
      {/if}

      <!-- Primary line: status, title, current provider, and the time when there
           is no footer line to carry it -->
      <span class="flex w-full min-w-0 items-center gap-2">
        {@render threadStatusSlot(true)}
        <span class="min-w-0 flex-1 truncate text-[0.75rem] {titleClass}">{displayTitle}</span>
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
        {#if !hasRowExtras}
          <span
            class="shrink-0 whitespace-nowrap text-[0.625rem] tabular-nums text-dimmed transition-opacity duration-150 {hovered
              ? 'opacity-0'
              : 'opacity-100'}"
            aria-hidden={hovered}
            title={`Edited ${formatDateTime(thread.lastActivity)}`}
            >{formatCompactAge(thread.lastActivity)}</span
          >
        {/if}
      </span>

      {#if hasRowExtras}
        <!-- Footer line: what the thread runs with on the left, the scope in
             the middle, then where it runs, its branch, its markers and its
             last-edited time on the right. The middle column is a fixed track
             (not a flex item), so the scope sits at the row's true centre. -->
        <span
          class="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 overflow-hidden"
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
          {#if !hideScope}
            {@render scopeChip('col-start-2 max-w-[8rem]')}
          {/if}
          <span class="col-start-3 flex min-w-0 items-center justify-end gap-1.5 overflow-hidden">
            {#if !showProjectLine}
              <span
                class="flex h-3 w-3 shrink-0 items-center justify-center text-muted"
                title={isRemote ? `Oven: ${oven?.name ?? 'unknown'}` : 'Runs on this computer'}
                aria-label={isRemote ? `Oven: ${oven?.name ?? 'unknown'}` : 'Runs on this computer'}
              >
                {#if isRemote}
                  {#if oven?.iconUrl}
                    <img
                      src={oven.iconUrl}
                      alt=""
                      class="h-3 w-3 object-contain"
                      draggable="false"
                    />
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
            {#if indicator}
              <ThreadIndicatorSlot {indicator} />
            {/if}
            <span
              class="shrink-0 whitespace-nowrap text-[0.625rem] tabular-nums text-dimmed"
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
  <div
    class="fixed bottom-4 right-4 z-60 rounded-lg bg-danger px-4 py-2 text-sm text-white shadow-lg"
  >
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
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        bind:value={actionsMenu.renameValue}
        oninput={() => onRenameInputChange?.(thread)}
      />
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      onclick={actionsMenu.cancelRename}
    >
      Cancel
    </button>
    <button
      type="submit"
      form={renameThreadFormId}
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
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
