import type { ComposerIdentity } from '../../chats/ComposerIdentity.svelte'
import {
  type ComposerRelocationItem,
  type ComposerRelocationMode
} from '../../chats/composer-relocation'
import { findNavState } from '$lib/stores/find-nav.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { fileUrlToPath } from '$lib/mime'
import { threadArtifactRelativePath } from '$lib/thread-artifact-url'
import { StudioDocumentHistoryCollection } from '../../specs/studio-document-history.svelte'
import { invoke } from '$lib/ipc.svelte'
import { isUsageResetWaitIssue } from '$shared/provider-issue'
import { copyText } from '$lib/copy-text'
import { threadHydratesEngineeringState } from '../thread-indicator'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
import {
  FIRST_RUN_PROVIDER_SEARCH,
  providerConnectFlow
} from '$lib/stores/provider-connect-flow.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { logRendererDev } from '$lib/system/renderer-logger'
import { focusVisibleComposer } from '$lib/focus/composer-focus-registry'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
import { conversationAttention } from '$lib/stores/conversation-attention.svelte'
import {
  responseReferencesState,
  type ResponseReferenceAnchor
} from '$lib/stores/response-references.svelte'
import { latestAgentTodo } from '$lib/agent-todos'
import { dismissedTodo } from '$lib/stores/dismissed-todo.svelte'
import { revealAttachmentFile, revealCitationFile, revealFileInAppTree } from '$lib/reveal-file'
import {
  ASSISTANT_SPACE_ID,
  DEFAULT_SCOPE_BUCKET_ID,
  usesThreadWorkspaceMount
} from '$shared/types'
import type {
  Thread,
  ThreadSettings,
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  AgentSecretSubmission,
  PermissionRequest,
  ProjectFileEntry,
  CapturableSpecContextType,
  BrainstormDocument,
  EngineeringSpec,
  AssignmentPlanContent,
  AssignmentModelSelection,
  AuditReport,
  SpecValidationIssue
} from '$shared/types'
import { isActivityOnlyUserMessage } from '../thread-turn-parts'
import { messageText } from '../thread-message-presentation'

