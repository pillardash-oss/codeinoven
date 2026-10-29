import { invoke } from '$lib/ipc.svelte'
import { ENGINEERING_SPEC_REQUEST_PROMPT } from '$shared/agent-tools'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import {
  assistantDisplayText,
  type AssistantPlanDraft
} from '$lib/components/assistant/assistant-view'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { conversationAttention } from '$lib/stores/conversation-attention.svelte'
import { revealFileInAppTree } from '$lib/reveal-file'
import { toast } from 'svelte-sonner'
import { reportError } from '$lib/stores/app-errors.svelte'
import { assistantDeliveryLabel, assistantPriorityLabel } from '$shared/assistant-reporting'
import { describeSchedule, isAssistantSetupThread, assistantIsScheduled } from '$shared/types'
import type {
  CapturableSpecContextType,
  EngineeringSpec,
  SpecSectionId,
  TurnCheckpointSummary
} from '$shared/types'
import {
  continuationRequestPrompt,
  pendingContinuationRequest,
  type PendingContinuationRequest
} from '$shared/pending-request'
import { LatestRequestGuard } from '$lib/refresh-guard'
import { resolvedSubagentPart } from '../thread-turn-parts'
import { HISTORY_WINDOW_SIZE } from '../thread-history'
import type { ThreadView } from './ThreadView-board.svelte'
import { SvelteSet } from 'svelte/reactivity'
/** One concern of the ThreadView board. */
export class ThreadViewAbortRun {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root) throw new Error('ThreadViewAbortRun read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
  }
  checkpoints = $state<TurnCheckpointSummary[]>([])

  /** True when a compaction message completed this turn and no answer followed. */
  turnSawCompaction = $state(false)

  turnSawAnswer = $state(false)

  /** Suppresses the "message not processed" notice after an intentional stop. */
  userRequestedStop = $state(false)

  /** Prevents duplicate manual retries while the paused provider turn is being replaced. */
  providerRetrying = $state(false)

  lastCheckpointThreadId = $state('')

  checkpointRefreshGuard = new LatestRequestGuard()

  specBusy = $state(false)

  specError = $state('')

  specStudioRetryable = $derived(
    !this.root.submitBrainstormDecision.spec &&
      !this.root.editVideoNote.brainstorm &&
      !this.root.submitSpecDecision.assignment &&
      !this.root.contextUsage.auditReport &&
      !this.root.switchProject.busy &&
      this.specError.trim().length > 0 &&
      this.root.studioTemporaryChatContext.hasFinalAgentResponse
  )

  locallySubmittedTurnAcknowledged = $state(false)

  acknowledgeLocalTurn(): void {
    if (this.root.buildSpecActionPrompt.locallySubmittedTurnId)
      this.locallySubmittedTurnAcknowledged = true
  }

  clearLocalTurn(): void {
    this.root.buildSpecActionPrompt.locallySubmittedTurnId = null
    this.locallySubmittedTurnAcknowledged = false
  }

  /** A live idle event owns the current turn only after live activity confirms it. */
  setIdleFromSession(): boolean {
    if (
      this.root.buildSpecActionPrompt.locallySubmittedTurnId &&
      !this.locallySubmittedTurnAcknowledged
    )
      return false
    if (
      agentRuns.activity(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      ) === 'brainstorm_report'
    )
      return false
    this.root.buildSpecActionPrompt.restoredBusy = false
    this.clearLocalTurn()
    agentRuns.setIdle(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
    return true
  }

  /**
   * An auto-compaction that ran during a user-initiated turn and was interrupted
   * (aborted summarizer) leaves opencode's run loop exited before answering the
   * user's message. Detect that end-state so we can surface a gentle notice.
   * Must be evaluated before `setIdleFromSession()` clears the local turn.
   */
  compactionInterrupted(): boolean {
    return (
      this.root.buildSpecActionPrompt.locallySubmittedTurnId !== null &&
      this.turnSawCompaction &&
      !this.turnSawAnswer &&
      !this.userRequestedStop
    )
  }

  /**
   * The request a retry re-sends: the unanswered request's text plus the files
   * it carried.
   *
   * A retry used to send a bare "Continue" and trust the harness session to
   * still hold the request the failed turn was answering. Nothing guarantees
   * that: a provider pause, an account change, or a replaced session leaves the
   * agent with a "Continue" and no request to continue, and the message reads
   * as delivered while the agent never saw it. Relaying the unanswered request
   * with the nudge makes the turn answerable on any session, and its
   * attachments ride along so a screenshotted request is not half delivered.
   */
  retryRequest(): PendingContinuationRequest | undefined {
    return pendingContinuationRequest(this.root.loadOlderMessages.messages)
  }

  /** Retry after an error or a paused provider retry   replace the live turn first. */
  async retryConnection(): Promise<void> {
    if (this.providerRetrying) return
    this.providerRetrying = true
    try {
      if (this.root.switchProject.busy) {
        this.userRequestedStop = true
        if (this.root.props.controller) {
          // Controller conversations (temporary chats) run on their own
          // conversation id   abort that, never the parent thread.
          await this.root.props.controller.abort()
          this.root.handleAgentEvent.providerStatus = null
        } else {
          await invoke(
            'agent:abort',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id
          )
          this.clearLocalTurn()
          agentRuns.setIdle(
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id
          )
          this.root.handleAgentEvent.providerStatus = null
        }
      }
      const request = this.retryRequest()
      await this.root.handleAgentEvent.sendMessage(
        request ? continuationRequestPrompt(request) : 'Continue',
        request?.attachments ?? [],
        undefined,
        true,
        undefined,
        request?.references ?? [],
        request?.projectReferences ?? [],
        { action: 'Retry connection' }
      )
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The connection could not be retried.'
    } finally {
      this.providerRetrying = false
    }
  }

  // ─── Agent event handling ────────────────────────────────────────────────

  refreshMessagesInFlight: Promise<void> | null = $state(null)

  async refreshMessages(): Promise<void> {
    if (this.refreshMessagesInFlight) return this.refreshMessagesInFlight
    if (this.root.props.controller) return

    const { projectId, id } = this.root.handleAgentEvent.thread
    const loadPromise = (async (): Promise<void> => {
      try {
        // Turn-aligned, additive merge. A raw tail page could land mid-turn and
        // leave the newest turn rendered as a working trace with its user
        // message still unloaded, and marking the thread loaded from that page
        // then skipped the aligned cold load on the next visit. The store owns
        // the alignment rule, so this path and the cold load cannot disagree
        // about where a turn begins. Assignment, never `||=`: an aligned result
        // that reached the start of the thread must be able to clear the flag.
        this.root.loadOlderMessages.olderMessagesAvailable =
          await threadMessages.mergeTurnAlignedTail(projectId, id, HISTORY_WINDOW_SIZE)
        if (!this.root.loadOlderMessages.alive) return
        this.syncOpenSubagentTabs()
      } catch {
        // Non-fatal   keep what we have
      }
    })()
    this.refreshMessagesInFlight = loadPromise

    try {
      await loadPromise
    } finally {
      if (this.refreshMessagesInFlight === loadPromise) {
        this.refreshMessagesInFlight = null
      }
    }
  }

  async refreshCheckpoints(): Promise<void> {
    const request = this.checkpointRefreshGuard.begin()
    const { projectId, id } = this.root.handleAgentEvent.thread
    try {
      if (this.lastCheckpointThreadId !== id) {
        this.lastCheckpointThreadId = id
        this.checkpoints = []
      }
      const nextCheckpoints = await invoke('checkpoint:list', projectId, id)
      if (!this.root.loadOlderMessages.alive || !this.checkpointRefreshGuard.isCurrent(request))
        return
      this.checkpoints = nextCheckpoints
    } catch {
      // Checkpoint history is supplementary; session recovery remains available.
    }
  }

  /**
   * Checkpoint completion is also the durable transcript-reconciliation
   * boundary. Refresh both halves so the checkpoint's source message id can
   * attach to the final rendered turn without waiting for a later remount.
   */
  async refreshCompletedTurn(): Promise<void> {
    const staleMessageRefresh = this.refreshMessagesInFlight
    const checkpointRefresh = this.refreshCheckpoints()
    void this.root.pollStreamParts.refreshStreamTailAfterTurn()
    if (staleMessageRefresh) await staleMessageRefresh
    await Promise.all([this.refreshMessages(), checkpointRefresh])
  }

  /** Stop the in-flight turn   wired to the composer's stop button and double Escape. */
  async abortRun(): Promise<void> {
    // A scheduled usage-reset retry leaves `busy` false (the session.status
    // 'waiting' handler marks the run idle so the working UI doesn't stick),
    // but the "Stop request" button on the provider card is shown for that
    // same state   so this must not bail out before invoking the abort.
    if (
      !this.root.switchProject.busy &&
      this.root.handleAgentEvent.providerStatus?.state !== 'waiting'
    )
      return
    const { projectId, id } = this.root.handleAgentEvent.thread
    this.userRequestedStop = true

    if (this.root.props.controller) {
      try {
        await this.root.props.controller.abort()
      } catch (error) {
        this.root.handleAgentEvent.errorMessage =
          error instanceof Error ? error.message : 'The request could not be stopped.'
      }
      // A stop is the user's own statement that the run is over, so this surface
      // has to agree with it immediately. Main writes `interrupted` without
      // broadcasting a session status, and a harness too wedged to answer an
      // abort never sends an idle of its own, so waiting for an event to clear
      // the run left the Stop control live forever and every later press did
      // nothing visible. Settling locally is what makes the stop observable.
      agentRuns.setIdle(
        this.root.props.controller.projectId,
        this.root.props.controller.conversationId
      )
      this.root.handleAgentEvent.providerStatus = null
      this.clearLocalTurn()
      return
    }

    try {
      await invoke('agent:abort', projectId, id)
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The request could not be stopped.'
    }
    // The user's stop has to be visible even when the abort itself failed: a
    // remote run that vanished mid-turn used to leave this stuck as working,
    // because the failure skipped the local settle below.
    this.clearLocalTurn()
    agentRuns.setIdle(projectId, id)
    this.root.handleAgentEvent.providerStatus = null
    void this.refreshMessages()
    void this.refreshCheckpoints()
  }

  /** The assistant this assistant thread is authoring, when it is one. */
  assistant = $derived(
    this.root.props.assistantId
      ? (assistants.assistants.find((entry) => entry.id === this.root.props.assistantId) ?? null)
      : null
  )

  /** Whether this thread is an assistant's Getting started thread: the authoring
   *  host while its knowledge is missing, and the editing host once it is saved. */
  assistantSetupThread = $derived(isAssistantSetupThread(this.root.handleAgentEvent.thread))

  /** Whether this assistant runs on a clock at all, its own task's override
   *  included, so the setup card states what the scheduler will actually do. */
  assistantScheduled = $derived(assistants.taskScheduled(this.root.handleAgentEvent.thread))

  /** The next fire a scheduled setup card counts down to, or null when nothing
   *  will fire (an on-demand assistant, a paused one, or no clock to read). */
  assistantSetupNextRunAt = $derived(
    this.assistant && this.assistantScheduled && !this.assistant.paused
      ? assistants.nextRunForTask(this.root.handleAgentEvent.thread)
      : null
  )

  assistantRunStarting = $state(false)

  /**
   * Run the assistant now from its setup card, ignoring the schedule, so the user
   * can see what they just built instead of waiting for the next fire. It runs
   * every task of the assistant, and the first fresh run is opened, since a run
   * happens on its own thread.
   */
  async runAssistantNow(): Promise<void> {
    const current = this.assistant
    if (!current || this.assistantRunStarting) return
    this.assistantRunStarting = true
    try {
      const runs = await assistants.runNow(current.id)
      toast.success(runs.length === 1 ? 'Run started' : `${runs.length} runs started`)
      const first = runs[0]
      if (!first) return
      const targetProject = await invoke('project:get', first.projectId).catch(() => null)
      workspaceState.openThreadInOwningView(first, targetProject)
    } catch (error) {
      reportError(error, 'Could not run the assistant')
    } finally {
      this.assistantRunStarting = false
    }
  }

  /**
   * Whether this conversation is authoring the assistant, so its text carries the
   * app's own draft payload: the knowledge block and the plan block. Both belong
   * to the recap card, so every text the transcript draws in this conversation is
   * filtered before it reaches the reader   the turn's closing statement and each
   * step of its working trace alike. A run thread of a saved assistant is not an
   * authoring conversation, so its text is never rewritten here.
   */
  assistantAuthoringThread = $derived(
    this.root.props.assistantMode &&
      (!this.root.props.assistantKnowledgeComplete || this.assistantSetupThread)
  )

  /** The trace's own output filter, or nothing when the text is plain conversation. */
  assistantAuthoringOutput = $derived(
    this.assistantAuthoringThread ? assistantDisplayText : undefined
  )

  /** The assistant's own connection labels, for the recap card's kept ones. */
  existingAssistantConnections = $derived(
    this.assistant?.connections.map((connection) => connection.label) ?? []
  )

  /**
   * Whether a knowledge draft is a change to the assistant that is already saved, so
   * the card offers a revision and never a second save of what is saved. Three
   * things disqualify a draft:
   *
   * - it sits on a thread that is not the assistant's Getting started thread;
   * - it is older than the saved knowledge, which is what a draft left in a reopened
   *   thread looks like after the knowledge was edited elsewhere;
   * - it changes nothing, either because the agent re-presented the same knowledge
   *   and the same plan, or because the save would patch no field differently.
   *   A plan-only change counts, because the knowledge text often does not carry the
   *   schedule at all.
   *
   * An assistant that predates the knowledge timestamp falls back to comparing content.
   */
  isAssistantRevision(
    draft: { knowledge: string; at: number },
    plan: AssistantPlanDraft | null
  ): boolean {
    if (!this.assistantSetupThread) return false
    const savedAt = this.assistant?.knowledgeUpdatedAt
    if (savedAt !== undefined && draft.at <= savedAt) return false
    if (!this.assistant) return true
    if (draft.knowledge.trim() !== this.assistant.knowledge.trim()) return true
    if (!plan) return false
    if (
      assistantIsScheduled(this.assistant) &&
      plan.schedule &&
      describeSchedule(plan.schedule) !== describeSchedule(this.assistant.schedule)
    ) {
      return true
    }
    if (plan.delivery && assistantDeliveryLabel(plan.delivery) !== this.currentDeliveryLabel())
      return true
    if (plan.priority && assistantPriorityLabel(plan.priority) !== this.currentPriorityLabel())
      return true
    const known = new SvelteSet(
      this.assistant.connections.map((connection) => connection.label.trim().toLowerCase())
    )
    return plan.connections.some((connection) => !known.has(connection.name.trim().toLowerCase()))
  }

  /** The saved delivery as the plan's own label, so the two compare. */
  currentDeliveryLabel(): string {
    const delivery = this.assistant?.delivery
    return delivery ? assistantDeliveryLabel(delivery) : ''
  }

  /** The saved urgency as the plan's own label, so the two compare. */
  currentPriorityLabel(): string {
    const priority = this.assistant?.priority
    return priority ? assistantPriorityLabel(priority) : ''
  }

  /**
   * Keep the assistant's primary in step with the model the user is working on
   * while the knowledge is still being written. The primary is the model that
   * triggers the knowledge, so a model switched in the composer before the first
   * turn must become the model the assistant runs on   a fresh install has no
   * last-used model for the create flow to default from. No-op once the knowledge
   * is saved, and no-op while the composer already matches the primary.
   */
  syncAssistantPrimaryToCurrentModel(): void {
    if (!this.root.props.assistantId || this.root.props.assistantKnowledgeComplete) return
    const current = this.root.loadOlderMessages.settings
    if (!current.modelId) return
    const primary = this.assistant?.agents?.primary
    if (
      primary &&
      primary.harnessId === current.harnessId &&
      primary.providerId === current.providerId &&
      primary.modelId === current.modelId
    ) {
      return
    }
    void assistants
      .updateAssistant(this.root.props.assistantId, {
        agents: {
          ...(this.assistant?.agents ?? { fallbacks: [] }),
          primary: {
            harnessId: current.harnessId,
            providerId: current.providerId,
            modelId: current.modelId,
            ...(current.accountId ? { accountId: current.accountId } : {}),
            ...(current.thinkingLevel ? { thinkingLevel: current.thinkingLevel } : {})
          }
        }
      })
      .catch(() => undefined)
  }

  // ─── Permissions ───────────────────────────────────────────────────────

  async allowPermissionOnce(requestId: string): Promise<void> {
    await invoke(
      'agent:replyPermission',
      this.root.handleAgentEvent.thread.projectId,
      requestId,
      'once'
    )
    this.resolvePendingPermission(requestId)
  }

  async allowPermissionAlways(requestId: string): Promise<void> {
    await invoke(
      'agent:replyPermission',
      this.root.handleAgentEvent.thread.projectId,
      requestId,
      'always'
    )
    this.resolvePendingPermission(requestId)
  }

  async rejectPermission(requestId: string): Promise<void> {
    await invoke(
      'agent:replyPermission',
      this.root.handleAgentEvent.thread.projectId,
      requestId,
      'reject'
    )
    this.resolvePendingPermission(requestId)
  }

  async providePermissionAlternative(requestId: string, alternative: string): Promise<void> {
    await invoke(
      'agent:replyPermission',
      this.root.handleAgentEvent.thread.projectId,
      requestId,
      'reject',
      alternative
    )
    this.resolvePendingPermission(requestId)
    // The engine commits the alternative straight into the side chat's own
    // transcript, so the view has to re-read it from there.
    if (this.root.props.controller) {
      await this.root.props.controller.load()
      return
    }
    await this.refreshMessages()
  }

  /**
   * Drop an answered request from whichever queue owns it: a controller-driven
   * conversation publishes through the shared attention store, threads keep the
   * queue in this view.
   */
  resolvePendingPermission(requestId: string): void {
    if (this.root.props.controller) {
      conversationAttention.resolve(
        this.root.props.controller.projectId,
        this.root.props.controller.conversationId,
        requestId
      )
      return
    }
    this.root.handleAgentEvent.pendingPermissions =
      this.root.handleAgentEvent.pendingPermissions.filter((request) => request.id !== requestId)
  }

  async undoCheckpoint(checkpoint: TurnCheckpointSummary): Promise<void> {
    const paths = checkpoint.changes
      .map((change) => change.path)
      .filter((path) => !checkpoint.rolledBackPaths?.includes(path))
    if (paths.length === 0) return
    try {
      this.checkpoints = await invoke(
        'checkpoint:rollbackPaths',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        checkpoint.id,
        paths
      )
      toast.success(
        `Restored ${paths.length} ${paths.length === 1 ? 'file' : 'files'} from this turn`
      )
    } catch (error) {
      reportError(error, 'This turn could not be undone safely.', {
        projectId: this.root.handleAgentEvent.thread.projectId,
        threadId: this.root.handleAgentEvent.thread.id
      })
    }
  }

  async redoCheckpoint(checkpoint: TurnCheckpointSummary): Promise<void> {
    const paths = checkpoint.rolledBackPaths ?? []
    if (paths.length === 0) return
    try {
      this.checkpoints = await invoke(
        'checkpoint:redoPaths',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        checkpoint.id,
        paths
      )
      toast.success(
        `Re-applied ${paths.length} ${paths.length === 1 ? 'file' : 'files'} from this turn`
      )
    } catch (error) {
      reportError(error, 'This turn could not be redone.', {
        projectId: this.root.handleAgentEvent.thread.projectId,
        threadId: this.root.handleAgentEvent.thread.id
      })
    }
  }

  async openSpecStudio(): Promise<void> {
    // The workspace already holds the active specification, with its versions and
    // its validation: opening is a visibility change, not a fetch. Asking main for
    // the same document again put two round trips in front of the first paint of a
    // studio whose module was already loaded.
    if (this.root.submitBrainstormDecision.spec) {
      workspaceState.specAgentSidebarOpen = false
      this.root.harnessUsage.studioDocument = 'spec'
      this.root.submitSpecDecision.showSpecStudio = true
      return
    }
    this.specBusy = true
    this.specError = ''
    try {
      let active = await invoke(
        'spec:getActive',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      if (!active) {
        if (this.root.switchProject.busy) {
          throw new Error(
            'The specification is being prepared and will appear when the agent finishes.'
          )
        }
        this.root.harnessUsage.specFormulating = true
        await this.root.handleAgentEvent.sendMessage(
          ENGINEERING_SPEC_REQUEST_PROMPT,
          [],
          'request',
          true,
          undefined,
          [],
          [],
          {
            action: 'Request spec'
          }
        )
        active = await invoke(
          'spec:getActive',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id
        )
      }
      if (!active) throw new Error('The specification agent did not produce a reviewable draft.')
      await this.root.harnessUsage.setActiveSpec(active)
      workspaceState.specAgentSidebarOpen = false
      this.root.harnessUsage.studioDocument = 'spec'
      this.root.submitSpecDecision.showSpecStudio = true
    } catch (error) {
      this.root.submitSpecDecision.showSpecStudio = false
      this.specError =
        error instanceof Error ? error.message : 'The specification could not be loaded.'
    } finally {
      this.root.harnessUsage.specFormulating = false
      this.specBusy = false
    }
  }

  reviewReadySpec(): void {
    void this.openSpecStudio()
  }

  async runSpecAction(action: () => Promise<EngineeringSpec>): Promise<EngineeringSpec | null> {
    this.specBusy = true
    this.specError = ''
    try {
      const updated = await action()
      await this.root.harnessUsage.setActiveSpec(updated)
      return updated
    } catch (error) {
      this.specError = error instanceof Error ? error.message : 'The specification action failed.'
      return null
    } finally {
      this.specBusy = false
    }
  }

  async saveSpec(edited: EngineeringSpec): Promise<EngineeringSpec | null> {
    this.specBusy = true
    this.specError = ''
    try {
      const saved =
        edited.status !== 'draft'
          ? await invoke(
              'spec:createVersion',
              this.root.handleAgentEvent.thread.projectId,
              this.root.handleAgentEvent.thread.id,
              edited.id,
              edited.content,
              {
                source: 'manual',
                actor: 'user'
              }
            )
          : await invoke(
              'spec:saveDraft',
              this.root.handleAgentEvent.thread.projectId,
              this.root.handleAgentEvent.thread.id,
              edited.id,
              edited.version,
              edited.content
            )
      await this.root.harnessUsage.setActiveSpec(saved)
      return saved
    } catch (error) {
      this.specError =
        error instanceof Error ? error.message : 'The specification could not be saved.'
      return null
    } finally {
      this.specBusy = false
    }
  }

  async openSpecInEditor(edited: EngineeringSpec): Promise<void> {
    this.specError = ''
    try {
      await invoke('spec:openInEditor', edited)
    } catch (error) {
      this.specError =
        error instanceof Error ? error.message : 'The specification could not be opened.'
    }
  }

  async revealSpecInAppFile(edited: EngineeringSpec): Promise<void> {
    this.specError = ''
    try {
      const absPath = await invoke('spec:revealInFiles', edited)
      await revealFileInAppTree(this.root.handleAgentEvent.thread.projectId, absPath)
    } catch (error) {
      this.specError =
        error instanceof Error ? error.message : 'The specification could not be revealed.'
    }
  }

  async addSpecContext(type: CapturableSpecContextType, selectedPath?: string): Promise<void> {
    const current = this.root.submitBrainstormDecision.spec
    if (!current) return
    this.specBusy = true
    this.specError = ''
    try {
      const updated = await invoke(
        'spec:captureContext',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        current.id,
        current.version,
        type,
        selectedPath
      )
      if (updated) await this.root.harnessUsage.setActiveSpec(updated)
    } catch (error) {
      this.specError =
        error instanceof Error ? error.message : 'Adding specification context failed.'
    } finally {
      this.specBusy = false
    }
  }

  addSpecAnnotation(
    section: SpecSectionId,
    body: string,
    anchor?: {
      quote: string
      startLine: number
      endLine: number
      startOffset: number
      endOffset: number
    }
  ): Promise<EngineeringSpec | null> {
    const current = this.root.submitBrainstormDecision.spec
    if (!current) return Promise.resolve(null)
    return this.runSpecAction(() =>
      invoke(
        'spec:addAnnotation',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        current.id,
        current.version,
        {
          section,
          body,
          author: 'user',
          ...anchor
        }
      )
    )
  }

  syncOpenSubagentTabs(): void {
    for (const message of this.root.loadOlderMessages.messages) {
      for (const part of message.parts) {
        if (part.type !== 'subagent') continue
        const resolved = resolvedSubagentPart(part, this.root.loadOlderMessages.messages)
        if (!resolved) continue
        contextSidebarState.updateSubagent(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          resolved.id,
          resolved.activity
        )
      }
    }
  }
}
