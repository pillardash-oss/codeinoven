import { tick } from 'svelte'
import { SvelteSet } from 'svelte/reactivity'
import { relocationActionLabel } from '../../chats/composer-relocation'
import { findNavState } from '$lib/stores/find-nav.svelte'
import { threadArtifactRelativePath } from '$lib/thread-artifact-url'
import { isAtLatest } from '$lib/scroll-anchor'
import type { ActionSource } from '$lib/actions'
import { invoke } from '$lib/ipc.svelte'
import { threadNeedsAiAccount } from '$lib/ai-account'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { focusVisibleComposer } from '$lib/focus/composer-focus-registry'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { responseReferencesState } from '$lib/stores/response-references.svelte'
import { revealCitationFile, revealLocalFile } from '$lib/reveal-file'
import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
import type {
  Thread,
  AgentPart,
  BrainstormDocument,
  EngineeringSpec,
  AssignmentPlanContent,
  SpecContextReference,
  SpecValidationResult
} from '$shared/types'
import { openInBrowser } from '$lib/open-in-browser'
import { isTurnCompleted, type SubagentPart } from '../thread-turn-parts'
import { threadScrollPositions } from '../thread-scroll-memory'
import type { ComposerStackSlot } from './ThreadView-types'
import type { ThreadView } from './ThreadView-board.svelte'
import { previewUrl } from './thread-view-preview-url'
/** One concern of the ThreadView board. */
export class ThreadViewUnmirroredTraceStartTime {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root)
      throw new Error('ThreadViewUnmirroredTraceStartTime read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
  }

  /**
   * Capture the thread and the scroll position the surface restored.
   *
   * Both read siblings that only exist once the whole board is built, so the
   * board asks for them right after construction.
   */
  bindThread(): void {
    this.mountedThread = this.root.props.thread
    this.savedScrollState = threadScrollPositions.get(this.root.handleAgentEvent.thread.id)
  }

  // Workspace clears its selected-thread state before this keyed view's
  // teardown runs. Keep using the mounted identity during that short window;
  // normal thread replacements remain reactive through the derived value.
  // svelte-ignore state_referenced_locally
  /** Set by `bind()`: the thread this trace belongs to. */
  /** Set by `bind()`: the thread this trace belongs to. */
  mountedThread!: Thread

  citationThreadContext = $derived({
    projectId: this.root.handleAgentEvent.thread.projectId,
    threadId: this.root.handleAgentEvent.thread.id,
    scopeBucketId: this.root.handleAgentEvent.thread.scopeBucketId
  })

  /**
   * Set by `bind()`: the scroll position the surface was left at. Workspace keys
   * this view by thread id, so the capture happens once, at birth.
   */
  savedScrollState!: ReturnType<typeof threadScrollPositions.get>

  /** Messages mounted per frame while the window auto-fills after mount. */
  INITIAL_REVEAL_BATCH = 12

  initialPaintRevealFrame = 0

  hasOlderMessages = $derived(
    this.root.props.controller?.hasOlder ??
      (this.root.loadOlderMessages.olderMessagesAvailable ||
        this.root.loadOlderMessages.mountedStartIndex > 0)
  )

  brainstormReportRefreshing = $derived(
    !this.root.loadOlderMessages.hasController &&
      agentRuns.activity(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      ) === 'brainstorm_report'
  )

  /** Which Brainstorm document operation is running, for the precise label. */
  brainstormActivityDetail = $derived(
    this.brainstormReportRefreshing
      ? agentRuns.activityDetail(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id
        )
      : null
  )

  brainstormActivityLabel = $derived.by(() => {
    if (!this.brainstormReportRefreshing) return ''
    return this.brainstormActivityDetail?.phase === 'create'
      ? `Generating Brainstorm document v${this.brainstormActivityDetail.version ?? 1}`
      : 'Refreshing Brainstorm report'
  })

  /** Whether the current run is confirmed by live session activity. Persisted
   *  `planning`/`executing` is not enough to make the composer or trace busy. */
  liveBusy = $derived(
    this.root.props.controller?.busy ??
      agentRuns.isLiveBusy(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
  )

  /** When the work of a trace that has no assistant row began.
   *
   * The transcript's turn anchor outranks the run store's start above, which is
   * in-memory only: a refresh clears it and re-seeds it from whatever live
   * activity arrives next, so a trace measuring from it restarted its duration
   * at zero instead of resuming it. The anchor is persisted, and it is the same
   * instant the mirrored trace measures from (`getTurnStartTime`) and the turn
   * audit line reports as the turn's duration, so a live trace now agrees with
   * the duration that turn shows once it settles. */
  unmirroredTraceStartTime = $derived(
    this.root.pollStreamParts.turnAnchorCreatedAt() ??
      this.root.studioTemporaryChatContext.activeTurnStartTime
  )

  // Ephemeral sessions this thread spawned (spec/brainstorm drafting) carry
  // their own sessionId, distinct from the thread's main `sessionId` above.
  // Track them so permission events raised on those sessions aren't silently
  // dropped by the exact-match gate below   that used to require leaving and
  // returning to the thread (forcing a remount) before the permission card
  // would appear.
  // Non-reactive bookkeeping: only read inside event handlers, never in the template.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  knownEphemeralSessionIds = new Set<string>()

  /** Finalized per-message rates, recorded when a live turn settles. */
  finalizedTokenRates = $state<Record<string, number>>({})

  lifecycleCancelModalOpen = $state(false)

  /** Global "don't ask again" flag for the image-descriptor vision model picker. */
  imageDescriptorAskAgain = $state(false)

  /** Whether the app auto-resumes threads after a usage/rate-limit reset. */
  autoRetryAfterReset = $state(true)

  /** Native "switch to API usage credits" command, when the active harness's
   *  driver exposes one (Claude Code today)   drives the composer's dedicated
   *  flame-icon shortcut instead of only being reachable via the slash menu. */
  usageCreditsCommand = $derived(
    this.root.switchProject.commands.find((command) => command.name === 'usage-credits')
  )

  /** True once the live session probe has completed; prevents persisted
   *  database status from racing or resurrecting stale busy state. */
  liveStatusKnown = false

  /** Gentle inline notice when an interrupted compaction ate the user's turn. */
  compactionInterruptedNotice = $state('')

  harnessActionSource = $derived<ActionSource>({
    id: this.root.loadOlderMessages.settings.harnessId,
    label: this.root.switchProject.providerName,
    kind: 'harness'
  })

  contextUsageCommittedAt = 0

  /** Called when the user stops hovering the usage indicator. Resets the quota
   *  cache so the *next* hover always fetches fresh data   while the user keeps
   *  hovering, no further fetch is scheduled. */
  hideContextUsage(): void {
    this.root.contextUsage.accountUsageCache.markStale()
  }

  /** How many frames a range rebuild is retried for while its anchor has not
   *  mounted yet, before the annotation settles for the fallback anchor. */
  RESPONSE_RANGE_RETRIES = 3

  /** Selection references shown in the composer (controller-driven for temporary chats). */
  composerReferences = $derived(
    this.root.props.controller?.references ?? this.root.steerQueuedMessage.responseReferences
  )

  /** Identity of this view as the CSS highlight registry's owner, so its
   *  teardown can never clear highlights another view published. */
  responseHighlightOwner = {}

  /**
   * The mark on an inline picture whose comment editor is open.
   *
   * Kept apart from `commentEditorReferenceId` on purpose: that one draws the
   * app's range-anchored editor, which a mark has no range for. The picture's
   * viewer owns the mark's editor, so an edit requested from the composer only
   * has to name the mark and open that viewer on the picture.
   */
  imageMarkEditorId = $state<string | null>(null)

  responseRangeRetriesLeft = this.RESPONSE_RANGE_RETRIES

  persistResponseReferenceCommentDraft(id: string, comment: string): void {
    // A temporary chat has no stored draft: its reference list is its own only
    // copy, so the text being typed is the comment from the first keystroke.
    if (this.root.props.controller?.updateReferenceComment) {
      this.root.props.controller.updateReferenceComment(id, comment)
      return
    }
    responseReferencesState.updateCommentDraft(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      id,
      comment
    )
  }

  /** The comment editor of a mark closed, so its edit request is spent. */
  clearImageMarkEditor(): void {
    this.imageMarkEditorId = null
  }

  specVersions = $state<EngineeringSpec[]>([])

  specValidation = $state<SpecValidationResult>({ valid: false, issues: [] })

  isAssignmentAuditorThread = $derived(
    (this.root.handleAgentEvent.thread.assignmentId !== undefined &&
      this.root.handleAgentEvent.thread.coordinatorThreadId !== undefined &&
      this.root.handleAgentEvent.thread.assignmentRole === undefined) ||
      this.root.handleAgentEvent.thread.achievementRole === 'auditor'
  )

  studioOnlyAuditWorkflow = $derived(
    this.root.loadOlderMessages.settings.assignmentMode !== true &&
      this.root.loadOlderMessages.settings.loopMode !== true &&
      this.root.submitSpecDecision.assignment === null &&
      this.root.handleAgentEvent.thread.assignmentId === undefined &&
      this.root.handleAgentEvent.thread.achievementRole === undefined
  )

  /** Persisted evidence that a durable audit ever ran on this studio-only thread. */
  plainAuditTriggered = $derived(
    this.root.submitSpecDecision.auditState === 'offered' ||
      this.root.submitSpecDecision.auditState === 'running' ||
      this.root.submitSpecDecision.auditState === 'reworking' ||
      this.root.submitSpecDecision.auditState === 'report_ready' ||
      this.root.contextUsage.auditReport !== null
  )

  plainEngineeringAuditRunning = $derived(
    this.studioOnlyAuditWorkflow &&
      (this.root.submitBrainstormDecision.engineeringOn || this.plainAuditTriggered) &&
      this.root.submitSpecDecision.auditState === 'running'
  )

  plainEngineeringAuditReady = $derived(
    this.studioOnlyAuditWorkflow &&
      (this.root.submitBrainstormDecision.engineeringOn || this.plainAuditTriggered) &&
      this.root.submitSpecDecision.auditState === 'report_ready' &&
      this.root.contextUsage.auditReport !== null
  )

  /** Sticky: Achievement coordination remains once the flow has ever run. */
  achievementTriggered = $derived(
    this.root.buildSpecActionPrompt.achievementOnly ||
      this.root.handleAgentEvent.thread.achievementRole === 'coordinator'
  )

  assignmentReworkCycle = $derived(this.root.submitSpecDecision.assignment?.auditCycle?.reworkCycle)

  assignmentAuditFailure = $derived(
    this.root.submitSpecDecision.assignment?.auditCycle?.failure ??
      this.root.buildSpecActionPrompt.auditError
  )

  assignmentAuditStartedAt = $derived(
    this.root.submitSpecDecision.assignment?.auditCycle?.startedAt
  )

  assignmentAuditFinishedAt = $derived(
    this.root.submitSpecDecision.assignment?.auditCycle?.failedAt
  )

  /** Whether this thread is working in any form. Live run state owns the
   *  thread's session; delegated activity owns the coordinator row. */
  threadWorking = $derived(
    this.root.switchProject.busy || this.root.buildSpecActionPrompt.delegatedWorkBusy
  )

  assignmentFinalComplete = $derived(
    this.root.submitSpecDecision.assignment?.auditCycle?.status === 'completed'
  )

  /** The Assignment audit cycle belongs to the coordinator that owns the plan.
   *  A worker mirrors that plan to render its own view, so without this the
   *  coordinator's audit offer would cover the worker's conversation and the
   *  worker could not be chatted with. */
  assignmentAuditOwner = $derived(
    this.root.submitSpecDecision.assignment?.coordinatorThreadId ===
      this.root.handleAgentEvent.thread.id
  )

  /** Whether an audit report exists for the Assignment's coordinator. A worker
   *  reads the plan but not the coordinator's audit report, so its availability
   *  comes from the recorded cycle report instead. */
  assignmentReportAvailable = $derived(
    this.root.contextUsage.auditReport !== null ||
      this.root.submitSpecDecision.assignment?.auditCycle?.reportId !== undefined
  )

  studioAssignment = $derived(
    this.root.submitSpecDecision.assignmentVersions.find(
      (candidate) => candidate.version === this.root.submitSpecDecision.selectedAssignmentVersion
    ) ?? this.root.submitSpecDecision.assignment
  )

  /** Current activity label   shows agent status only in Engineering. */
  loopAuditing = $derived(
    this.root.loadOlderMessages.settings.loopMode === true &&
      this.root.submitSpecDecision.auditState === 'running'
  )

  /** What the app is doing before the harness streams (preparing a remote
   *  checkout, cloning a repository), when main published such a note. */
  workingStatusNote = $derived(
    this.root.handleAgentEvent.providerStatus?.state === 'working'
      ? (this.root.handleAgentEvent.providerStatus.note ?? null)
      : null
  )

  /** True once the saved position (or initial bottom) has been applied. */
  scrollRestored = $state(false)

  isAtBottom(el: HTMLDivElement): boolean {
    return isAtLatest(el)
  }

  /** Resolves once the local disk mirror and queued-message restore finished,
   *  so background session sync can safely dispatch a restored queue. */
  localReady: Promise<void> = $state(Promise.resolve())

  isTerminalThread(status: Thread['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'interrupted'
  }

  /** Count of messages waiting in the thread's FIFO queue (from the store). */
  queuedCount = $derived(
    rendererRecovery.queuedMessageCount(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
  )

  /** The rest of the queue behind the head entry, listed inside its card, with
   *  how many files each message behind the head carries. */
  queuedNextMessages = $derived(
    rendererRecovery
      .queuedMessagesFor(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      .slice(1)
      .map((entry) => ({ id: entry.id, text: entry.text, attachments: entry.attachments.length }))
  )

  /** True when any card sits on the composer's top edge, so the composer's top
   *  rule breaks into the dashed line that carries the join and it stops opening
   *  a gap above itself. */
  composerStackedAbove = $derived(this.root.submitBrainstormDecision.composerStackSlots.length > 0)

  /** Whether a card sits above the named slot, so its own top rule is the broken
   *  join rather than a solid edge. */
  stackedAboveSlot(slot: ComposerStackSlot): boolean {
    return this.root.submitBrainstormDecision.composerStackSlots.indexOf(slot) > 0
  }

  /** Where the scroll-to-latest button floats within the bottom-chrome wrapper.
   *  The button is 1.75rem tall. A stack on the composer starts at the wrapper's
   *  top edge (the cards are flush, with no top padding), so the button centres
   *  on that edge at half its own height: -0.875rem. With nothing above the
   *  composer the wrapper's top edge *is* the composer's top rule, so the button
   *  floats clear of it, its lower edge 0.5rem above: -(1.75rem + 0.5rem).
   *  Change the button's height and both spots move with it. */
  scrollButtonTop = $derived(this.composerStackedAbove ? '-0.875rem' : '-2.25rem')

  /** Send a CodeInOven utility turn   the slash spelling of the @cio-utility
   *  composer tag. The main process owns the utility contract for that turn. */
  triggerCioUtilityTurn(args: string): void {
    const request = args.trim()
    this.root.harnessUsage.sendComposerMessage(
      request ? `@cio-utility ${request}` : '@cio-utility',
      []
    )
  }

  /** Open a design session   the slash spelling of the @cio-design composer tag.
   *  The main process owns the design contract and the capability that goes with
   *  it, so this only has to send the tag and whatever the user typed after it. */
  triggerCioDesignTurn(args: string): void {
    const request = args.trim()
    this.root.harnessUsage.sendComposerMessage(
      request ? `@cio-design ${request}` : '@cio-design',
      []
    )
  }

  /** Open a video session   the slash spelling of the @cio-video composer tag.
   *  The main process owns the video contract and the capability that goes with
   *  it, so this only has to send the tag and whatever the user typed after it. */
  triggerCioVideoTurn(args: string): void {
    const request = args.trim()
    this.root.harnessUsage.sendComposerMessage(request ? `@cio-video ${request}` : '@cio-video', [])
  }

  /** Open a workstation control session   the slash spelling of the @cio-hey
   *  composer tag. The main process owns the orchestration contract and the
   *  tools that go with it, so this only has to send the tag and whatever the
   *  user typed after it. */
  triggerCioOrchestrateTurn(args: string): void {
    const request = args.trim()
    this.root.harnessUsage.sendComposerMessage(request ? `@cio-hey ${request}` : '@cio-hey', [])
  }

  modifyAssistantBehavior(): void {
    this.root.contextUsage.updateSettings({
      ...this.root.loadOlderMessages.settings,
      assistantBehaviorSession: { startedAt: Date.now(), dismissals: 0 }
    })
    void tick().then(() => focusVisibleComposer())
  }

  finishAssistantBehaviorSession(): void {
    this.root.contextUsage.updateSettings({
      ...this.root.loadOlderMessages.settings,
      assistantBehaviorSession: undefined
    })
  }

  /** The draft revision the user chose to keep editing; empty means none. */
  assistantRecapDismissed = $state('')

  keepEditingAssistant(): void {
    this.assistantRecapDismissed = this.root.switchProject.assistantDraftSignature
  }

  /** Delete the queued message. */
  deleteQueuedMessage(): void {
    this.root.steerQueuedMessage.clearQueuedState()
  }

  async openCheckpointFile(checkpointId: string, path: string): Promise<void> {
    await projectFilesWorkspace.loadDirectory(this.root.handleAgentEvent.thread.projectId, '')
    contextSidebarState.openFiles(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
    await projectFilesWorkspace.openCheckpointFile(
      this.root.handleAgentEvent.thread.projectId,
      checkpointId,
      path,
      'diff'
    )
  }

  openFileCitation(path: string): void {
    void revealCitationFile(this.root.handleAgentEvent.thread.projectId, path)
  }

  openFilePart(url: string): void {
    void revealLocalFile(this.root.handleAgentEvent.thread.projectId, url)
  }

  /** Project-relative path of the artifact the fullscreen viewer shows, when
   *  the viewer item is an inline artifact of this thread. */
  viewerArtifactPath(url: string): string | null {
    return threadArtifactRelativePath(
      url,
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
  }

  revealViewerArtifact(path: string): void {
    void revealCitationFile(this.root.handleAgentEvent.thread.projectId, path)
  }

  reviewCheckpoint(checkpointId: string): void {
    contextSidebarState.openDiff(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      checkpointId
    )
  }

  revealCheckpointFile(checkpointId: string, path: string): void {
    contextSidebarState.openDiff(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      checkpointId,
      path
    )
  }

  /**
   * The scope an `inherit` worker choice resolves to. Before sign-off the plan
   * carries no scope yet, so it falls back to the coordinator's own, which is
   * exactly what the engine freezes at activation.
   */
  assignmentScopeBucketId = $derived(
    this.root.submitSpecDecision.assignment?.scopeBucketId ??
      this.root.handleAgentEvent.thread.scopeBucketId ??
      DEFAULT_SCOPE_BUCKET_ID
  )

  isBrainstormDocument(
    document: BrainstormDocument | EngineeringSpec
  ): document is BrainstormDocument {
    return 'sections' in document.content
  }

  openPrdStudio(): void {
    if (!this.root.harnessUsage.prd) return
    this.root.harnessUsage.selectedPrdVersion = this.root.harnessUsage.prd.version
    workspaceState.specAgentSidebarOpen = false
    this.root.harnessUsage.studioDocument = 'prd'
    this.root.submitSpecDecision.showSpecStudio = true
  }

  selectPrdVersion(version: number): void {
    this.root.harnessUsage.selectedPrdVersion = version
  }

  async openPrototypePreview(previewPath: string): Promise<void> {
    const origin = await invoke('prototypePreview:getOrigin')
    if (!origin) {
      this.root.handleAgentEvent.errorMessage =
        'Prototype preview origin is not configured for this deployment.'
      return
    }
    await openInBrowser(previewUrl(previewPath, origin))
  }

  DOCUMENT_WIDE_REVIEW_PATTERN =
    /\b(?:entire|whole|overall|throughout|document-wide|full report|all sections|every section|reconsider everything|start over)\b/iu

  async brainstormContentHash(draft: BrainstormDocument): Promise<string> {
    const encoded = new TextEncoder().encode(JSON.stringify(draft.content))
    const digest = await crypto.subtle.digest('SHA-256', encoded)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  selectAssignmentVersion(version: number): void {
    this.root.submitSpecDecision.selectedAssignmentVersion = version
  }

  async openStartAfterThread(threadId: string): Promise<void> {
    const linkedThread =
      threadId === this.root.handleAgentEvent.thread.id
        ? this.root.handleAgentEvent.thread
        : await invoke('thread:get', this.root.handleAgentEvent.thread.projectId, threadId)
    if (linkedThread) workspaceState.openThread(linkedThread, this.root.contextUsage.project)
  }

  relocationPickerTitle = $derived(
    this.root.currentWorkingTraceAttribution.relocationRequest
      ? relocationActionLabel(
          this.root.currentWorkingTraceAttribution.relocationRequest.mode,
          this.root.currentWorkingTraceAttribution.relocationRequest.item
        )
      : 'Move to chat'
  )

  closeRelocationPicker(): void {
    this.root.currentWorkingTraceAttribution.relocationRequest = null
  }

  /** Debounces the dependency warmup so a fast mouse pass never fires an IPC call. */
  dependencyPreloadTimer = $state<ReturnType<typeof setTimeout> | undefined>()

  DEPENDENCY_PRELOAD_DEBOUNCE_MS = 200

  /** Warm a queued start-after thread's message cache so a click opens instantly. */
  preloadStartAfterThread(threadId: string): void {
    clearTimeout(this.dependencyPreloadTimer)
    this.dependencyPreloadTimer = setTimeout(() => {
      if (threadMessages.loaded(this.root.handleAgentEvent.thread.projectId, threadId)) return
      void threadMessages.preload(this.root.handleAgentEvent.thread.projectId, threadId)
    }, this.DEPENDENCY_PRELOAD_DEBOUNCE_MS)
  }

  /** Remove the auditor thread without starting an audit. The next "Run audit"
   *  creates a brand-new auditor because the deleted one no longer resolves. */
  async deleteAuditorThread(auditor: Thread): Promise<void> {
    await invoke(
      'agent:deleteIndependentAuditorThread',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
    if (this.root.contextUsage.durableAuditThread?.id === auditor.id)
      this.root.contextUsage.durableAuditThread = undefined
  }

  selectAuditVersion(version: number): void {
    const selected = this.root.buildSpecActionPrompt.auditVersions.find(
      (candidate) => candidate.version === version
    )
    if (selected) this.root.contextUsage.auditReport = selected
  }

  async openAssignmentInEditor(content: AssignmentPlanContent): Promise<void> {
    this.root.submitSpecDecision.assignmentError = ''
    try {
      await invoke(
        'assignment:openInEditor',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        content
      )
    } catch (error) {
      this.root.submitSpecDecision.assignmentError =
        error instanceof Error ? error.message : 'The assignment could not be opened.'
    }
  }

  async selectSpecVersion(version: number): Promise<void> {
    const selected = this.specVersions.find((candidate) => candidate.version === version)
    if (selected) await this.root.harnessUsage.setActiveSpec(selected)
  }

  updateSpecContext(context: SpecContextReference[]): Promise<void> {
    const current = this.root.submitBrainstormDecision.spec
    if (!current) return Promise.resolve()
    return this.root.abortRun
      .runSpecAction(() =>
        invoke(
          'spec:setContext',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          current.id,
          current.version,
          context
        )
      )
      .then(() => undefined)
  }

  removeSpecContext(contextId: string): Promise<void> {
    const current = this.root.submitBrainstormDecision.spec
    if (!current) return Promise.resolve()
    return this.updateSpecContext(current.context.filter((reference) => reference.id !== contextId))
  }

  /** Persist the "don't ask again" flag for the image-descriptor vision picker. */
  setImageDescriptorAskAgain(value: boolean): void {
    this.imageDescriptorAskAgain = value
    void invoke('config:update', { imageDescriptorAskAgain: value }).catch(() => undefined)
  }

  /** Submit the complete ordered answer matrix for one pending request. */
  async handleQuestionAnswer(requestId: string, answers: string[][]): Promise<void> {
    await invoke(
      'agent:answerQuestion',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      requestId,
      answers
    )
    this.root.sources.resolvedQuestionRequestIds.add(requestId)
    this.root.handleAgentEvent.pendingQuestionRequests =
      this.root.handleAgentEvent.pendingQuestionRequests.filter(
        (request) => request.requestId !== requestId
      )
  }

  /** Reject one pending request without aborting the surrounding agent run. */
  async handleQuestionDismiss(requestId: string): Promise<void> {
    await invoke(
      'agent:dismissQuestion',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      requestId
    )
    this.root.sources.resolvedQuestionRequestIds.add(requestId)
    this.root.handleAgentEvent.pendingQuestionRequests =
      this.root.handleAgentEvent.pendingQuestionRequests.filter(
        (request) => request.requestId !== requestId
      )
  }

  /**
   * Harness attribution fallback for persisted messages: the session's owning
   * harness first (stable across mid-run settings switches), then the thread's.
   */
  messageHarnessFallback = $derived(
    this.root.handleAgentEvent.thread.sessionHarnessId ??
      this.root.loadOlderMessages.settings.harnessId
  )

  /** True while this thread holds both a provider and a model it can run on. */
  threadCanRunTurns = $derived(!threadNeedsAiAccount(this.root.loadOlderMessages.settings))

  /** Armed by the composer refusing a send the thread has no account for. */
  aiAccountPromptOpen = $state(false)

  /** The prompt also keeps showing while the user picks the model to run with. */
  aiAccountPromptVisible = $derived(this.aiAccountPromptOpen && !this.threadCanRunTurns)

  openSubagent(part: SubagentPart): void {
    contextSidebarState.openSubagent(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      part.id,
      part.activity
    )
  }

  isLatestTurnCompleted(): boolean {
    const startIndex = this.root.buildSpecActionPrompt.latestTurnInfo.startIndex
    return (
      startIndex !== -1 &&
      isTurnCompleted(this.root.buildSpecActionPrompt.structureMessages, startIndex)
    )
  }

  withoutPendingLiveParts(parts: AgentPart[]): AgentPart[] {
    if (
      !this.root.buildSpecActionPrompt.pendingLiveTurn ||
      this.root.buildSpecActionPrompt.pendingLiveTurnParts.length === 0
    )
      return parts
    const pendingPartIds = new SvelteSet(
      this.root.buildSpecActionPrompt.pendingLiveTurnParts.map((part) => part.id)
    )
    return parts.filter((part) => !pendingPartIds.has(part.id))
  }

  /** Find the last text part in a turn ending at the given message index.
   *  Activity-only user messages are transparent to the turn span. */
  showFind = $derived(findNavState.conversationFindOpen && !this.isAssignmentAuditorThread)
}
