import { subagentStatusIsTerminal } from '$lib/subagent-presentation'
import { layoutPanelState } from '$lib/stores/layout-panel.svelte'
import CioNetwork from '@pdslng/cio-icon/CioNetwork.svelte'
import CioShieldCheck from '@pdslng/cio-icon/CioShieldCheck.svelte'
import CioTarget from '@pdslng/cio-icon/CioTarget.svelte'
import CioMonogram from '$lib/components/icons/cio/CioMonogram.svelte'
import { onDestroy, onMount, tick } from 'svelte'
import { onVoiceComposerReset } from '../../../speech/voice-send'
import { findNavState } from '$lib/stores/find-nav.svelte'
import { appQuitState } from '$lib/stores/app-quit.svelte'
import { isImageMime, isVideoMime, isAudioMime } from '$lib/mime'
import { mayReanchorToLatest } from '$lib/scroll-anchor'
import { actionContext } from '$lib/stores/action-context.svelte'
import { invoke, subscribe, subscribeGuarded } from '$lib/ipc.svelte'
import { scheduleDeferredWork } from '$lib/deferred-work'
import { chatDraft } from '$lib/stores/chat-draft'
import { loadLifecycleIntent, loadIndependentAuditIntent } from '$lib/stores/lifecycle-intent'
import { onEngineeringLifecycleInherited } from '$lib/thread-settings-inheritance'
import { modelRuntime } from '$lib/stores/model-runtime.svelte'
import { workspaceState, type HistoryMessageActions } from '$lib/stores/workspace.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import {
  coordinatorDockState,
  ORCHESTRATION_COORDINATOR_COMPONENTS
} from '$lib/stores/coordinator-dock.svelte'
import { orchestrationCoordinatorState } from '$lib/stores/orchestration-coordinator.svelte'
import { publishDraftActivity, onRemoteDraftCleared } from '$lib/stores/renderer-recovery.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { queuedMessageDispatcher } from '$lib/stores/queued-message-dispatcher'
import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { sectionNavigationState } from '$lib/stores/section-navigation.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { WORKING_TRACE_PAGE_SIZE } from '$shared/types'
import type { Thread, AgentEvent, RemoteAgentEventPayload } from '$shared/types'
import { releaseAnnotationHighlights } from '$lib/selection-anchors'
import { registerSelectionAnnotationClaim, trackLiveSelection } from '$lib/selection-menu'
import { captureResponseSelection, RESPONSE_HIGHLIGHT_NAME } from '../thread-response-ranges'
import { messageText, tracePreviewByUserMessage } from '../thread-message-presentation'
import { mergedUserMessageSummaries } from '../thread-history'
import { threadScrollPositions } from '../thread-scroll-memory'
import type { ThreadView } from './ThreadView-board.svelte'
import type { ActionDefinition } from '$lib/actions'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewEffects extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }

  /**
   * The header's actions, built by the surface because a row carries the snippet
   * that draws it; the surface hands the provider over once.
   */
  private activeActionsProvider: () => ActionDefinition[] = () => []

  /** Called by the surface with the live action list. */
  setActiveActions(read: () => ActionDefinition[]): void {
    this.activeActionsProvider = read
  }
  /**
   * The work the surface used to do as it set itself up: effects, the
   * subscriptions it opened and the first load it kicked off. It runs from
   * the board's constructor, which the component calls during its own setup,
   * so every effect here is owned by the component.
   */
  init(): void {
    // A trace the reader expanded belongs to the visit that expanded it: opening
    // this thread again starts from the fold each turn asks for, so a settled
    // thread never returns with an old turn's work expanded. Only the running
    // turn re-opens, which it does by itself once it is live.
    agentRuns.resetTraceView(
      this.root.handleAgentEvent.thread.projectId,
      this.root.pollStreamParts.conversationId
    )
    agentRuns.resetTraceView(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
    // A persisted in-flight status is only a recovery hint. Start every mount in
    // a settled idle state unless this thread is already receiving live activity;
    // `connectSession` will promote it to busy when the live session confirms it.
    // This removes the false working flash on refresh and on view remounts, and it
    // covers controller-driven side chats too: a stale busy flag there hides the
    // newest answer behind the working trace (the final-answer block is gated on
    // it) and turns the composer into a queue/steer surface for a run that is
    // already over.
    // svelte-ignore state_referenced_locally
    if (
      !agentRuns.isLiveBusy(
        this.root.handleAgentEvent.thread.projectId,
        this.root.pollStreamParts.conversationId
      ) &&
      agentRuns.activity(
        this.root.handleAgentEvent.thread.projectId,
        this.root.pollStreamParts.conversationId
      ) !== 'brainstorm_report'
    ) {
      agentRuns.setIdle(
        this.root.handleAgentEvent.thread.projectId,
        this.root.pollStreamParts.conversationId
      )
    }

    $effect(() => {
      this.root.handleAgentEvent.liveTokenRate.begin(this.root.handleAgentEvent.sessionId)
    })

    /**
     * Read the account's properties as soon as the selection lands, so the meter
     * and the context dropdown never render a window another account stated.
     */
    $effect(() => {
      modelRuntime.ensure(this.root.currentWorkingTraceAttribution.modelRuntimeSelection)
    })

    $effect(() => {
      if (!this.root.currentWorkingTraceAttribution.threadModel.model) return
      if (this.root.currentWorkingTraceAttribution.threadModel.contextWindows.length === 0) return
      const stored = this.root.loadOlderMessages.settings.contextWindow
      if (stored === undefined) return
      if (this.root.currentWorkingTraceAttribution.threadModel.contextWindowOverride !== undefined)
        return
      const key = `${this.root.loadOlderMessages.settings.harnessId}:${this.root.loadOlderMessages.settings.providerId}:${this.root.loadOlderMessages.settings.modelId}:${stored}`
      if (this.root.state.reconciledContextWindow === key) return
      this.root.state.reconciledContextWindow = key
      this.root.contextUsage.updateSettings({
        ...this.root.loadOlderMessages.settings,
        contextWindow: undefined
      })
    })

    $effect(() => {
      if (this.root.props.controller) return
      void invoke(
        'thread:harnessUsage',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
        .then((rows) => {
          this.root.harnessUsage.storedHarnessUsage = rows.map((row) => ({
            harnessId: row.harnessId,
            providerId: row.providerId,
            ...(row.modelId ? { modelId: row.modelId } : {}),
            costUsd: row.costUsd,
            pricedCostEvents: row.pricedCostEvents,
            unavailableCostEvents: row.unavailableCostEvents,
            rateLimits: [],
            tokens: row.tokens,
            messageCount: row.messageCount,
            durationMs: row.durationMs,
            ...(row.models?.length ? { models: row.models } : {})
          }))
        })
        .catch(() => {})
    })

    // Re-evaluate asynchronously: settings may be corrected by loadLocal after the
    // first render, so a valid snapshot is admitted as soon as it matches.
    $effect(() => {
      this.root.studioTemporaryChatContext.seedContextUsageSnapshot(
        this.root.handleAgentEvent.thread.contextUsage
      )
    })

    $effect(() => {
      const latest = this.root.contextUsage.contextUsage
      if (!latest) return
      const elapsed = Date.now() - this.root.unmirroredTraceStartTime.contextUsageCommittedAt
      if (!this.root.switchProject.busy || elapsed >= this.root.state.CONTEXT_USAGE_SETTLE_MS) {
        this.root.contextUsage.commitContextUsage(latest)
        return
      }
      if (this.root.state.contextUsageSettleTimer !== undefined) return
      this.root.state.contextUsageSettleTimer = setTimeout(() => {
        this.root.state.contextUsageSettleTimer = undefined
        const current = this.root.contextUsage.contextUsage
        if (current) this.root.contextUsage.commitContextUsage(current)
      }, this.root.state.CONTEXT_USAGE_SETTLE_MS - elapsed)
      return () => {
        if (this.root.state.contextUsageSettleTimer !== undefined) {
          clearTimeout(this.root.state.contextUsageSettleTimer)
          this.root.state.contextUsageSettleTimer = undefined
        }
      }
    })

    /**
     * Where the studio's pane sits, so the header can centre the thread's name in it.
     *
     * A studio replaces the conversation and the context panel can stay open beside
     * it, so the pane is narrower than the window: measuring this view is the only
     * way the name lands in the middle of what the user is actually looking at. The
     * box is watched rather than measured once, because a panel opening or closing
     * moves it without the window changing.
     */
    $effect(() => {
      if (!this.root.submitSpecDecision.showSpecStudio) {
        layoutPanelState.clearStudioPane()
        return
      }
      const element = this.root.state.threadViewElement
      if (!element) return
      const report = () => {
        const box = element.getBoundingClientRect()
        if (box.width <= 0) return
        layoutPanelState.setStudioPane(Math.round(box.left), Math.round(box.width))
      }
      report()
      const observer = new ResizeObserver(report)
      observer.observe(element)
      window.addEventListener('resize', report)
      return () => {
        observer.disconnect()
        window.removeEventListener('resize', report)
        layoutPanelState.clearStudioPane()
      }
    })

    /**
     * Follow the selection while the menu is open.
     *
     * Shift and an arrow key extend or trim a selection without any pointer event,
     * and the menu has to describe the text highlighted now rather than the text
     * that was highlighted when the pointer came up. A selection that emptied
     * inside a response closes the menu; one that has only left the responses,
     * like a caret the comment editor took, leaves the menu where it is.
     */
    $effect(() => {
      if (!this.root.sources.selectionMenuOpen) return
      return trackLiveSelection(captureResponseSelection, (candidate) => {
        // A menu opened for an annotation quotes that annotation, not the
        // document selection, so an empty selection cannot describe it and no
        // longer takes the menu away.
        if (!candidate && this.root.sources.responseSelection?.referenceId) return
        if (!candidate && !this.root.state.selectionTouchesResponses()) return
        this.root.sources.responseSelection = candidate
      })
    })

    /** Own the right-click menu inside the responses while this view is mounted. */
    $effect(() => registerSelectionAnnotationClaim(this.root.sources.claimResponseSelectionMenu))

    // Keep comment bubbles and highlights anchored to their text as the
    // conversation re-renders. Every trigger below can change which DOM nodes
    // carry the annotated text: a streamed publish, the mounted history window
    // growing after the first paint, and the run state settling (which moves the
    // newest answer out of the working trace into its final-answer block, the
    // only place that carries the annotation anchor). Without them the restore
    // ran once - before that anchor existed - and never ran again, so the
    // highlights and comment bubbles stayed missing until a new selection
    // happened to re-trigger it.
    //
    // Becoming active again is one of those triggers: every position measured
    // while the conversation was off screen or covered by another view is stale,
    // and a range that failed to rebuild in that state was never retried. That is
    // what left a comment with no bubble and no highlight on return.
    $effect(() => {
      void this.root.steerQueuedMessage.annotationReferences.length
      void this.root.composerScope.visibleMessages.length
      void this.root.pollStreamParts.conversationBusy
      void threadMessages.streamRevision(
        this.root.handleAgentEvent.thread.projectId,
        this.root.pollStreamParts.conversationId
      )
      void this.root.props.active
      if (this.root.steerQueuedMessage.annotationReferences.length === 0) return
      this.root.unmirroredTraceStartTime.responseRangeRetriesLeft =
        this.root.unmirroredTraceStartTime.RESPONSE_RANGE_RETRIES
      void tick().then(() => {
        if (!this.root.loadOlderMessages.alive) return
        this.root.steerQueuedMessage.syncResponseHighlights(
          this.root.steerQueuedMessage.annotationReferences
        )
      })
    })

    // A bubble is measured in viewport coordinates, so it has to be re-measured
    // when the conversation changes width: a sidebar drag or a docked panel moves
    // every highlight without firing a window resize. A height change is content,
    // which the publish trigger already covers, and re-measuring on every
    // streamed frame would force layout for nothing.
    $effect(() => {
      const element = this.root.loadOlderMessages.scrollEl
      if (!element) return
      let lastWidth = element.clientWidth
      const observer = new ResizeObserver(() => {
        if (element.clientWidth === lastWidth) return
        lastWidth = element.clientWidth
        this.root.steerQueuedMessage.scheduleResponseBubbleUpdate()
      })
      observer.observe(element)
      return () => observer.disconnect()
    })

    /**
     * Keep the orchestrator board's ledger read in step with the on-screen thread.
     *
     * A dispatch lands mid-thread, inside the very turn that asks for it, so the
     * board has to appear then rather than after the user reopens the thread. The
     * row a board belongs to is the dock row, which is the coordinator for a
     * worker/auditor child and the thread itself otherwise.
     */
    $effect(() => {
      const thread = this.root.handleAgentEvent.thread
      // Read as a dependency: new activity on this thread re-runs the read.
      void thread.lastActivity
      void orchestrationCoordinatorState.refresh(
        thread.projectId,
        this.root.currentWorkingTraceAttribution.coordinatorDockThreadId
      )
    })

    $effect(() => {
      const kind = this.root.submitBrainstormDecision.coordinatorKind
      if (!kind) return
      const label =
        kind === 'assignment'
          ? 'Assignment coordinator'
          : kind === 'achievement'
            ? 'Achievement coordinator'
            : kind === 'orchestrator'
              ? 'Orchestrator'
              : 'Audit coordinator'
      const panel = this.root.contextUsage.coordinatorPanel(kind)
      if (!panel) return
      // No unmount cleanup: publishing is a prop update for the row, and the
      // sibling view that takes over on a thread switch republishes. Tearing the
      // registration down on unmount blanked the sidebar (and rebuilt the whole
      // board) for the frame or two the entering view needed to hydrate.
      coordinatorDockState.register({
        projectId: this.root.handleAgentEvent.thread.projectId,
        threadId: this.root.currentWorkingTraceAttribution.coordinatorDockThreadId,
        label,
        icon:
          kind === 'assignment'
            ? CioNetwork
            : kind === 'achievement'
              ? CioTarget
              : kind === 'orchestrator'
                ? CioMonogram
                : CioShieldCheck,
        panel
      })
      // Docks itself the first time a thread starts coordinating, unless the user
      // closed it before; later runs are no-ops because the tab already exists.
      if (
        coordinatorDockState.canAutoOpen(
          this.root.handleAgentEvent.thread.projectId,
          this.root.currentWorkingTraceAttribution.coordinatorDockThreadId
        ) &&
        !contextSidebarState.hasCoordinator(
          this.root.handleAgentEvent.thread.projectId,
          this.root.currentWorkingTraceAttribution.coordinatorDockThreadId
        )
      ) {
        contextSidebarState.openCoordinator(
          this.root.handleAgentEvent.thread.projectId,
          this.root.currentWorkingTraceAttribution.coordinatorDockThreadId,
          label
        )
      }
    })

    /** A mount that settles without a coordinator withdraws its row's dock, so a
     *  panel can never outlive the coordination it belonged to. Runs only after
     *  the mount settles, which is what lets the entering view of a thread switch
     *  keep the previous row's panel on screen instead of blanking it. */
    $effect(() => {
      if (this.root.loadOlderMessages.hasController) return
      // A thread with no Engineering state to load is already settled: waiting for
      // a reconcile that will never run would leave a stale coordinator dock and
      // stale studio flags from the thread the user came from.
      if (
        !this.root.composerScope.workflowReady &&
        this.root.composerScope.shouldHydrateEngineeringState(this.root.handleAgentEvent.thread)
      )
        return
      if (this.root.submitBrainstormDecision.coordinatorKind !== null) return
      // Only the orchestration boards this view publishes. An authored-work board on
      // the same row belongs to the design store and must survive this cleanup.
      coordinatorDockState.withdraw(
        this.root.handleAgentEvent.thread.projectId,
        this.root.currentWorkingTraceAttribution.coordinatorDockThreadId,
        ORCHESTRATION_COORDINATOR_COMPONENTS
      )
    })

    $effect(() => {
      const threadId = this.root.handleAgentEvent.thread.id
      if (this.root.currentWorkingTraceAttribution.independentAuditDisplayEnabled) {
        this.root.state.independentCoordinatorThreadId = threadId
        return
      }
      if (this.root.state.independentCoordinatorThreadId === threadId) {
        this.root.state.independentCoordinatorThreadId = null
        contextSidebarState.closeCoordinator(this.root.handleAgentEvent.thread.projectId, threadId)
      }
    })

    $effect(() => {
      const persisted = this.root.handleAgentEvent.thread.settings
      if (persisted) {
        this.root.loadOlderMessages.settings.assignmentMode = persisted.assignmentMode
        this.root.loadOlderMessages.settings.loopMode = persisted.loopMode
        this.root.loadOlderMessages.settings.loopAuditor = persisted.loopAuditor
        this.root.loadOlderMessages.settings.fileSystemMode = persisted.fileSystemMode
      }
      this.root.submitSpecDecision.auditState = this.root.handleAgentEvent.thread.auditState
    })

    // Keep the thread-messages store aware of the active session so streaming
    // events are routed to the right cache even when this component remounts.
    // Never clear the mapping with an empty id on mount: a thread remounted while
    // its turn is still in flight must keep routing its session events, otherwise
    // a message queued on this thread can't be dispatched once the agent idles.
    $effect(() => {
      if (this.root.handleAgentEvent.sessionId)
        threadMessages.setSessionId(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          this.root.handleAgentEvent.sessionId
        )
    })

    // Convert file:// image/media URLs to blob: Object URLs for reliable display
    // in the Electron renderer (file:// URLs are blocked on http:// origins).
    $effect(() => {
      for (const msg of this.root.loadOlderMessages.messages) {
        for (const part of msg.parts) {
          if (
            part.type === 'file' &&
            (isImageMime(part.mime) || isVideoMime(part.mime) || isAudioMime(part.mime)) &&
            part.url.startsWith('file://')
          ) {
            void this.root.state.imageUrls.load(part.url, part.mime)
          }
        }
      }
    })

    // Feed the header count and Sources sidebar from the persisted conversation.
    // Controller-driven views (temporary chats) are embedded panels, never the
    // primary conversation surface   they must not publish global header state.
    $effect(() => {
      if (this.root.loadOlderMessages.hasController) return
      workspaceState.sources = this.root.sources.sources
    })

    // Jump the transcript to a section requested from the Sources panel.
    $effect(() => {
      const target = sectionNavigationState.last
      const sequence = sectionNavigationState.sequence
      if (!target || sequence === 0) return
      if (
        target.projectId !== this.root.handleAgentEvent.thread.projectId ||
        target.threadId !== this.root.handleAgentEvent.thread.id
      )
        return
      void this.root.loadOlderMessages.scrollToMessageSection(target.messageId, target.section)
    })

    // Feed the header's history panel with every user-authored message: the
    // full persisted history plus any live/optimistic cache messages still pending
    // in the mirror, deduped and kept in chronological order. Each message carries
    // a short work-trace preview from the turn that follows it.
    $effect(() => {
      const tracePreviews = tracePreviewByUserMessage(this.root.loadOlderMessages.messages)
      const userMessages = mergedUserMessageSummaries(
        this.root.loadOlderMessages.messages,
        this.root.editVideoNote.fullUserMessageHistory
      ).map(({ id, content, isAction }) => ({
        id,
        content,
        ...(isAction ? { isAction } : {}),
        ...(tracePreviews.get(id) === undefined ? {} : { tracePreview: tracePreviews.get(id) })
      }))
      if (this.root.loadOlderMessages.hasController) return
      workspaceState.messageCount = userMessages.length
      workspaceState.userMessages = userMessages
    })

    // Expose fork/delete to the history side panel; identity-safe cleanup below.
    // Controller-driven views (temporary chats) never publish history actions.
    $effect(() => {
      if (this.root.loadOlderMessages.hasController) return
      const actions: HistoryMessageActions = {
        fork: (id) => void this.root.editVideoNote.forkFromHistoryMessage(id),
        requestDelete: this.root.editVideoNote.requestHistoryMessageDelete,
        busy: this.root.switchProject.busy,
        forkingId: this.root.editVideoNote.forkingMessageId
      }
      workspaceState.historyActions = actions
      return () => {
        if (workspaceState.historyActions === actions) workspaceState.historyActions = null
      }
    })

    // Controller-driven views (temporary chats) never feed the spec-conversation
    // sidebar: their responses belong to the side chat, not the studio thread.
    $effect(() => {
      if (this.root.loadOlderMessages.hasController) return
      workspaceState.specAgentResponses = this.root.loadOlderMessages.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => ({
          id: message.id,
          content: messageText(message),
          createdAt: message.createdAt
        }))
        .filter((message) => message.content.trim().length > 0)
    })

    // Publish only the currently mounted thread's actions to the global palette.
    // Identity-safe cleanup prevents an older keyed view from clearing a newer one.
    $effect(() => {
      const actions = this.activeActionsProvider()
      return actionContext.register({
        actions,
        onSelect: this.root.switchProject.handleActionSelection
      })
    })

    // A persisted studio document remains available from the header. A missing
    // specification is only retryable after the current agent turn has produced
    // a final response and the generation path has reported an error.
    // Controller-driven views (temporary chats) must not touch spec-studio state:
    // their own showSpecStudio is always false, so publishing from them would
    // close the studio and pop the project sidebar open while the studio is up.
    $effect(() => {
      if (this.root.loadOlderMessages.hasController) return
      // A new mount must not publish a half-loaded state: doing so cleared the
      // header's Spec control (and the studio state) on every thread switch, then
      // restored it once the async reads finished, which read as a flash. Wait
      // for the mount to settle so moving between a coordinator's workers keeps
      // the chrome in place.
      //
      // A thread that never engaged Engineering settles with nothing to show, and
      // publishing that here is what clears the previous thread's studio flags.
      if (
        !this.root.composerScope.workflowReady &&
        this.root.composerScope.shouldHydrateEngineeringState(this.root.handleAgentEvent.thread)
      )
        return
      const hasStudioDocument =
        this.root.editVideoNote.brainstorm !== null ||
        this.root.harnessUsage.prd !== null ||
        this.root.submitBrainstormDecision.spec !== null ||
        this.root.submitSpecDecision.assignment !== null ||
        this.root.contextUsage.auditReport !== null
      workspaceState.specStudioAvailable =
        !this.root.props.chatMode && (hasStudioDocument || this.root.abortRun.specStudioRetryable)
      workspaceState.specStudioOpen = this.root.submitSpecDecision.showSpecStudio
      workspaceState.specStudioBusy = this.root.abortRun.specBusy
      workspaceState.specStudioFormulating = this.root.harnessUsage.specFormulating
      workspaceState.specStudioError = this.root.abortRun.specError
      workspaceState.specStudioRetryable = this.root.abortRun.specStudioRetryable
      if (!this.root.submitSpecDecision.showSpecStudio) {
        this.root.composerScope.brainstormStudioHistories.clear()
        this.root.composerScope.specStudioHistories.clear()
        this.root.composerScope.assignmentStudioHistories.clear()
        this.root.composerScope.auditStudioHistories.clear()
        this.root.composerScope.studioExitConfirmationOpen = false
        workspaceState.specAgentSidebarOpen = false
        findNavState.closeStudioFind()
      }
    })

    // Register the header's Spec toggle; cleared when the thread view unmounts.
    // Controller-driven views (temporary chats) never register workspace state.
    $effect(() => {
      if (this.root.loadOlderMessages.hasController) return
      workspaceState.toggleSpecStudio = () => {
        if (this.root.submitSpecDecision.showSpecStudio) {
          this.root.composerScope.closeSpecStudio()
        } else if (this.root.contextUsage.auditReport) {
          this.root.contextUsage.openAuditStudio()
        } else if (this.root.submitSpecDecision.assignment) {
          this.root.submitSpecDecision.openAssignmentStudio()
        } else if (this.root.submitBrainstormDecision.spec) {
          void this.root.abortRun.openSpecStudio()
        } else if (this.root.harnessUsage.prd) {
          this.root.unmirroredTraceStartTime.openPrdStudio()
        } else if (this.root.editVideoNote.brainstorm) {
          this.root.editVideoNote.openBrainstormStudio()
        } else if (this.root.abortRun.specStudioRetryable) {
          void this.root.abortRun.openSpecStudio()
        }
      }
      return () => {
        // Keep the shared studio flags: the next ThreadView publishes them once
        // it is ready, so switching threads does not blink the header control.
        // Only the per-instance bindings are cleared here.
        workspaceState.toggleSpecStudio = null
        workspaceState.specAgentSidebarOpen = false
        workspaceState.specAgentResponses = []
      }
    })

    // A thread opens where the reader needs to start reading.
    //
    // A live turn opens at the live bottom, which is where its output is
    // arriving. A settled one opens at its newest prompt: the message the user
    // sent and the answer it produced are what the screen is for, and dropping
    // them above the fold so the first thing on screen is the turn's
    // file-changes card inverts the whole conversation. A saved pixel offset is
    // stale the moment the conversation grows, so it is never restored. This
    // runs once per thread (the view is remounted per thread switch); later
    // arrivals are followed by the resize observer below.
    $effect(() => {
      // Reading the mounted window here is the dependency that re-runs this
      // effect as the reveal publishes batches; the restore must wait for the
      // whole window, otherwise it anchors on a partial tail and the prompt
      // arrives above the viewport a few frames later.
      void this.root.composerScope.visibleMessages.length
      if (
        !this.root.sources.loaded ||
        !this.root.loadOlderMessages.scrollEl ||
        this.root.unmirroredTraceStartTime.scrollRestored
      )
        return
      if (
        !this.root.loadOlderMessages.hasController &&
        threadMessages.revealing(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id
        )
      )
        return
      const scrollToTurnPrompt = (attempt: number): void => {
        const el = this.root.loadOlderMessages.scrollEl
        if (!el || this.root.unmirroredTraceStartTime.scrollRestored) return
        // Anchor on the message that opens the newest turn, by id. The first
        // mounted message is normally the same element, but only while the
        // window still starts there: a history page that mounted above it puts
        // an OLD message first in the document, and anchoring on that one is
        // how a thread opened in the middle of its history instead of at the
        // prompt the reader came to read.
        const startIndex = this.root.buildSpecActionPrompt.latestTurnInfo.startIndex
        const newestPromptId =
          startIndex >= 0 ? this.root.loadOlderMessages.messages[startIndex]?.id : undefined
        const newestPrompt = newestPromptId
          ? document.getElementById(`msg-${newestPromptId}`)
          : null
        const prompt = newestPrompt ?? el.querySelector<HTMLElement>('[id^="msg-"]')
        if (prompt) {
          const top =
            prompt.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
          el.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
          // Pin the viewport to the prompt. Content below keeps growing (a
          // settling trace, markdown, images, a live turn), and the tail
          // follower would otherwise drag the reader to the newest pixel and
          // hide the message they opened the thread to read. A send releases
          // this pin by calling `scrollToLatest`.
          this.root.loadOlderMessages.userScrolledAway = true
          this.root.unmirroredTraceStartTime.scrollRestored = true
          return
        }
        // The transcript mounts its window on the frame after the load flag
        // flips; a short bounded retry anchors it instead of falling back to
        // the tail and hiding the prompt.
        if (attempt < 4) {
          requestAnimationFrame(() => scrollToTurnPrompt(attempt + 1))
          return
        }
        el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
        this.root.loadOlderMessages.userScrolledAway = false
        // Flag the restore *after* the scroll actually ran: setting it in the
        // effect body would poison this callback's own `scrollRestored` guard
        // (the body runs synchronously, before `tick()` resolves) and the
        // snap-to-bottom would never fire.
        this.root.unmirroredTraceStartTime.scrollRestored = true
      }
      void tick().then(() => {
        const el = this.root.loadOlderMessages.scrollEl
        if (!el || this.root.unmirroredTraceStartTime.scrollRestored) return
        scrollToTurnPrompt(0)
      })
    })

    // Follow the live tail without ever fighting the reader. Whenever the
    // conversation content changes size   messages stream in, markdown and
    // images finish rendering, cards resolve, a sent message lands   re-anchor
    // to the latest message, but only while the reader is still at the bottom.
    // Their first upward scroll or wheel tick sets `userScrolledAway` and the
    // viewport is never touched again until they jump back. Native browser
    // anchoring is disabled on the scroller because a changing trace descendant
    // is an unstable anchor; the fixed scrollTop preserves the reader's viewport.
    // This is purely
    // event-driven: no timers, no animation-frame loops, so scrolling can never
    // be interrupted by a competing writer.
    $effect(() => {
      const el = this.root.loadOlderMessages.scrollEl
      const content = el?.firstElementChild
      if (!el || !(content instanceof Element)) return
      const observer = new ResizeObserver(() => {
        if (
          !this.root.loadOlderMessages.scrollEl ||
          !mayReanchorToLatest(this.root.loadOlderMessages.userScrolledAway)
        )
          return
        // Re-anchor only when the viewport actually drifted from the bottom
        // a no-op write here would fire a pointless scroll event per resize.
        if (
          this.root.loadOlderMessages.scrollEl.scrollHeight -
            this.root.loadOlderMessages.scrollEl.scrollTop -
            this.root.loadOlderMessages.scrollEl.clientHeight >
          1
        ) {
          this.root.loadOlderMessages.scrollEl.scrollTop =
            this.root.loadOlderMessages.scrollEl.scrollHeight
        }
      })
      observer.observe(content)
      return () => observer.disconnect()
    })

    onMount(() => {
      // The parent clears its selected thread before Svelte runs this cleanup.
      // Keep the mounted identity stable so teardown never crosses the chat /
      // project boundary through the now-null live prop.
      const mountedProjectId = this.root.handleAgentEvent.thread.projectId
      const mountedThreadId = this.root.handleAgentEvent.thread.id
      // The composer's account selector is an enrichment: reading the harness's
      // account registry must not share the switch frame with the conversation
      // mount, so it is queued for after the paint.
      scheduleDeferredWork('threadView:providerAccounts', () => {
        void invoke('providerAccounts:list', this.root.loadOlderMessages.settings.harnessId)
          .then((accounts) => {
            if (this.root.loadOlderMessages.alive)
              this.root.currentWorkingTraceAttribution.harnessAccounts = accounts
          })
          .catch(() => {
            if (this.root.loadOlderMessages.alive)
              this.root.currentWorkingTraceAttribution.harnessAccounts = []
          })
      })
      scheduleDeferredWork('threadView:ovens', () => {
        void invoke('oven:state')
          .then((state) => {
            if (this.root.loadOlderMessages.alive)
              this.root.currentWorkingTraceAttribution.ovensForAttribution = state
          })
          .catch(() => {
            if (this.root.loadOlderMessages.alive)
              this.root.currentWorkingTraceAttribution.ovensForAttribution = null
          })
      })
      if (!this.root.props.controller) {
        workspaceState.jumpToMessage = this.root.loadOlderMessages.jumpToMessage
        workspaceState.loadUserMessageHistory = this.root.editVideoNote.refreshUserMessageHistory
        // Prefetch the lightweight user-message history shortly after mount so
        // the history panel is populated the first time it opens, without the
        // user having to open it once to trigger the load. Deferred past the
        // first paint (idle callback) so the initial reveal never waits on it.
        this.root.state.historyPrefetchHandle = requestIdleCallback(
          () => {
            if (this.root.loadOlderMessages.alive)
              void this.root.editVideoNote.refreshUserMessageHistory()
          },
          // Bounded: never starve the panel population behind constant work.
          { timeout: 2000 }
        )
      }

      const onResize = (): void => this.root.steerQueuedMessage.scheduleResponseBubbleUpdate()
      window.addEventListener('resize', onResize)

      // Agent events are this view's only live channel, and a controller-driven
      // conversation needs it for the one thing it has no other surface for: the
      // human gate. Its `handleAgentEvent` branch reconciles the pending-question
      // queue, so a card the agent raises while the panel is mounted appears
      // instead of leaving the turn parked on a question nobody can see. The
      // subscription is installed before the controller branch returns because that
      // branch is a separate return path: registering it further down made the
      // whole controller half of `handleAgentEvent` unreachable, which is how a
      // browser tab's assistant chat could ask a question and never show it.
      this.root.state.unsubscribe = subscribe('agent:event', (...args: unknown[]) => {
        const event = args[0] as AgentEvent
        if (!event) return
        this.root.handleAgentEvent.handleAgentEvent(event)
      })

      // Held in a local so the callbacks below keep the guard's narrowing.
      const controller = this.root.props.controller
      if (controller) {
        controller.mount()
        void Promise.resolve(controller.load()).then(() =>
          this.root.composerScope.beginInitialPaintReveal()
        )
        this.root.unmirroredTraceStartTime.localReady = Promise.resolve()
        this.root.currentWorkingTraceAttribution.sessionReady = Promise.resolve('')
        // Slash commands and skills only feed the composer's menus, so they are
        // read after the switch has painted instead of during it.
        scheduleDeferredWork('threadView:commands', () => {
          void this.root.switchProject.refreshCommands()
          void this.root.studioTemporaryChatContext.refreshCapabilitySkills()
        })
        // Remounting into a side chat that is already blocked on a permission
        // request rehydrates its card; the parent thread is never asked for it.
        void this.root.editVideoNote.refreshPendingPermissions()
        // Same for a question the agent asked: a controller-driven conversation can
        // be a durable thread (a browser tab's assistant chat), and a question has
        // no other surface, so its queue is rehydrated here too.
        void this.root.composerScope.refreshPendingQuestions()

        return () => {
          this.root.loadOlderMessages.alive = false
          this.root.state.unsubscribe?.()
          // Save scroll position so switching back snaps to the right place
          if (this.root.loadOlderMessages.scrollEl) {
            threadScrollPositions.set(mountedThreadId, {
              top: this.root.loadOlderMessages.scrollEl.scrollTop,
              awayFromBottom: this.root.loadOlderMessages.userScrolledAway
            })
          }
          window.removeEventListener('resize', onResize)
          clearTimeout(this.root.composerScope.copyResetTimer)
          cancelAnimationFrame(this.root.unmirroredTraceStartTime.initialPaintRevealFrame)
          if (this.root.state.historyPrefetchHandle !== null) {
            cancelIdleCallback(this.root.state.historyPrefetchHandle)
            this.root.state.historyPrefetchHandle = null
          }
          // Controller-driven views never published the global state below, so
          // their teardown must not clear it either   clearing would clobber the
          // values published by the primary conversation view behind the panel.
          if (!this.root.props.controller) {
            workspaceState.sources = []
            workspaceState.jumpToMessage = null
            if (
              workspaceState.loadUserMessageHistory ===
              this.root.editVideoNote.refreshUserMessageHistory
            ) {
              workspaceState.loadUserMessageHistory = null
            }
            workspaceState.messageCount = 0
            workspaceState.userMessages = []
          }
          controller.unmount()
        }
      }

      if (this.root.composerScope.shouldHydrateEngineeringState()) {
        // Deliberately *not* deferred: this state decides which cards render above
        // the composer (terminal-failure retry, stage cards), so loading it after
        // the paint would shift the conversation's layout on every switch.
        void invoke('engineeringLifecycle:get', mountedProjectId, mountedThreadId)
          .then((state) => {
            if (this.root.loadOlderMessages.alive)
              this.root.handleAgentEvent.engineeringLifecycle = state
          })
          .catch((error) => {
            reportError(error, 'Engineering lifecycle could not be loaded')
          })
      }
      if (!this.root.props.chatMode) {
        // Staged choices are local intent, not durable Engineering state: a thread
        // that has not engaged Engineering yet still has to show the switches the
        // user staged on it, so this restore stays outside the hydration gate.
        //
        // Restore a staged (not-yet-sent) Toolbox selection from a previous
        // session or thread switch so the switches keep the user's last choice.
        const stagedIntent = loadLifecycleIntent(mountedProjectId, mountedThreadId)
        if (stagedIntent) this.root.harnessUsage.pendingLifecycleSelection = stagedIntent
        // Same for a staged (not-yet-sent) Independent Audit toggle.
        const stagedAuditIntent = loadIndependentAuditIntent(mountedProjectId, mountedThreadId)
        if (stagedAuditIntent !== null)
          this.root.currentWorkingTraceAttribution.pendingIndependentAudit = stagedAuditIntent
      }
      // A sibling thread may inherit its Engineering lifecycle after this view
      // already hydrated (the inheritance write is async). Re-read once the
      // inheritance lands so the inherited switches show as on.
      this.root.state.unsubscribeLifecycleInheritance = onEngineeringLifecycleInherited(
        (inheritedThreadId) => {
          if (
            !this.root.loadOlderMessages.alive ||
            inheritedThreadId !== this.root.handleAgentEvent.thread.id ||
            this.root.props.chatMode
          ) {
            return
          }
          void invoke(
            'engineeringLifecycle:get',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id
          )
            .then((state) => {
              if (this.root.loadOlderMessages.alive)
                this.root.handleAgentEvent.engineeringLifecycle = state
            })
            .catch(() => {})
        }
      )
      this.root.steerQueuedMessage.scheduleResponseHighlightRestore(
        this.root.steerQueuedMessage.annotationReferences
      )
      // This view owns dispatch of the thread's queued message while mounted;
      // the background dispatcher must defer to it to avoid a double send.
      queuedMessageDispatcher.markMounted(mountedProjectId, mountedThreadId)
      // A voice transcript sent while this thread's composer was not mounted was
      // dispatched headlessly (or parked in the queue). Drop the stale composer
      // buffer and surface a freshly parked message in the queue card.
      const unsubscribeVoiceSend = onVoiceComposerReset((resetProjectId, resetThreadId) => {
        if (
          resetProjectId !== this.root.handleAgentEvent.thread.projectId ||
          resetThreadId !== this.root.handleAgentEvent.thread.id
        )
          return
        this.root.currentWorkingTraceAttribution.composerRestoreKey += 1
        this.root.steerQueuedMessage.restoreQueuedMessage()
        this.root.steerQueuedMessage.scheduleIdleAttention()
      })

      // Slash menu inputs: harness commands and the skills visible to the
      // thread's harness. Previously commands only loaded after a harness
      // switch, leaving a freshly mounted thread's slash menu empty. Both only
      // feed composer menus, so they are read after the switch has painted.
      scheduleDeferredWork('threadView:commands', () => {
        void this.root.switchProject.refreshCommands()
        void this.root.studioTemporaryChatContext.refreshCapabilitySkills()
      })

      this.root.state.unsubscribeThreadUpdated = subscribe(
        'thread:updated',
        (...args: unknown[]) => {
          const updatedThread = args[0] as Thread
          if (
            updatedThread.projectId === this.root.handleAgentEvent.thread.projectId &&
            updatedThread.id === this.root.handleAgentEvent.thread.id
          ) {
            // Another renderer window can create or resume the harness
            // session while this desktop view stays mounted. Adopt that persisted
            // binding before its stream arrives, then reconcile the user message
            // that the other window optimistically owns in its own cache.
            if (
              updatedThread.sessionId &&
              updatedThread.sessionId !== this.root.handleAgentEvent.sessionId
            ) {
              this.root.currentWorkingTraceAttribution.sessionBindingVersion += 1
              this.root.handleAgentEvent.sessionId = updatedThread.sessionId
              this.root.currentWorkingTraceAttribution.sessionReady = Promise.resolve(
                updatedThread.sessionId
              )
              threadMessages.setSessionId(
                this.root.handleAgentEvent.thread.projectId,
                this.root.handleAgentEvent.thread.id,
                updatedThread.sessionId
              )
            }
            // Thread updates are deliberately low-frequency lifecycle boundaries.
            // Reconcile on every one so early-return workflows (for example a
            // planning turn awaiting a choice) cannot strand the remote prompt.
            void this.root.abortRun.refreshMessages()
            this.root.buildSpecActionPrompt.restoreWorkingState(
              updatedThread.status,
              updatedThread.auditState === 'running'
            )
            if (updatedThread.status === 'completed' || updatedThread.status === 'interrupted') {
              // A persisted settle repairs a missed remote recovery frame too.
              this.root.handleAgentEvent.providerStatus = null
              this.root.handleAgentEvent.errorMessage = ''
            }
          }
          // A durable auditor child (independent or Achievement audit) owns its own
          // lifecycle; mirror status transitions so the coordinator panel and the
          // thread row reflect failures and completions without waiting for the
          // next full engineering reconcile (which chat-mode threads skip).
          if (
            updatedThread.projectId === this.root.handleAgentEvent.thread.projectId &&
            updatedThread.achievementRole === 'auditor' &&
            updatedThread.coordinatorThreadId === this.root.handleAgentEvent.thread.id &&
            (this.root.handleAgentEvent.thread.auditorThreadId === updatedThread.id ||
              this.root.contextUsage.durableAuditThread?.id === updatedThread.id)
          ) {
            this.root.contextUsage.durableAuditThread = updatedThread
          }
          if (
            updatedThread.projectId === this.root.handleAgentEvent.thread.projectId &&
            (updatedThread.id === this.root.handleAgentEvent.thread.id ||
              updatedThread.assignmentId === this.root.submitSpecDecision.assignment?.id) &&
            // The event itself is what turns Engineering on (selecting a stage sets
            // the durable marker), so the gate reads the arriving thread instead of
            // this view's not-yet-updated prop.
            this.root.composerScope.shouldHydrateEngineeringState(updatedThread)
          ) {
            this.root.composerScope.scheduleReadySpecReconcile()
          }
          if (
            updatedThread.projectId === this.root.handleAgentEvent.thread.projectId &&
            this.root.steerQueuedMessage.queuedStartAfterThreads.some(
              (reference) => reference.id === updatedThread.id
            )
          ) {
            this.root.steerQueuedMessage.idleAttentionHandled = false
            this.root.steerQueuedMessage.scheduleIdleAttention()
          }
        }
      )
      // Another instance is running this thread's turn, so its stream arrives over
      // the cross-instance bus instead of this process's event channel. The trace
      // and the answer are shared on disk as well, so the boundary of that run is
      // when this window must re-read both: the durable log holds the last entries
      // and the mirror holds the answer row, and neither would be picked up once
      // the stream stops.
      this.root.state.unsubscribeRemoteEvents = subscribeGuarded(
        'agent:remoteEvent',
        (payload: RemoteAgentEventPayload) => {
          if (
            payload.projectId !== this.root.handleAgentEvent.thread.projectId ||
            payload.threadId !== this.root.handleAgentEvent.thread.id
          )
            return
          const event = payload.event
          const type = event.type
          // Remote lifecycle updates are observations only. Applying the local
          // event handler would also dispatch queues and pending attention actions.
          if (event.type === 'session.status') {
            this.root.handleAgentEvent.providerStatus = event.status
            this.root.handleAgentEvent.errorMessage = ''
          } else if (
            (event.type === 'message.part.updated' || event.type === 'message.part.delta') &&
            !(
              event.type === 'message.part.updated' &&
              event.part.type === 'subagent' &&
              subagentStatusIsTerminal(event.part.activity.status)
            )
          ) {
            this.root.handleAgentEvent.providerStatus = null
            this.root.handleAgentEvent.errorMessage = ''
          } else if (event.type === 'session.error' && event.issue) {
            this.root.handleAgentEvent.providerStatus = { state: 'error', issue: event.issue }
          }
          if (type === 'message.completed') {
            void this.root.pollStreamParts.refreshStreamTailAfterTurn()
            return
          }
          if (type !== 'session.idle' && type !== 'session.error' && type !== 'thread.error') return
          void this.root.abortRun.refreshMessages()
          void this.root.pollStreamParts.refreshStreamTailAfterTurn()
        }
      )
      // Task mount restores app-owned state only. Native harness transport stays
      // cold until user sends a message.
      // Warm cache: the bounded window is already in memory (hover preloads or a
      // recent visit), so the staged first paint can start with zero IPC waits.
      if (
        threadMessages.loaded(mountedProjectId, mountedThreadId) &&
        threadMessages.messages(mountedProjectId, mountedThreadId).length > 0
      ) {
        this.root.composerScope.beginInitialPaintReveal()
      }
      void this.root.loadOlderMessages.connectSession()
      this.root.unmirroredTraceStartTime.localReady = this.root.loadOlderMessages
        .loadLocal()
        .then(() => {
          if (!this.root.loadOlderMessages.alive) return
          // Pick up the first message of a freshly started standalone chat.
          if (chatDraft.message) {
            const draft = chatDraft.message
            const files = chatDraft.attachments
            chatDraft.message = ''
            chatDraft.attachments = []
            void this.root.handleAgentEvent.sendMessage(
              draft,
              files,
              undefined,
              undefined,
              undefined,
              [],
              [],
              undefined,
              [],
              true
            )
          }
        })
      // Coming back to the window is exactly when a transcript cached before
      // leaving can have been overtaken: a sibling instance writes the shared
      // mirror while this window sits in the background, and its announcement is
      // only best effort. One bounded tail read keeps what the reader returns to
      // honest without polling.
      const onWindowFocus = (): void => {
        void this.root.abortRun.refreshMessages()
      }
      window.addEventListener('focus', onWindowFocus)
      return () => {
        this.root.loadOlderMessages.alive = false
        queuedMessageDispatcher.markUnmounted(mountedProjectId, mountedThreadId)
        // Save scroll position so switching back snaps to the right place
        if (this.root.loadOlderMessages.scrollEl) {
          threadScrollPositions.set(mountedThreadId, {
            top: this.root.loadOlderMessages.scrollEl.scrollTop,
            awayFromBottom: this.root.loadOlderMessages.userScrolledAway
          })
        }
        this.root.state.unsubscribe?.()
        this.root.state.unsubscribeThreadUpdated?.()
        this.root.state.unsubscribeRemoteEvents?.()
        this.root.state.unsubscribeLifecycleInheritance?.()
        unsubscribeVoiceSend()
        window.removeEventListener('resize', onResize)
        window.removeEventListener('focus', onWindowFocus)
        clearTimeout(this.root.composerScope.copyResetTimer)
        cancelAnimationFrame(this.root.unmirroredTraceStartTime.initialPaintRevealFrame)
        if (this.root.state.historyPrefetchHandle !== null) {
          cancelIdleCallback(this.root.state.historyPrefetchHandle)
          this.root.state.historyPrefetchHandle = null
        }
        workspaceState.sources = []
        workspaceState.jumpToMessage = null
        if (
          workspaceState.loadUserMessageHistory ===
          this.root.editVideoNote.refreshUserMessageHistory
        ) {
          workspaceState.loadUserMessageHistory = null
        }
        workspaceState.messageCount = 0
        workspaceState.userMessages = []
      }
    })

    /**
     * Flush a scope-parked send once its worktree run settles. The queue hold
     * above resets its guard while the run is pending, so the settling job
     * transitioning out of `running` must wake the dispatcher; otherwise the
     * parked message waits until the next unrelated idle event.
     */
    $effect(() => {
      if (this.root.loadOlderMessages.hasController) return
      const stillPending = scopeJobs.hasPendingScopeJob(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      if (stillPending) return
      if (
        !this.root.steerQueuedMessage.queuedMessage &&
        !this.root.steerQueuedMessage.queuedHasContent
      )
        return
      if (this.root.switchProject.busy) return
      this.root.steerQueuedMessage.scheduleIdleAttention()
    })

    /**
     * A draft cleared in another window or instance leaves this conversation too.
     *
     * The draft store drops its mirror of the commit, but the mounted composer
     * holds those words in its own editor and would keep them on screen, so the
     * composer is remounted from the (now empty) restored draft and the selection
     * pins the sent message carried are dropped with it. This is the same path a
     * send takes, just triggered by whoever else sent it.
     */
    $effect(() => {
      return onRemoteDraftCleared((projectId, threadId) => {
        if (
          this.root.handleAgentEvent.thread.projectId !== projectId ||
          this.root.handleAgentEvent.thread.id !== threadId
        )
          return
        this.root.steerQueuedMessage.clearResponseReferences()
        this.root.currentWorkingTraceAttribution.composerRestoreKey += 1
      })
    })

    $effect(() => {
      const current = workspaceState.focusComposerCount
      if (current !== this.root.state.prevFocusComposerCount) {
        this.root.state.prevFocusComposerCount = current
        this.root.currentWorkingTraceAttribution.composerRestoreKey += 1
      }
    })

    $effect(() => {
      const current = workspaceState.focusComposerEditorCount
      if (current === this.root.state.focusComposerEditorBaseline) return
      this.root.state.focusComposerEditorBaseline = current
      this.root.state.composer?.focusComposerAtSavedCaret()
    })

    // A thread another instance is running is genuinely working, and this window
    // has to know it: every live reader below (the durable trace poll, the trace
    // itself, the elapsed timer) is gated on the run state, and this process
    // receives none of the sibling's session events for it. The persisted
    // `planning`/`executing` row is deliberately not trusted for this (it can be a
    // leftover), but the foreign-run notice is proof the owner is alive and running
    // that turn right now, which is exactly what the row cannot tell us.
    $effect(() => {
      const key = `${this.root.handleAgentEvent.thread.projectId}:${this.root.handleAgentEvent.thread.id}`
      if (this.root.composerScope.foreignRunActive) {
        if (this.root.state.foreignRunMarkedKey === key) return
        this.root.state.foreignRunMarkedKey = key
        agentRuns.setBusy(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          true
        )
        return
      }
      if (this.root.state.foreignRunMarkedKey !== key) return
      this.root.state.foreignRunMarkedKey = ''
      agentRuns.completeSession(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
    })

    // While a run is streaming on screen, re-read the durable SSE log every second
    // so the trace stays fresh even when live 'agent:event' broadcasts are not the
    // transport (e.g. a second app instance viewing the same thread, which never
    // receives this instance's in-process window broadcasts and would otherwise
    // show a trace frozen at whatever was on disk at mount). The poll is change-only,
    // and it stops while this thread is off screen: nobody is watching, so the
    // live turn does not need a reader's worth of IPC every second. It stops on the
    // quit signal too, because this read reaches the database through the message
    // mirror and the main process closes that database while the window is still up.
    //
    // A sibling instance's work is the one case where the poll interval is the
    // visible lag: its run reaches this window as forwarded events, but its trace
    // steps only exist in the shared log, so a step appeared whenever the next tick
    // came round, up to a second after the owner had already run it. Every remote
    // event for this thread therefore nudges the same read, coalesced, so a token
    // stream costs a handful of reads instead of one per delta.
    $effect(() => {
      if (!this.root.switchProject.busy || !this.root.props.active || appQuitState.quitting) return
      const { projectId, id } = this.root.handleAgentEvent.thread
      let nudge: ReturnType<typeof setTimeout> | null = null
      const stopRemote = subscribeGuarded(
        'agent:remoteEvent',
        (payload: RemoteAgentEventPayload) => {
          if (payload.projectId !== projectId || payload.threadId !== id) return
          if (nudge !== null) return
          nudge = setTimeout(() => {
            nudge = null
            if (!this.root.props.active || appQuitState.quitting) return
            void this.root.pollStreamParts.pollStreamParts()
          }, this.root.state.REMOTE_TRACE_NUDGE_MS)
        }
      )
      const poll = setInterval(() => void this.root.pollStreamParts.pollStreamParts(), 1000)
      return () => {
        clearInterval(poll)
        if (nudge !== null) clearTimeout(nudge)
        stopRemote()
        this.root.pollStreamParts.streamPartsLoadGeneration += 1
      }
    })

    // A trace's step list is complete the moment the reader looks at it. The rows
    // are folded and cheap and their content stays lazy, so the trace fills the
    // rest of its own fold in the background instead of streaming steps in as the
    // reader scrolls. One page per frame and bounded, so nothing blocks a frame.
    $effect(() => {
      void this.root.pollStreamParts.streamTrace.parts.length
      void this.root.pollStreamParts.streamTrace.hasOlder
      void this.root.pollStreamParts.streamFoldVersion
      if (!this.root.props.active || appQuitState.quitting) return
      if (!this.root.pollStreamParts.streamTrace.hasOlder) return
      if (
        this.root.pollStreamParts.streamTrace.parts.length >= this.root.state.EAGER_STREAM_PARTS_CAP
      )
        return
      const foldVersion = this.root.pollStreamParts.streamFoldVersion
      const frame = requestAnimationFrame(() => {
        if (
          !this.root.loadOlderMessages.alive ||
          foldVersion !== this.root.pollStreamParts.streamFoldVersion
        )
          return
        void this.root.pollStreamParts.loadOlderStreamParts()
      })
      return () => cancelAnimationFrame(frame)
    })

    $effect(() => {
      const anchor = this.root.pollStreamParts.turnAnchorCreatedAt()
      if (anchor === null) return
      if (this.root.state.todoAnchorLastRead === null) {
        this.root.state.todoAnchorLastRead = anchor
        return
      }
      if (anchor === this.root.state.todoAnchorLastRead) return
      this.root.state.todoAnchorLastRead = anchor
      if (!this.root.props.active || appQuitState.quitting) return
      void this.root.pollStreamParts.refreshStreamTailAfterTurn()
    })

    // Leaving this thread (another thread, another top-level view) paginates its
    // working trace in the background: the poll above stops and the durable window
    // collapses to the newest page, so coming back mounts a bounded trace instead
    // of every entry the turn streamed while nobody was reading it. The trim keeps
    // the newest page rather than dropping the fold, so a restored trace is still
    // there on return.
    $effect(() => {
      if (this.root.props.active) return
      if (this.root.pollStreamParts.streamTrace.parts.length <= WORKING_TRACE_PAGE_SIZE) return
      this.root.pollStreamParts.streamTrace.hasOlder = true
      this.root.pollStreamParts.streamTrace.setParts(
        this.root.pollStreamParts.streamTrace.parts.slice(
          this.root.pollStreamParts.streamTrace.parts.length - WORKING_TRACE_PAGE_SIZE
        )
      )
    })

    onDestroy(() => {
      this.root.handleAgentEvent.liveTokenRate.clear()
      if (this.root.steerQueuedMessage.responseRangeRetryFrame)
        cancelAnimationFrame(this.root.steerQueuedMessage.responseRangeRetryFrame)
      this.root.steerQueuedMessage.responseRangeRetryFrame = 0
      releaseAnnotationHighlights(
        this.root.unmirroredTraceStartTime.responseHighlightOwner,
        RESPONSE_HIGHLIGHT_NAME
      )
      this.root.state.imageUrls.destroy()
      this.root.studioTemporaryChatContext.attachmentPreview.revokeAll()
      // Signal the main process that this thread's composer is gone so the
      // draft-timer never fires for a composer that no longer exists.
      publishDraftActivity(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        false
      )
    })
  }
}
