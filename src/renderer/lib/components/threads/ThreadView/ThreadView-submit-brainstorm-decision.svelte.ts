import { invoke } from '$lib/ipc.svelte'
import { classifyProviderIssue } from '$shared/provider-issue'
import { messageId } from '$shared/id'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import type {
  Thread,
  AgentPart,
  AgentProviderIssue,
  AgentSessionStatus,
  BrainstormDecisionAction,
  BrainstormDocument,
  BrainstormReviewChanges,
  BrainstormWorkflowState,
  EngineeringSpec
} from '$shared/types'
import { normalizeLifecycleStages } from '$shared/engines/engineering-lifecycle-engine'
import { workflowActionPresentation } from '$shared/workflow-action-presentation'
import { harnessDisplayName, messageText } from '../thread-message-presentation'
import type { ComposerStackSlot, BrainstormReviewAnnotationManifest } from './ThreadView-types'
import type { ThreadView } from './ThreadView-board.svelte'
/** One concern of the ThreadView board. */
export class ThreadViewSubmitBrainstormDecision {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root)
      throw new Error('ThreadViewSubmitBrainstormDecision read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
  }

  /**
   * The surface's own spec reconcile, which walks the markup's own state and so
   * cannot live in a unit; the surface hands it over once.
   */
  private reconcileReadySpecProvider: () => Promise<void> = async () => {}

  /** Called by the surface with the reconcile it owns. */
  setReconcileReadySpec(run: () => Promise<void>): void {
    this.reconcileReadySpecProvider = run
  }
  /** True while the Engineering lifecycle retry from the failure card is running. */
  engineeringLifecycleRetrying = $state(false)

  /** While a stage failed terminally, the retry card is the only card present:
   *  every other stage card is suppressed until the user retries or cancels. */
  failureRetryVisible = $derived(
    this.root.handleAgentEvent.engineeringLifecycle?.humanGate === 'terminal_failure'
  )

  /** Toolbox icon activity mirrors the staged selection, not the persisted
   *  settings: toggles are intent-only until send, so the icon must dim or
   *  light the moment a switch flips   not after the next message.
   *  Without a staged selection the persisted lifecycle stays authoritative. */
  /** Whether the thread currently runs any Engineering lifecycle stage   a
   *  staged (intent-only) selection wins over the persisted lifecycle state. */
  engineeringOn = $derived.by(() => {
    const pending = this.root.harnessUsage.pendingLifecycleSelection
    if (pending) {
      return pending.autopilot === true || normalizeLifecycleStages(pending.stages).length > 0
    }
    const lifecycle = this.root.handleAgentEvent.engineeringLifecycle
    return (
      lifecycle !== null &&
      ((lifecycle.selection ?? 'none') !== 'none' || lifecycle.startedAt !== undefined)
    )
  })

  async retryEngineeringLifecycle(): Promise<void> {
    const current = this.root.handleAgentEvent.engineeringLifecycle
    if (current?.humanGate !== 'terminal_failure' || !current.resumeToken) return
    this.engineeringLifecycleRetrying = true
    try {
      this.root.handleAgentEvent.engineeringLifecycle = await invoke(
        'engineeringLifecycle:retry',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        current.resumeToken
      )
      this.root.contextUsage.updateSettings(
        this.root.harnessUsage.settingsForEngineeringState(
          this.root.handleAgentEvent.engineeringLifecycle
        )
      )
      const stage = this.root.handleAgentEvent.engineeringLifecycle.activeStage
      const failureNote = current.failure?.trim()
        ? ` The previous attempt failed with: ${current.failure.trim()}`
        : ''
      if (stage === 'brainstorm') {
        // Retry always continues the same stage in the same conversation   the
        // agent has the full history, so never shortcut to the stale document.
        await this.root.handleAgentEvent.sendMessage(
          `Retry the persisted Brainstorm stage using the existing conversation and project context.${failureNote}`,
          [],
          undefined,
          true
        )
      } else if (stage === 'prd') {
        this.root.harnessUsage.prd = await invoke(
          'agent:generatePrd',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          this.root.loadOlderMessages.settings,
          `Retry the persisted PRD stage using the existing conversation, finalized Brainstorm, and project context.${failureNote}`,
          [],
          messageId()
        )
      } else if (stage === 'spec') {
        await this.root.harnessUsage.setActiveSpec(
          await invoke(
            'agent:ensureInitialSpec',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id
          )
        )
      } else if (stage === 'assignment') {
        await this.root.submitSpecDecision.generateAssignmentDraft()
      } else if (stage === 'achievement') {
        await this.root.handleAgentEvent.sendMessage(
          'Retry the persisted Achievement audit and rework stage from its durable artifacts.',
          [],
          'implement',
          true
        )
      }
      await this.reconcileReadySpec()
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The Engineering stage could not retry.'
      this.root.handleAgentEvent.engineeringLifecycle = await invoke(
        'engineeringLifecycle:get',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
    } finally {
      this.engineeringLifecycleRetrying = false
    }
  }

  /** Synthetic authentication issue raised by the thread-open auth probe, so
   *  the sign-in card can tell proactive (no retry) from failure-driven. */
  proactiveAuthIssue: AgentProviderIssue | null = $state(null)

  visibleProviderStatus = $derived.by<Extract<
    AgentSessionStatus,
    { state: 'waiting' | 'error' }
  > | null>(() => {
    if (
      this.root.props.controller?.status?.state === 'waiting' ||
      this.root.props.controller?.status?.state === 'error'
    ) {
      return this.root.props.controller.status
    }
    if (this.root.props.controller?.error) {
      return {
        state: 'error',
        issue: {
          kind: classifyProviderIssue(this.root.props.controller.error),
          message: this.root.props.controller.error,
          harnessId: this.root.loadOlderMessages.settings.harnessId,
          retryable: true
        }
      }
    }
    if (
      this.root.handleAgentEvent.providerStatus?.state === 'waiting' ||
      this.root.handleAgentEvent.providerStatus?.state === 'error'
    ) {
      return this.root.handleAgentEvent.providerStatus
    }
    if (!this.root.handleAgentEvent.errorMessage) return null
    return {
      state: 'error',
      issue: {
        kind: classifyProviderIssue(this.root.handleAgentEvent.errorMessage),
        message: this.root.handleAgentEvent.errorMessage,
        harnessId: this.root.loadOlderMessages.settings.harnessId,
        retryable: true
      }
    }
  })

  /** True while the visible provider card is the proactive sign-in card. */
  proactiveAuthVisible = $derived(
    this.proactiveAuthIssue !== null &&
      this.visibleProviderStatus !== null &&
      this.visibleProviderStatus.issue === this.proactiveAuthIssue
  )

  /** Harness that actually produced the visible provider issue. When it differs
   *  from the thread's current harness (e.g. a Codex usage-limit card still on
   *  screen while the user already switched the thread to OpenCode), the badge
   *  must attribute the card to the harness that reported it   never to the
   *  harness that happens to be selected now. */
  statusCardProviderName = $derived(
    this.visibleProviderStatus?.issue?.harnessId
      ? harnessDisplayName(this.visibleProviderStatus.issue.harnessId)
      : this.root.switchProject.providerName
  )

  spec = $state<EngineeringSpec | null>(null)

  brainstormWorkflow = $state<BrainstormWorkflowState | null>(null)

  brainstormEntryInFlight = $state<'brainstorm' | 'spec' | null>(null)

  brainstormDecisionInFlight = $state<BrainstormDecisionAction | null>(null)

  brainstormGenerationFailed = $state(false)

  activePlanningEntry = $derived(
    this.brainstormEntryInFlight ??
      (this.brainstormDecisionInFlight === 'review'
        ? 'brainstorm'
        : this.brainstormDecisionInFlight === 'finalize'
          ? 'spec'
          : null) ??
      (this.root.switchProject.busy && !this.root.editVideoNote.brainstorm && !this.spec
        ? (this.brainstormWorkflow?.entryChoice ?? null)
        : null)
  )

  assignmentWorkerRetryingId = $state<string | null>(null)

  assignmentWorkerReportingId = $state<string | null>(null)

  assignmentWorkerAttentionItems = $derived.by(() => {
    if (
      !this.root.submitSpecDecision.assignment ||
      this.root.submitSpecDecision.assignment.coordinatorThreadId !==
        this.root.handleAgentEvent.thread.id
    )
      return []
    return this.root.submitSpecDecision.assignment.content.tasks.flatMap((task) => {
      if (
        task.owner !== 'worker' ||
        task.status !== 'attention' ||
        task.report?.status !== 'failed' ||
        !task.threadId
      ) {
        return []
      }
      const worker = this.root.currentWorkingTraceAttribution.assignmentThreads.find(
        (candidate) => candidate.id === task.threadId
      )
      return worker ? [{ task, worker }] : []
    })
  })

  coordinatorErrorMatchesAssignmentWorker = $derived.by(() => {
    const status = this.visibleProviderStatus
    if (status?.state !== 'error') return false
    return this.assignmentWorkerAttentionItems.some(({ task }) =>
      this.providerIssueMatchesFailure(status.issue, task.report?.summary ?? '')
    )
  })

  plainEngineeringAuditAvailable = $derived(
    this.root.unmirroredTraceStartTime.studioOnlyAuditWorkflow &&
      (this.engineeringOn || this.root.unmirroredTraceStartTime.plainAuditTriggered) &&
      (this.spec?.status === 'approved' ||
        (!this.spec && this.brainstormWorkflow?.finalizedBrainstormVersion !== undefined)) &&
      (this.root.submitSpecDecision.auditState === 'offered' ||
        this.root.submitSpecDecision.auditState === 'running' ||
        this.root.submitSpecDecision.auditState === 'reworking' ||
        (this.root.submitSpecDecision.auditState === 'report_ready' &&
          this.root.contextUsage.auditReport !== null) ||
        (this.root.submitSpecDecision.auditState === undefined &&
          this.root.contextUsage.auditReport !== null))
  )

  /** Which coordinator, if any, this thread publishes to the context dock. */
  coordinatorKind = $derived.by((): 'assignment' | 'achievement' | 'audit' | null => {
    // A worker/auditor child presents the coordination it belongs to, so it can
    // show that board and carry the way back to it instead of dead-ending.
    if (this.root.currentWorkingTraceAttribution.orchestrationChild) {
      if (
        this.root.submitSpecDecision.assignment &&
        this.root.submitSpecDecision.assignment.status !== 'draft'
      )
        return 'assignment'
      const parent = this.root.currentWorkingTraceAttribution.coordinatorParentThread
      if (!parent) return null
      if (parent.assignmentId !== undefined || parent.assignmentRole === 'coordinator') {
        return 'assignment'
      }
      if (parent.settings?.loopMode === true || parent.achievementRole === 'coordinator') {
        return 'achievement'
      }
      if (parent.independentAudit === true) return 'audit'
      return null
    }
    if (
      this.root.submitSpecDecision.assignment &&
      this.root.submitSpecDecision.assignment.status !== 'draft'
    )
      return 'assignment'
    // A staged (not-yet-run) Independent Audit already docks its coordinator:
    // the sidebar appears the moment the switch is turned on, and clicking
    // "Run audit" there is what commits the choice durably.
    if (this.root.currentWorkingTraceAttribution.independentAuditDisplayEnabled) return 'audit'
    if (this.root.unmirroredTraceStartTime.achievementTriggered && this.spec) return 'achievement'
    if (this.plainEngineeringAuditAvailable) return 'audit'
    return null
  })

  achievementAutonomous = $derived(
    this.root.loadOlderMessages.settings.loopMode === true &&
      this.spec?.status === 'approved' &&
      !this.engineeringOn &&
      (this.root.loadOlderMessages.settings.assignmentMode !== true ||
        (this.root.submitSpecDecision.assignment !== null &&
          !['draft', 'stopped'].includes(this.root.submitSpecDecision.assignment.status)))
  )

  activityLabel = $derived.by((): string => {
    if (this.root.unmirroredTraceStartTime.loopAuditing) return 'Auditing'
    if (this.activePlanningEntry === 'brainstorm') return 'Researching and discussing'
    if (this.activePlanningEntry === 'spec') {
      return this.root.handleAgentEvent.providerStatus?.state === 'working'
        ? (this.root.handleAgentEvent.providerStatus.activity?.label ?? 'Formulating specification')
        : 'Formulating specification'
    }
    if (this.root.harnessUsage.specFormulating) return 'Formulating'
    if (this.root.composerScope.assignmentFormulating) return 'Formulating Assignment'
    if (!this.engineeringOn) return 'Working'
    switch (this.root.handleAgentEvent.thread.status) {
      case 'planning':
        return 'Planning'
      case 'executing':
        return 'Executing'
      default:
        return 'Working'
    }
  })

  readySpecReconcileInFlight: Promise<void> | null = $state(null)

  /** Fast path: settings and the mirrored transcript are plain disk reads. */
  latestUserMessageId(): string | undefined {
    for (let index = this.root.loadOlderMessages.messages.length - 1; index >= 0; index--) {
      if (this.root.loadOlderMessages.messages[index]?.role === 'user')
        return this.root.loadOlderMessages.messages[index].id
    }
    return undefined
  }

  /** Detect an expired Claude Code session at thread open so the user can sign
   *  in before their first message fails mid-turn. */
  async probeHarnessAuthentication(): Promise<void> {
    try {
      const authenticated = await invoke(
        'agent:getHarnessAuthStatus',
        this.root.handleAgentEvent.thread.projectId,
        this.root.loadOlderMessages.settings.harnessId,
        this.root.loadOlderMessages.settings.accountId
      )
      if (
        !this.root.loadOlderMessages.alive ||
        authenticated !== false ||
        this.root.handleAgentEvent.providerStatus !== null
      )
        return
      const issue: AgentProviderIssue = {
        kind: 'authentication',
        message: 'Claude Code sign-in expired. Sign in once to continue.',
        rawError: 'Claude Code could not authenticate with the stored credential.',
        harnessId: this.root.loadOlderMessages.settings.harnessId,
        retryable: true
      }
      this.proactiveAuthIssue = issue
      this.root.composerScope.setProviderError(issue)
    } catch {
      // Best-effort; a real authentication failure still surfaces at message time.
    }
  }

  composerStackSlots = $derived.by((): ComposerStackSlot[] => {
    const slots: ComposerStackSlot[] = []
    if (this.assignmentWorkerAttentionItems.length > 0) slots.push('worker')
    if (this.visibleProviderStatus !== null && !this.coordinatorErrorMatchesAssignmentWorker) {
      slots.push('provider')
    }
    if (this.root.unmirroredTraceStartTime.compactionInterruptedNotice !== '')
      slots.push('compaction')
    if (this.root.steerQueuedMessage.queuedCardVisible) slots.push('queued')
    if (this.root.unmirroredTraceStartTime.aiAccountPromptVisible) slots.push('account')
    if (this.root.props.assistantForeignRunThreadId) slots.push('foreign-run')
    if (this.root.sources.pendingImageDescriptorError !== null && !this.achievementAutonomous) {
      slots.push('image-descriptor')
    }
    // The recap card is not a stack card: it takes the composer's place, so it
    // never shares the bottom edge with the thing it is asking about.
    if (this.root.composerScope.visibleTodo !== null && !this.failureRetryVisible)
      slots.push('todo')
    return slots
  })

  async reconcileReadySpec(): Promise<void> {
    if (this.readySpecReconcileInFlight) return this.readySpecReconcileInFlight
    const reconcilePromise = this.reconcileReadySpecProvider()
    this.readySpecReconcileInFlight = reconcilePromise
    try {
      await reconcilePromise
    } finally {
      if (this.readySpecReconcileInFlight === reconcilePromise) {
        this.readySpecReconcileInFlight = null
      }
    }
  }

  async chooseBrainstormEntry(choice: 'brainstorm' | 'spec'): Promise<void> {
    if (this.root.harnessUsage.brainstormBusy) return
    this.root.harnessUsage.brainstormBusy = true
    this.brainstormEntryInFlight = choice
    this.brainstormGenerationFailed = false
    this.root.harnessUsage.brainstormError = ''
    const now = Date.now()
    this.brainstormWorkflow = {
      ...(this.brainstormWorkflow ?? {
        projectId: this.root.handleAgentEvent.thread.projectId,
        threadId: this.root.handleAgentEvent.thread.id,
        stage: 'choice_pending',
        updatedAt: now
      }),
      entryChoice: choice,
      stage: choice === 'brainstorm' ? 'drafting' : 'skipped',
      updatedAt: now
    }
    agentRuns.setBusy(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      true,
      this.latestUserMessageId()
    )
    try {
      await invoke(
        'agent:chooseBrainstormEntry',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        choice
      )
      await this.reconcileReadySpec()
      if (choice === 'spec') this.root.studioTemporaryChatContext.specReadyToolVisible = true
    } catch (error) {
      this.brainstormGenerationFailed = true
      this.root.harnessUsage.brainstormError =
        error instanceof Error ? error.message : 'The planning path could not be started.'
    } finally {
      this.root.harnessUsage.brainstormBusy = false
      this.brainstormEntryInFlight = null
      agentRuns.setIdle(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
    }
  }

  /** Abandon a failed planning attempt: clear the workflow choice so reconcile
   *  stops showing the retry prompt, and reset the thread out of the failed
   *  state so the conversation/composer is usable again. */
  async cancelBrainstormEntryRetry(): Promise<void> {
    this.brainstormGenerationFailed = false
    this.root.harnessUsage.brainstormError = ''
    this.root.handleAgentEvent.errorMessage = ''
    this.brainstormWorkflow = null
    try {
      await invoke(
        'brainstorm:resetWorkflow',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      await invoke(
        'thread:setStatus',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        'interrupted'
      )
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The planning retry could not be cancelled.'
    }
  }

  /** Revert an accidental engineering-mode send. The pending user message that
   *  triggered the "Plan your work" card is deleted from the thread, restored
   *  into the composer as a draft, and engineering mode is turned off so the
   *  message can be sent again as a normal chat message. */
  async revertEngineeringEntryChoice(): Promise<void> {
    if (this.root.switchProject.busy || this.root.harnessUsage.brainstormBusy) return
    const { projectId, id } = this.root.handleAgentEvent.thread
    const pendingId = this.latestUserMessageId()
    const pending = pendingId
      ? this.root.loadOlderMessages.messages.find((m) => m.id === pendingId)
      : undefined
    const draft = pending ? messageText(pending) : ''
    const attachments = pending
      ? pending.parts
          .filter((p): p is Extract<AgentPart, { type: 'file' }> => p.type === 'file')
          .map((p) => ({ mime: p.mime, url: p.url, filename: p.filename }))
      : []
    const projectReferences = pending?.projectReferences ?? []

    this.brainstormGenerationFailed = false
    this.root.harnessUsage.brainstormError = ''
    this.root.handleAgentEvent.errorMessage = ''
    this.brainstormWorkflow = null
    this.root.harnessUsage.brainstormBusy = true
    try {
      if (pendingId) {
        await threadMessages.truncate(projectId, id, pendingId)
      }
      await invoke('brainstorm:resetWorkflow', projectId, id)
      if (
        this.root.handleAgentEvent.engineeringLifecycle &&
        (this.root.handleAgentEvent.engineeringLifecycle.selection !== 'none' ||
          this.root.handleAgentEvent.engineeringLifecycle.activeStage !== undefined ||
          this.root.handleAgentEvent.engineeringLifecycle.humanGate !== undefined)
      ) {
        this.root.handleAgentEvent.engineeringLifecycle = await invoke(
          'engineeringLifecycle:cancel',
          projectId,
          id,
          true
        )
      }
      this.root.contextUsage.updateSettings(
        this.root.harnessUsage.settingsForEngineeringState(
          this.root.handleAgentEvent.engineeringLifecycle
        )
      )
      await invoke('thread:setStatus', projectId, id, 'created')
      if (draft || attachments.length > 0 || projectReferences.length > 0) {
        rendererRecovery.setDraft(projectId, id, draft, attachments, projectReferences)
        this.root.currentWorkingTraceAttribution.composerRestoreKey += 1
      }
      await this.reconcileReadySpec()
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error
          ? error.message
          : 'The engineering entry choice could not be reverted.'
    } finally {
      this.root.harnessUsage.brainstormBusy = false
    }
  }

  BRAINSTORM_REVIEW_ANCHOR_CONTEXT_LENGTH = 160

  brainstormReviewAnnotation(
    draft: BrainstormDocument,
    annotation: BrainstormDocument['annotations'][number]
  ): BrainstormReviewAnnotationManifest {
    const section = draft.content.sections.find((candidate) => candidate.id === annotation.section)
    const quote = annotation.quote?.trim() ?? ''
    const sectionLevel = Boolean(section && quote === section.title)
    const searchableText = sectionLevel ? (section?.title ?? '') : (section?.markdown ?? '')
    const occurrences = quote ? this.root.composerScope.quoteOccurrences(searchableText, quote) : []
    const preferredOffset = annotation.startOffset
    const locatedIndex =
      occurrences.length === 0
        ? undefined
        : occurrences.length === 1
          ? occurrences[0]
          : preferredOffset === undefined
            ? undefined
            : occurrences.reduce((nearest, candidate) =>
                Math.abs(candidate - preferredOffset) < Math.abs(nearest - preferredOffset)
                  ? candidate
                  : nearest
              )
    const located = locatedIndex !== undefined

    return {
      id: annotation.id,
      section: annotation.section,
      comment: annotation.body,
      exactQuote: quote,
      range: {
        startLine: annotation.startLine,
        endLine: annotation.endLine,
        startOffset: annotation.startOffset,
        endOffset: annotation.endOffset
      },
      surroundingText: located
        ? {
            before: searchableText.slice(
              Math.max(0, locatedIndex - this.BRAINSTORM_REVIEW_ANCHOR_CONTEXT_LENGTH),
              locatedIndex
            ),
            after: searchableText.slice(
              locatedIndex + quote.length,
              locatedIndex + quote.length + this.BRAINSTORM_REVIEW_ANCHOR_CONTEXT_LENGTH
            )
          }
        : { before: '', after: '' },
      occurrenceCount: occurrences.length,
      located
    }
  }

  async brainstormReviewDiscussionContext(
    draft: BrainstormDocument,
    notes: string,
    reviewChanges: BrainstormReviewChanges
  ): Promise<string> {
    const annotations = draft.annotations
      .filter((annotation) => annotation.status === 'open')
      .map((annotation) => this.brainstormReviewAnnotation(draft, annotation))
    const fallbackReasons: string[] = []
    if (annotations.some((annotation) => !annotation.located)) {
      fallbackReasons.push('one or more annotation anchors could not be located reliably')
    }
    if (reviewChanges.edits.some((edit) => edit.truncated)) {
      fallbackReasons.push('one or more edited fragments exceeded the compact payload limit')
    }
    if (!reviewChanges.baselineAvailable) {
      fallbackReasons.push('this legacy report does not retain its generated-content baseline')
    }
    if (annotations.length === 0 && reviewChanges.edits.length === 0) {
      fallbackReasons.push('the feedback has no local annotation or edit anchor')
    }
    if (this.root.unmirroredTraceStartTime.DOCUMENT_WIDE_REVIEW_PATTERN.test(notes)) {
      fallbackReasons.push('the reviewer requested document-wide reconsideration')
    }

    const manifest = {
      schemaVersion: 1,
      report: {
        id: draft.id,
        version: draft.version,
        contentHash: await this.root.unmirroredTraceStartTime.brainstormContentHash(draft),
        updatedAt: draft.updatedAt
      },
      annotations,
      edits: reviewChanges.edits,
      ...(fallbackReasons.length > 0
        ? {
            fullReportFallback: {
              reasons: fallbackReasons,
              ...this.root.composerScope.boundedBrainstormFallback(draft)
            }
          }
        : {})
    }

    return [
      'Continue the interactive Brainstorm discussion about this session report.',
      'Treat the review feedback as interview input. Build on the document, annotations, review text, and versioned alignment notes. Research relevant code and online sources, share concrete findings, and ask focused questions until the intended direction is clear. Save cumulative notes for the next Brainstorm version through the alignment-note utility. Once aligned, recap the direction and ask the application-supplied document-creation question. Only explicit user approval authorizes a new document; completing this discussion turn does not.',
      'The review manifest is authoritative for the report identity and content hash. Resolve annotations using their exact quote, range, and surrounding text together. If those anchors disagree, ask the reviewer instead of guessing. The edits are compact diffs from the agent-generated baseline. Do not ask for or reconstruct the full report when fullReportFallback is absent.',
      `<brainstorm-review-manifest>\n${JSON.stringify(manifest)}\n</brainstorm-review-manifest>`
    ].join('\n\n')
  }

  async submitBrainstormDecision(
    action: BrainstormDecisionAction,
    draft: BrainstormDocument,
    notes: string,
    reviewChanges: BrainstormReviewChanges = { baselineAvailable: false, edits: [] }
  ): Promise<void> {
    this.root.harnessUsage.brainstormError = ''
    this.root.submitSpecDecision.showSpecStudio = false
    if (action === 'review') {
      const feedback =
        notes.trim() ||
        'I want to continue discussing this Brainstorm before preparing the specification.'
      try {
        await this.root.handleAgentEvent.sendMessage(
          feedback,
          [],
          undefined,
          // A deliberate "Discuss" click must never fall into the queue-behind-
          // busy path: `busy` can still read stale-true for a moment right
          // after the previous turn (e.g. a prototype build) finishes, which
          // silently deferred the message with no feedback and made it look
          // like the click did nothing.
          true,
          await this.brainstormReviewDiscussionContext(draft, notes, reviewChanges),
          [],
          [],
          workflowActionPresentation('Review Brainstorm', notes)
        )
      } catch (error) {
        this.root.harnessUsage.brainstormError =
          error instanceof Error
            ? error.message
            : 'The Brainstorm discussion message failed to send.'
        this.root.handleAgentEvent.errorMessage = this.root.harnessUsage.brainstormError
        throw error
      }
      return
    }
    this.root.harnessUsage.brainstormBusy = true
    this.brainstormDecisionInFlight = action
    agentRuns.setBusy(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      true,
      this.latestUserMessageId()
    )
    try {
      const result = await invoke(
        'agent:finalizeBrainstorm',
        draft.projectId,
        draft.threadId,
        draft.id,
        draft.version,
        notes
      )
      this.root.handleAgentEvent.engineeringLifecycle = await invoke(
        'engineeringLifecycle:get',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      if (this.root.unmirroredTraceStartTime.isBrainstormDocument(result)) {
        this.root.editVideoNote.applyBrainstormDocument(result)
        await this.reconcileReadySpec()
        if (this.root.handleAgentEvent.engineeringLifecycle?.activeStage === 'prd') {
          await invoke(
            'prd:ensureWorkflow',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id
          )
          this.root.harnessUsage.prd = await invoke(
            'agent:generatePrd',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id,
            this.root.loadOlderMessages.settings,
            'Continue Run all by generating the PRD from the finalized Brainstorm and verified project context.',
            [],
            messageId()
          )
          this.root.harnessUsage.prdVersions = this.root.harnessUsage.prd
            ? [this.root.harnessUsage.prd]
            : []
          this.root.harnessUsage.selectedPrdVersion = this.root.harnessUsage.prd?.version ?? null
          this.root.handleAgentEvent.engineeringLifecycle = await invoke(
            'engineeringLifecycle:get',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id
          )
        }
        this.root.harnessUsage.studioDocument =
          this.root.handleAgentEvent.engineeringLifecycle?.activeStage === 'prd'
            ? 'prd'
            : 'brainstorm'
        this.root.submitSpecDecision.showSpecStudio = true
      } else {
        await this.reconcileReadySpec()
      }
    } catch (error) {
      this.root.harnessUsage.brainstormError =
        error instanceof Error ? error.message : `The Brainstorm ${action} action failed.`
      this.root.handleAgentEvent.errorMessage = this.root.harnessUsage.brainstormError
    } finally {
      this.root.harnessUsage.brainstormBusy = false
      this.brainstormDecisionInFlight = null
      agentRuns.setIdle(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
    }
  }

  providerIssueMatchesFailure(issue: AgentProviderIssue, failureSummary: string): boolean {
    const issueText = (issue.rawError ?? issue.message).trim()
    const summary = failureSummary.trim()
    return (
      summary === issueText ||
      summary === issue.message.trim() ||
      (issueText.length > 0 && summary.includes(issueText)) ||
      (summary.length > 0 && issueText.includes(summary))
    )
  }

  async retryAssignmentWorker(worker: Thread): Promise<void> {
    const current = this.root.submitSpecDecision.assignment
    if (!current || this.assignmentWorkerRetryingId) return
    const task = current.content.tasks.find((candidate) => candidate.threadId === worker.id)
    const clearBubbledCoordinatorError =
      this.visibleProviderStatus?.state === 'error' &&
      this.providerIssueMatchesFailure(
        this.visibleProviderStatus.issue,
        task?.report?.summary ?? ''
      )
    this.assignmentWorkerRetryingId = worker.id
    try {
      this.root.submitSpecDecision.assignment = await invoke(
        'agent:retryAssignmentWorker',
        current.projectId,
        current.coordinatorThreadId,
        worker.id
      )
      if (clearBubbledCoordinatorError) {
        this.root.handleAgentEvent.errorMessage = ''
        this.root.handleAgentEvent.providerStatus = null
      }
      await this.reconcileReadySpec()
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The worker could not be retried.'
    } finally {
      this.assignmentWorkerRetryingId = null
    }
  }

  /**
   * Ask the open not-reporting worker to hand its finished work back. The main
   * process switches reporting on and prompts the worker, so this mirrors the
   * setting locally: the composer control and this button reflect it at once
   * instead of waiting for the thread broadcast.
   */
  async reportWorkerToCoordinator(): Promise<void> {
    const current = this.root.submitSpecDecision.assignment
    if (!current || this.assignmentWorkerReportingId) return
    this.assignmentWorkerReportingId = this.root.handleAgentEvent.thread.id
    try {
      this.root.submitSpecDecision.assignment = await invoke(
        'agent:reportWorkerToCoordinator',
        current.projectId,
        current.coordinatorThreadId,
        this.root.handleAgentEvent.thread.id
      )
      this.root.contextUsage.updateSettings({
        ...this.root.loadOlderMessages.settings,
        reportToCoordinator: true
      })
      await this.reconcileReadySpec()
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The worker could not be asked to report.'
      throw error
    } finally {
      this.assignmentWorkerReportingId = null
    }
  }
}