import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewComposerScope extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  /** Stable empty queue so a controller-driven view never allocates per read. */
  EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = []

  /** Minimum first paint: only the newest few messages mount on the first
   *  frame, so a long thread paints instantly on switch. */
  INITIAL_PAINT_MESSAGES = 4

  /** The mounted window: everything from the reader's anchor (or the newest
   *  `mountedCount` messages) to the live tail. The message store may hold
   *  hundreds of merged pages, but only this window mounts   remounting a
   *  whole multi-megabyte transcript on every thread switch was the
   *  switch-back delay. History beyond the window mounts only when the
   *  reader scrolls up (or jumps to it), never automatically. The window
   *  always extends to the tail, so streaming trace entries render the
   *  moment they land   never staged, never evicted from below the reader. */
  visibleMessages = $derived(
    this.root.loadOlderMessages.hasController
      ? this.root.loadOlderMessages.messages
      : this.root.loadOlderMessages.messages.slice(this.root.loadOlderMessages.mountedStartIndex)
  )

  /** Auto-fill the mounted window up to HISTORY_WINDOW_SIZE after the first
   *  paint, one batch per frame. Batches mount above the viewport only, so
   *  content-visibility keeps them layout-free and a reader at the bottom
   *  never sees a step. This is the only automatic fill-in   nothing beyond
   *  the window mounts without the reader scrolling up. */
  beginInitialPaintReveal(): void {
    if (!this.root.loadOlderMessages.alive || this.root.loadOlderMessages.hasController) return
    if (
      this.root.loadOlderMessages.mountedCount === 0 &&
      this.root.loadOlderMessages.messages.length > 0
    ) {
      this.root.loadOlderMessages.mountedCount = Math.min(
        this.root.loadOlderMessages.messages.length,
        this.INITIAL_PAINT_MESSAGES
      )
    }
    this.root.loadOlderMessages.scheduleInitialReveal()
  }

  /** Another live instance owns this thread's in-flight turn. Its stream never
   *  reaches this window, so the composer cannot drive the run and is replaced
   *  by the transfer card instead. */
  foreignRunActive = $derived(
    foreignRuns.isForeign(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
  )

  /** Durable parts for a turn whose work is on screen with no assistant row to
   *  render it: a live follow-up before its first assistant row lands, or a
   *  steer still held under the running trace. */
  unmirroredTraceParts = $derived(
    this.root.buildSpecActionPrompt.pendingLiveTurn ||
      this.root.buildSpecActionPrompt.heldSteerAbsIndex !== -1
      ? this.root.pollStreamParts.streamWorkingPartsForPendingTurn()
      : []
  )

  /** The thread this view draws, preferring the workspace's current copy: a
   *  `thread:updated` handler runs before the prop it rendered from is replaced,
   *  and Engineering turns on through exactly that event. */
  currentThreadSnapshot(): Thread {
    const selected = workspaceState.selectedThread
    return selected?.projectId === this.root.handleAgentEvent.thread.projectId &&
      selected.id === this.root.handleAgentEvent.thread.id
      ? selected
      : this.root.handleAgentEvent.thread
  }

  shouldHydrateEngineeringState(candidate: Thread = this.currentThreadSnapshot()): boolean {
    // Chat threads (Chats, the Assistant space, browser assistant chats) own no
    // Engineering state, and neither does a conversation that never engaged the
    // tooling. Both used to hydrate anyway, on the theory that any non-chat
    // thread might be Engineering: that put six thread-scoped reads on every
    // ordinary conversation's mount and turn boundary.
    return !this.root.props.chatMode && threadHydratesEngineeringState(candidate)
  }

  /**
   * Permission requests of a controller-driven conversation come from the shared
   * attention store instead: a temporary side chat's card has to appear in the
   * side chat's own window, and its tab has to keep saying it needs attention
   * while the transcript is not mounted (the sidebar mounts only the active
   * tab). Threads keep their request queue in this view.
   */
  controllerPermissions = $derived(
    this.root.props.controller
      ? conversationAttention.permissions(
          this.root.props.controller.projectId,
          this.root.props.controller.conversationId
        )
      : this.EMPTY_PERMISSION_REQUESTS
  )

  /** The queue the composer's blocking card renders from. */
  visiblePermissions = $derived(
    this.root.props.controller
      ? this.controllerPermissions
      : this.root.handleAgentEvent.pendingPermissions
  )

  activeTodo = $derived(latestAgentTodo(this.root.pollStreamParts.todoMessages))

  /**
   * A closed task list stays closed across thread switches and restarts, because
   * the dismissal lives per thread in `dismissedTodo` instead of this mount. A
   * different task list shows again, and a running turn always shows the card, so
   * closing it can never hide live progress.
   */
  visibleTodo = $derived(
    this.activeTodo &&
      (this.root.switchProject.busy ||
        !dismissedTodo.isDismissed(this.root.handleAgentEvent.thread.id, this.activeTodo.signature))
      ? this.activeTodo
      : null
  )

  /** The scope segment's data, for a project thread that has a scope on the board. */
  composerScope(identity: ComposerIdentity, isNewThread: boolean) {
    if (identity.kind !== 'project') return undefined
    const bucketId = this.root.handleAgentEvent.thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
    // Resolve against the thread's own project board like scope.bucketForThread.
    const board =
      scopeState.boards.get(this.root.handleAgentEvent.thread.projectId) ?? scopeState.board
    const bucket = board.buckets.find((candidate) => candidate.id === bucketId)
    if (!bucket) return undefined
    return {
      projectId: this.root.handleAgentEvent.thread.projectId,
      threadId: this.root.handleAgentEvent.thread.id,
      bucket,
      isNewThread,
      onOpenScopeView: () => this.root.props.onOpenScopeView?.(this.root.handleAgentEvent.thread)
    }
  }

  /**
   * The task card's run is over: nothing is live for this thread, no other
   * instance owns it, and the provider is not parked waiting on the user or on a
   * retry. A task list still unfinished in this state was abandoned by the
   * agent, and the card has to say so instead of presenting it as live work.
   */
  todoRunStopped = $derived(
    !this.root.switchProject.busy &&
      !this.foreignRunActive &&
      this.root.submitBrainstormDecision.visibleProviderStatus?.state !== 'waiting' &&
      this.root.handleAgentEvent.thread.status !== 'working-paused'
  )

  /** Settings the visible provider status card renders.
   *
   *  The card outlives the failure it reports. Switching the thread to another
   *  model or harness from the card's own picker (or from the composer) must
   *  leave Retry on screen, because Retry re-sends the unanswered request
   *  through the thread's current settings on the current session. A frozen
   *  snapshot would leave the card showing the model that failed while the
   *  button actually ran on the newly selected one, so the card mirrors the
   *  live selection instead. */
  statusCardSettings = $derived<ThreadSettings | null>(
    this.root.submitBrainstormDecision.visibleProviderStatus === null
      ? null
      : this.root.props.chatMode
        ? { ...this.root.loadOlderMessages.settings, assignmentMode: false, loopMode: false }
        : this.root.loadOlderMessages.settings
  )

  /** Save or clear the user comment attached to a reference anchor. */
  saveResponseReferenceComment(id: string, comment: string): void {
    if (this.root.props.controller?.updateReferenceComment) {
      this.root.props.controller.updateReferenceComment(id, comment)
    } else {
      responseReferencesState.updateComment(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        id,
        comment
      )
    }
    this.root.steerQueuedMessage.commentEditorReferenceId = null
    // Saving closes the editor that held the caret, so the comment is now only
    // attached to the chat component. Hand focus back to the composer: the very
    // next primary-modifier Enter sends the comment as the message it annotates.
    focusVisibleComposer()
  }

  /**
   * The marks drawn on one inline artifact part, in composer order.
   *
   * A mark names the media part it belongs to by its URL, so a picture is pinned
   * only by the marks actually drawn on it and two artifacts in the same
   * conversation can never share a mark. A video frame annotation is the same
   * reference, so it is found the same way.
   */
  marksFor(mediaUrl: string): ResponseReferenceAnchor[] {
    return this.root.steerQueuedMessage.responseReferences.filter(
      (reference) => reference.kind === 'image' && reference.mediaUrl === mediaUrl
    )
  }

  /** True once the persisted workflow lookup has resolved for this mount, so no
   *  ready card can flash before the thread's real Spec/Assignment is known. */
  workflowReady = $state(false)

  /** Session-local dismissal of the spec-less Assignment entry card. */
  conversationAssignmentDismissed = $state(false)

  /** True while the Sr. Engineer composes an Assignment draft from the approved Spec. */
  assignmentFormulating = $state(false)

  /** Spec-less Assignment entry: the Assignment stage is selected, this thread
   *  has no Spec, and no Assignment draft exists yet. */
  conversationAssignmentVisible = $derived(
    this.workflowReady &&
      !this.conversationAssignmentDismissed &&
      this.root.loadOlderMessages.settings.assignmentMode === true &&
      this.root.submitBrainstormDecision.spec === null &&
      this.root.submitSpecDecision.assignment === null &&
      !this.root.harnessUsage.specFormulating &&
      !this.assignmentFormulating
  )

  brainstormStudioHistories = new StudioDocumentHistoryCollection<BrainstormDocument>()

  specStudioHistories = new StudioDocumentHistoryCollection<EngineeringSpec>()

  assignmentStudioHistories = new StudioDocumentHistoryCollection<AssignmentPlanContent>()

  auditStudioHistories = new StudioDocumentHistoryCollection<AuditReport>()

  studioExitConfirmationOpen = $state(false)

  seniorModelForThread(): AssignmentModelSelection {
    return {
      harnessId: this.root.loadOlderMessages.settings.harnessId,
      providerId: this.root.loadOlderMessages.settings.providerId,
      modelId: this.root.loadOlderMessages.settings.modelId,
      thinkingLevel: this.root.loadOlderMessages.settings.thinkingLevel,
      inferenceMode: this.root.loadOlderMessages.settings.inferenceMode,
      contextWindow: this.root.loadOlderMessages.settings.contextWindow
    }
  }

  /** The id of the first message in the mounted window   the reader's anchor
   *  the moment they leave the tail. Every pin MUST use this and never a
   *  tail-relative count: `mountedCount` and the turn-aligned window start can
   *  disagree (a long turn spans more messages than one page), and pinning to
   *  `messages.length - mountedCount` then points BELOW the real window start,
   *  which silently unmounts messages the reader can see and collapses the
   *  window toward the tail. That collapse is what threw the reader back to the
   *  latest message when they clicked "Load earlier messages". */
  mountedWindowStartId(): string | null {
    return (
      this.root.loadOlderMessages.messages[this.root.loadOlderMessages.mountedStartIndex]?.id ??
      null
    )
  }

  /** Release the tail-follow lock synchronously when the user starts scrolling up.
   *  A wheel tick arrives before the scroll it causes, so it also has to pin the
   *  window here: setting `userScrolledAway` alone suppressed onScroll's own pin
   *  (that branch is guarded on the flag being false), leaving the window
   *  tail-relative until the reader happened to reload history. */
  onWheel(event: WheelEvent): void {
    if (event.deltaY >= 0) return
    this.root.loadOlderMessages.userScrolledAway = true
    this.root.loadOlderMessages.windowStartId ??= this.mountedWindowStartId()
  }

  /** For the final assistant message of a turn, return the total duration from
   *  the user's prompt to the agent's final output. */
  /** When the agent started working on the turn whose trace opens at msgIndex.
   *  Activity-only user messages between the prompt and the first assistant
   *  message are skipped so the trace timer starts at the real prompt. */
  getTurnStartTime(msgIndex: number): number | undefined {
    for (let i = msgIndex - 1; i >= 0; i--) {
      const message = this.root.loadOlderMessages.messages[i]
      if (!message) break
      if (message.role === 'assistant') break
      if (isActivityOnlyUserMessage(message)) continue
      return message.createdAt
    }
    return undefined
  }

  /** Dismiss an error card: clear the thread's cached error state and reset its
   *  status from failed back to completed so it reads as done, not error. */
  async dismissSessionError(): Promise<void> {
    try {
      await invoke(
        'agent:dismissSessionError',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        this.root.handleAgentEvent.sessionId
      )
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The thread error could not be dismissed.'
    }
  }

  setProviderError(issue: AgentProviderIssue): void {
    const currentIssue =
      this.root.handleAgentEvent.providerStatus?.state === 'error'
        ? this.root.handleAgentEvent.providerStatus.issue
        : null
    if (currentIssue?.rawError && !issue.rawError) return
    this.root.handleAgentEvent.providerStatus = { state: 'error', issue }
    this.root.handleAgentEvent.errorMessage = ''
  }

  /**
   * A usage/rate-limit issue is a scheduled will-retry wait, not a failure:
   * route it to the waiting card (countdown + retry scheduling) so the thread
   * row keeps its "Waiting to retry" spinner instead of flashing an error
   * badge while the card itself renders the will-retry treatment.
   */
  setProviderStatusFromIssue(issue: AgentProviderIssue): void {
    if (isUsageResetWaitIssue(issue)) {
      this.root.handleAgentEvent.providerStatus = { state: 'waiting', issue }
      this.root.handleAgentEvent.errorMessage = ''
    } else {
      this.setProviderError(issue)
    }
  }

  /** Hydrate the authoritative pending-question queue from the main process. */
  async refreshPendingQuestions(): Promise<void> {
    const { projectId, id } = this.root.handleAgentEvent.thread
    try {
      const pending = await invoke('agent:listQuestions', projectId, id)
      this.root.handleAgentEvent.pendingQuestionRequests = pending.filter(
        (request) => !this.root.sources.resolvedQuestionRequestIds.has(request.requestId)
      )
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'Pending questions could not be loaded.'
    }
  }

  /** Recover response-selection annotations persisted with the composer draft
   *  (survives thread switches and app restarts) once the in-memory store has no
   *  entry for this thread. */
  restoreResponseReferences(): void {
    const existing = responseReferencesState.forThread(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
    if (existing.length > 0) return
    const saved = rendererRecovery.draftPromptReferences(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
    if (saved.length === 0) return
    responseReferencesState.setForThread(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      saved
    )
    this.root.steerQueuedMessage.scheduleResponseHighlightRestore(saved)
  }

  /**
   * Whether the recap card stands in for the agent's own confirmation question.
   *
   * The card is the go-ahead: it states the whole draft and carries the Save
   * button. An agent that still asks "does this capture how you want it to work?"
   * after presenting the draft is asking the same question a second time, in a
   * card with a clock running on it, so that question is not drawn while the recap
   * is up. A secret request is never superseded: that one is asking for something
   * only the user can supply.
   */
  assistantRecapSupersedesQuestion = $derived(
    this.root.switchProject.assistantRecapVisible &&
      this.root.handleAgentEvent.pendingQuestionRequests.length > 0 &&
      !this.root.handleAgentEvent.pendingQuestionRequests[0]?.questions.some(
        (question) => question.secretRequest === true
      )
  )

  /**
   * Click behaviour for a message attachment nothing in the app can render: the
   * reader has to find it on disk, so it is revealed in the project's file tree
   * when it lives there and in the OS file manager when it does not. A file
   * neither can show is reported as gone.
   */
  revealSentAttachment(part: Extract<AgentPart, { type: 'file' }>): void {
    const artifactPath = threadArtifactRelativePath(
      part.url,
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
    if (artifactPath) {
      void revealCitationFile(this.root.handleAgentEvent.thread.projectId, artifactPath)
      return
    }
    void revealAttachmentFile(part.url)
  }

  citationForFilePart(part: Extract<AgentPart, { type: 'file' }>): { path: string } | undefined {
    if (part.url.startsWith('file://')) return { path: fileUrlToPath(part.url) }
    // Inline thread artifacts are served over `appfile://`, but the encoded
    // path is the project-relative path of a file on disk, so it gets the
    // same citation target (and context menu) as any other project file.
    const artifactPath = threadArtifactRelativePath(
      part.url,
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
    return artifactPath ? { path: artifactPath } : undefined
  }

  scheduleReadySpecReconcile(): void {
    if (!this.shouldHydrateEngineeringState()) return
    window.setTimeout(() => {
      // A background refresh has no surface of its own: a rejection here would
      // land in the app-wide unhandled-rejection panel with a raw IPC message,
      // and the failures that actually matter are already reported by the mount
      // and workflow-event paths that await this same reconcile.
      if (this.root.loadOlderMessages.alive)
        void this.root.submitBrainstormDecision.reconcileReadySpec().catch(() => {})
    }, 100)
  }

  BRAINSTORM_REVIEW_FALLBACK_LIMIT = 90_000

  brainstormContentMarkdown(draft: BrainstormDocument): string {
    return [
      `# ${draft.content.title}`,
      '',
      '## Session Snapshot',
      '',
      draft.content.summary,
      '',
      ...draft.content.sections.flatMap((section) => [
        `## ${section.title}`,
        '',
        section.markdown,
        ''
      ])
    ].join('\n')
  }

  boundedBrainstormFallback(draft: BrainstormDocument): {
    markdown: string
    truncated: boolean
  } {
    const markdown = this.brainstormContentMarkdown(draft)
    if (markdown.length <= this.BRAINSTORM_REVIEW_FALLBACK_LIMIT) {
      return { markdown, truncated: false }
    }
    return {
      markdown: markdown.slice(0, this.BRAINSTORM_REVIEW_FALLBACK_LIMIT),
      truncated: true
    }
  }

  quoteOccurrences(value: string, quote: string): number[] {
    const occurrences: number[] = []
    let fromIndex = 0
    while (fromIndex <= value.length - quote.length) {
      const index = value.indexOf(quote, fromIndex)
      if (index < 0) break
      occurrences.push(index)
      fromIndex = index + Math.max(quote.length, 1)
    }
    return occurrences
  }

  /** Hide the spec-less Assignment entry for this mount. Nothing persisted is
   *  dismissed   there is no Spec review to record   so re-enabling the
   *  Assignment stage in the Toolbox brings the card back. */
  dismissConversationAssignment(): void {
    this.conversationAssignmentDismissed = true
    this.root.submitSpecDecision.assignmentError = ''
  }

  closeSpecStudio(): void {
    const hasUnsavedChanges =
      this.brainstormStudioHistories.hasUnsavedChanges() ||
      this.specStudioHistories.hasUnsavedChanges() ||
      this.assignmentStudioHistories.hasUnsavedChanges() ||
      this.auditStudioHistories.hasUnsavedChanges()
    if (hasUnsavedChanges) {
      this.studioExitConfirmationOpen = true
      return
    }
    this.finishCloseSpecStudio()
  }

  finishCloseSpecStudio(): void {
    workspaceState.specAgentSidebarOpen = false
    findNavState.closeStudioFind()
    this.root.harnessUsage.studioDocument = 'spec'
    this.root.submitSpecDecision.showSpecStudio = false
  }

  /**
   * The assistant whose workspace this thread reads, when it is one of the
   * Assistant tab's threads.
   *
   * That workspace is `assistant-cwd/<assistantId>`, shared by every task of the
   * assistant, so a file, a doc comment and an inspector comment mean the same
   * thing in all of them. Another assistant's tasks read a different directory,
   * so they are never a destination, and an assistant-less task owns a directory
   * of its own with no sibling to carry anything to.
   */
  relocationAssistantId = $derived(
    this.root.handleAgentEvent.thread.projectId === ASSISTANT_SPACE_ID &&
      this.root.handleAgentEvent.thread.assistantId
      ? this.root.handleAgentEvent.thread.assistantId
      : null
  )

  /**
   * Carrying composer content to another chat.
   *
   * An attached file, a doc comment and an inspector comment all name something
   * the project holds, not something this conversation holds, so any of them can
   * be moved or copied to another chat of the same project. In Assistant View
   * the same holds for another task of the same assistant, because both read one
   * assistant workspace. A chat or a browser tab conversation lives in a hidden
   * container with no sibling to carry anything to, and a controller-driven
   * conversation (a temporary chat) keeps its own composer state, so neither
   * offers the action.
   */
  relocationAvailable = $derived(
    !this.root.loadOlderMessages.hasController &&
      (!usesThreadWorkspaceMount(this.root.handleAgentEvent.thread.projectId) ||
        this.relocationAssistantId !== null)
  )

  requestComposerRelocation(item: ComposerRelocationItem, mode: ComposerRelocationMode): void {
    logRendererDev(
      `[relocation] requested ${item.kind} ${mode} from ${this.root.handleAgentEvent.thread.id}`
    )
    if (!this.relocationAvailable) return
    this.root.currentWorkingTraceAttribution.relocationRequest = { item, mode }
  }

  resumeAchievementCoordination(): void {
    if (this.root.switchProject.busy) return
    void this.root.handleAgentEvent.sendMessage(
      'Continue working toward the approved specification. If implementation is complete, begin the next independent audit.',
      [],
      undefined,
      true,
      undefined,
      [],
      [],
      { action: 'Resume Achievement coordination' }
    )
  }

  async dismissSpecValidationIssue(issue: SpecValidationIssue): Promise<void> {
    const current = this.root.submitBrainstormDecision.spec
    if (!current) return
    await this.root.abortRun.runSpecAction(() =>
      invoke(
        'spec:dismissValidationIssue',
        current.projectId,
        current.threadId,
        current.id,
        current.version,
        issue
      )
    )
  }

  async revealAssignmentInAppFile(content: AssignmentPlanContent): Promise<void> {
    this.root.submitSpecDecision.assignmentError = ''
    try {
      const absPath = await invoke(
        'assignment:revealInFiles',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        content
      )
      await revealFileInAppTree(this.root.handleAgentEvent.thread.projectId, absPath)
    } catch (error) {
      this.root.submitSpecDecision.assignmentError =
        error instanceof Error ? error.message : 'The assignment could not be revealed.'
    }
  }

  async openBrainstormInEditor(document: BrainstormDocument): Promise<void> {
    this.root.harnessUsage.brainstormError = ''
    try {
      await invoke(
        'brainstorm:openInEditor',
        document.projectId,
        document.threadId,
        document.id,
        document.version
      )
    } catch (error) {
      this.root.harnessUsage.brainstormError =
        error instanceof Error ? error.message : 'The brainstorm could not be opened.'
    }
  }

  async revealBrainstormInAppFile(document: BrainstormDocument): Promise<void> {
    this.root.harnessUsage.brainstormError = ''
    try {
      const absPath = await invoke(
        'brainstorm:revealInFiles',
        document.projectId,
        document.threadId,
        document.id,
        document.version
      )
      await revealFileInAppTree(document.projectId, absPath)
    } catch (error) {
      this.root.harnessUsage.brainstormError =
        error instanceof Error ? error.message : 'The brainstorm could not be revealed.'
    }
  }

  searchSpecContext(
    type: Exclude<CapturableSpecContextType, 'attachment'>,
    query: string
  ): Promise<ProjectFileEntry[]> {
    return invoke(
      'projectFiles:search',
      this.root.handleAgentEvent.thread.projectId,
      query,
      type === 'project_rule' ? 'rules' : 'all',
      workspaceState.activeScopeBucketIdFor(this.root.handleAgentEvent.thread.projectId)
    )
  }

  resolveSpecAnnotation(annotationId: string): Promise<EngineeringSpec | null> {
    const current = this.root.submitBrainstormDecision.spec
    if (!current) return Promise.resolve(null)
    return this.root.abortRun.runSpecAction(() =>
      invoke(
        'spec:resolveAnnotation',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        current.id,
        current.version,
        annotationId
      )
    )
  }

  // ─── Message actions (copy / fork / edit) ──────────────────────────────

  copiedMessageId = $state<string | null>(null)

  copyResetTimer = $state<ReturnType<typeof setTimeout> | undefined>()

  async copyMessage(msg: AgentMessage, text = messageText(msg)): Promise<void> {
    try {
      await copyText(text, null)
      this.copiedMessageId = msg.id
      clearTimeout(this.copyResetTimer)
      this.copyResetTimer = setTimeout(() => (this.copiedMessageId = null), 1500)
    } catch {
      this.root.handleAgentEvent.errorMessage = 'The message could not be copied to the clipboard.'
    }
  }

  continuingInThread = $state(false)

  /** Continue a temporary chat in a regular thread. */
  async continueInThread(): Promise<void> {
    if (!this.root.props.onContinueInThread || this.continuingInThread) return
    this.continuingInThread = true
    try {
      await this.root.props.onContinueInThread()
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The chat could not be continued.'
    } finally {
      this.continuingInThread = false
    }
  }

  /**
   * Send pasted secret values to the main process. It stores them (vault, and a
   * utility credential when the agent named one) and hands them to the harness;
   * the values never enter the transcript or the model's context.
   */
  async handleSecretSubmit(requestId: string, secrets: AgentSecretSubmission[]): Promise<void> {
    await invoke(
      'agent:answerSecret',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      requestId,
      secrets
    )
    this.root.sources.resolvedQuestionRequestIds.add(requestId)
    this.root.handleAgentEvent.pendingQuestionRequests =
      this.root.handleAgentEvent.pendingQuestionRequests.filter(
        (request) => request.requestId !== requestId
      )
  }

  /**
   * Hold a secret card's countdown while the user works on it: the same
   * interaction that pauses a question (an update with no next index) clears the
   * request's deadline. The card owns the best-effort handling, so a pause that
   * did not land is retried on the next interaction instead of being swallowed
   * here.
   */
  handleSecretPause(requestId: string, questionIndex: number): Promise<void> {
    return this.root.sources
      .handleQuestionUpdate(requestId, questionIndex, [], undefined)
      .then(() => undefined)
  }

  emptyConversation = $derived(
    this.root.sources.loaded &&
      this.visibleMessages.length === 0 &&
      !this.root.switchProject.busy &&
      !this.root.submitBrainstormDecision.failureRetryVisible &&
      this.visiblePermissions.length === 0 &&
      this.root.handleAgentEvent.pendingQuestionRequests.length === 0
  )

  /** Centered composer head start: empty conversation AND the workspace
   *  allows it (sole untouched thread in project mode, always in chat mode). */
  centeredComposer = $derived(this.emptyConversation && this.root.props.allowCenteredComposer)

  /** Open the harness's provider list, then re-probe so the models it just
   *  connected appear without the user having to open the picker first. */
  openAiAccountSetup(): void {
    providerConnectFlow.open(this.root.loadOlderMessages.settings.harnessId, {
      search: FIRST_RUN_PROVIDER_SEARCH,
      onConnected: () => {
        void providerCatalog.refresh(this.root.handleAgentEvent.thread.projectId, true)
      }
    })
  }
}
