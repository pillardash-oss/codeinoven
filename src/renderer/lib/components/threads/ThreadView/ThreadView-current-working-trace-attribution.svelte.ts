import { tick } from 'svelte'
import { SvelteSet } from 'svelte/reactivity'
import type { OvenAppearance, OvenState } from '$shared/ovens'
import { LOCAL_OVEN_ID } from '$shared/ovens'
import {
  applyComposerRelocation,
  relocationNoun,
  type ComposerRelocationItem,
  type ComposerRelocationMode
} from '../../chats/composer-relocation'
import RichMarkdownEditor from '../../shared/RichMarkdownEditor.svelte'
import { speechController } from '../../../speech/speech-controller.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import {
  fastBaseModelId,
  fastVariantForModelId,
  normalizeFastInference,
  supportsFastInference
} from '$shared/fast-inference'
import { agentDisplayName } from '$lib/agent-icons/agent-display-name'
import { invoke } from '$lib/ipc.svelte'
import { resolveDefaultThinkingLevel } from '$shared/thinking-presets'
import {
  saveIndependentAuditIntent,
  clearIndependentAuditIntent
} from '$lib/stores/lifecycle-intent'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
import { modelRuntime } from '$lib/stores/model-runtime.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { openThreadById } from '$lib/threads/open-thread-by-id'
import { logRendererDev } from '$lib/system/renderer-logger'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { coordinatorDockState } from '$lib/stores/coordinator-dock.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { modelKey } from '$lib/model-keys'
import { catalogModelEntry, providerModel, resolveModelProvider } from '$shared/provider-identity'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'
import { markAttachmentFilenames } from '$lib/annotation-composite'
import { referencePromptContext } from '$lib/reference-prompt-context'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { toast } from 'svelte-sonner'
import { reportError } from '$lib/stores/app-errors.svelte'
import { isOrchestrationChildThread } from '$shared/types'
import type {
  Thread,
  ThreadSettings,
  AgentMessage,
  AgentPart,
  PromptAttachment,
  PromptProjectReference,
  AssignmentTask,
  AuditReport,
  HarnessAccount
} from '$shared/types'
import { messageText } from '../thread-message-presentation'
import { composerContextUsage } from '../thread-usage-merge'
import type { WorkingModelSelection } from './ThreadView-types'
import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewCurrentWorkingTraceAttribution extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  /** Staged (intent-only) Independent Audit toggle: turning the switch on
   *  stages the choice and docks the audit coordinator immediately. `null`
   *  means nothing is staged; `true`/`false` is the staged switch position.
   *  Clicking "Run audit" in the coordinator is what commits it durably. */
  pendingIndependentAudit = $state<boolean | null>(null)

  /** Sticky snapshot of the selection that started the live turn. Every working
   *  trace belongs to the module that produced it: composer controls may change
   *  the next-turn settings freely while a turn runs, but they must never
   *  re-label work that already happened. The snapshot is only overwritten when
   *  a new turn is actually sent   never cleared by waiting, error, or idle
   *  transitions   so resumed turns keep their original attribution. */
  liveWorkingSelection = $state<WorkingModelSelection | null>(null)

  harnessAccounts = $state.raw<HarnessAccount[]>([])

  rememberSelectedAccount(account: HarnessAccount): void {
    this.harnessAccounts = [
      account,
      ...this.harnessAccounts.filter((candidate) => candidate.id !== account.id)
    ]
  }

  /** Reactive provider catalog for this thread's project   seeded from the
   *  cache and kept current when the model picker lazily refreshes the store. */
  providers = $derived(
    providerCatalog.cached(this.root.handleAgentEvent.thread.projectId) ??
      providerCatalog.allCached()
  )

  captureLiveWorkingSelection(): void {
    this.liveWorkingSelection = {
      harnessId: this.root.loadOlderMessages.settings.harnessId,
      accountId: this.root.loadOlderMessages.settings.accountId,
      providerId: this.root.loadOlderMessages.settings.providerId,
      modelId: this.root.loadOlderMessages.settings.modelId,
      thinkingLevel: this.root.loadOlderMessages.settings.thinkingLevel
    }
  }

  ensureLiveWorkingSelection(): void {
    if (!this.liveWorkingSelection) this.captureLiveWorkingSelection()
  }

  /** Thinking levels derived from all provider model presets, deduplicated. */
  actionThinkingLevels = $derived.by(() => {
    const seen = new SvelteSet<string>()
    const levels: Array<{ id: string; label: string }> = []
    for (const provider of this.providers) {
      for (const model of provider.models) {
        for (const preset of model.thinkingPresets ?? []) {
          if (!seen.has(preset.id)) {
            seen.add(preset.id)
            levels.push({ id: preset.id, label: preset.label })
          }
        }
      }
    }
    const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    levels.sort((a, b) => {
      const ai = order.indexOf(a.id)
      const bi = order.indexOf(b.id)
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    })
    return levels
  })

  /**
   * The selected model's own properties, read through the shared runtime store
   * for the thread's account.
   *
   * Codex states a model's context windows per account (`codex debug models`
   * answers from that account's `CODEX_HOME`), so the account-agnostic catalog
   * cannot describe this thread: it carries whichever account was probed last,
   * which is how a thread whose account states a 500k window rendered a 272k
   * one. The store resolves the account's answer, and a stored window survives
   * only while that answer offers it.
   */
  modelRuntimeSelection = $derived({
    projectId: this.root.handleAgentEvent.thread.projectId,
    harnessId: this.root.loadOlderMessages.settings.harnessId,
    providerId: this.root.loadOlderMessages.settings.providerId,
    modelId: this.root.loadOlderMessages.settings.modelId,
    accountId: this.root.loadOlderMessages.settings.accountId
  })

  threadModel = $derived(
    modelRuntime.resolve(
      this.modelRuntimeSelection,
      this.providers,
      this.root.loadOlderMessages.settings.contextWindow
    )
  )

  /**
   * The window the meter must show: the account's own window for the selected
   * model. The harness-reported window stays the fallback for models whose
   * window the harness does not state.
   */
  configuredContextWindow = $derived(this.threadModel.contextWindow)

  composerUsage = $derived(
    composerContextUsage(
      this.root.contextUsage.contextUsageDisplay,
      // The coarse snapshot: `displayed` already recomputes at that cadence,
      // and the walk below is O(transcript) until it finds usage.
      this.root.loadOlderMessages.scanMessages,
      this.root.handleAgentEvent.thread.contextUsage,
      {
        harnessId: this.root.loadOlderMessages.settings.harnessId,
        providerId: this.root.loadOlderMessages.settings.providerId,
        contextWindow: this.configuredContextWindow
      }
    )
  )

  messageEditEditor = $state<RichMarkdownEditor>()

  messageEditSpeechTarget() {
    if (!this.editingMessageId) return null
    return (
      this.messageEditEditor?.speechEditorTarget(
        `message-edit-${this.root.handleAgentEvent.thread.id}-${this.editingMessageId}`
      ) ?? null
    )
  }

  assignmentThreads = $state<Thread[]>([])

  assignmentCoordinatorThread = $state<Thread | undefined>()

  /** The coordinator (Sr. Engineer) that owns the open thread when it is a
   *  worker or auditor child. Children are hidden from every thread list, so
   *  this view carries the way back to the parent itself. */
  coordinatorParentThread = $state<Thread | null>(null)

  assignmentFocusTaskId = $state<string | undefined>()

  /** Workers and auditors are orchestration internals driven by their
   *  coordinator: identical view, but they never enable engineering mode
   *  themselves, so the composer hides the toolbox and lifecycle actions. */
  orchestrationChild = $derived(isOrchestrationChildThread(this.root.handleAgentEvent.thread))

  /** The coordinator this view belongs to, when the open thread is a worker or
   *  auditor child. Null for every normal, user-facing thread. */
  coordinatorParentId = $derived(
    isOrchestrationChildThread(this.root.handleAgentEvent.thread)
      ? (this.root.handleAgentEvent.thread.coordinatorThreadId ?? null)
      : null
  )

  /** The open thread is a worker of this Assignment whose reporting the user
   *  switched off, so it can be asked to hand its finished work back now. */
  workerCanReportToCoordinator = $derived(
    this.coordinatorParentId !== null &&
      this.root.handleAgentEvent.thread.assignmentRole === 'worker' &&
      this.root.submitSpecDecision.assignment !== null &&
      this.root.submitSpecDecision.assignment.status !== 'draft' &&
      this.root.submitSpecDecision.assignment.status !== 'stopped' &&
      this.root.loadOlderMessages.settings.reportToCoordinator === false
  )

  /** Independent (spec-less) audit state. Never inherited by forks or new threads. */
  independentAuditEnabled = $derived(this.root.handleAgentEvent.thread.independentAudit === true)

  independentAuditInitialized = $derived(
    this.root.handleAgentEvent.thread.independentAuditInitialized === true
  )

  /** A staged toggle wins over the committed state, mirroring the Toolbox. */
  independentAuditDisplayEnabled = $derived(
    this.pendingIndependentAudit !== null
      ? this.pendingIndependentAudit
      : this.independentAuditEnabled
  )

  /**
   * Whether an independent audit is running, from every view that can act on
   * it. The coordinator's own board knows because it started the run; an
   * auditor's board (and the coordinator's board after navigating away and
   * back) knows from the auditor thread's live run, so the Stop control never
   * disappears just because the view that started the audit is gone.
   */
  independentAuditRunning = $derived.by(() => {
    if (!this.independentAuditPanelActive) return false
    if (this.root.submitSpecDecision.auditBusy) return true
    const auditor = this.independentAuditorChild
      ? this.root.handleAgentEvent.thread
      : this.root.contextUsage.durableAuditThread
    if (auditor?.status === 'executing') return true
    return this.independentAuditorChild && this.root.switchProject.busy
  })

  /**
   * Whether the composer must give way to the coordinated-thread card.
   *
   * A locked orchestration child refuses a user-origin turn in the engine, so a
   * composer shown there only collects a message and answers it with "This
   * Assignment task is locked. Return to its coordinator to continue" after the
   * user has typed. A running assignment worker is the exception: its own
   * conversation can steer the work in progress, and that is the one thing
   * typing there is for.
   */
  inputLockedForComposer = $derived.by(() => {
    const thread = this.root.handleAgentEvent.thread
    if (thread.userInputLocked !== true) return false
    if (thread.assignmentRole === 'coordinator') return false
    if (thread.assignmentRole === 'worker' && this.root.switchProject.busy) return false
    return true
  })

  /** Which coordinated thread the open view is, for the card that replaces the
   *  composer there. */
  coordinatedThreadKind = $derived<'worker' | 'auditor' | 'pawn'>(
    this.root.handleAgentEvent.thread.achievementRole === 'auditor'
      ? 'auditor'
      : this.root.handleAgentEvent.thread.assignmentRole === 'worker'
        ? 'worker'
        : 'pawn'
  )

  /** The Independent Audit coordinator is the board for a thread that audits
   *  itself, and for the auditor child that thread owns. */
  independentAuditPanelActive = $derived.by(() => {
    if (this.orchestrationChild) return this.coordinatorParentThread?.independentAudit === true
    return this.independentAuditDisplayEnabled
  })

  /** The open thread is the auditor child an independent-audit coordinator runs. */
  independentAuditorChild = $derived(
    this.orchestrationChild &&
      this.root.handleAgentEvent.thread.achievementRole === 'auditor' &&
      this.coordinatorParentThread?.independentAudit === true
  )

  /**
   * Whether the Assignment audit card belongs on the open thread.
   *
   * The card is the Assignment or Achievement auditor's own surface. An
   * independent (spec-less) audit owns a durable auditor child too, and that
   * child is not an Assignment auditor: rendering the card there put a second
   * copy of the same failure beside the thread's own error card, and its Retry
   * ran the Assignment/Engineering audit, which answered "An approved
   * Engineering implementation is required before audit" for a thread that has
   * its own independent auditor. The parent row is what tells the two apart and
   * it arrives with the thread reconcile, so an auditor whose parent is not
   * loaded yet is treated as independent and shows no card.
   */
  assignmentAuditorCardApplies = $derived.by(() => {
    const thread = this.root.handleAgentEvent.thread
    if (thread.assignmentId !== undefined) return true
    if (thread.achievementRole !== 'auditor') return false
    return (
      this.coordinatorParentThread !== null &&
      this.coordinatorParentThread.independentAudit !== true
    )
  })

  /** The switch only exists once the thread has work and no Engineering mode
   *  is on   a staged (intent-only) Toolbox selection counts as on, so the
   *  two controls can never be lit at the same time before a send commits
   *  either choice. Fresh threads and empty drafts never show it. */
  independentAuditAvailable = $derived(
    !this.root.props.chatMode &&
      !this.orchestrationChild &&
      !this.independentAuditInitialized &&
      !this.root.submitBrainstormDecision.engineeringOn &&
      (this.root.handleAgentEvent.thread.sessionId !== undefined ||
        (threadMessages.loaded(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id
        ) &&
          threadMessages.messages(
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id
          ).length > 0))
  )

  /** The coordinator row this view publishes under: a worker/auditor child
   *  publishes under its parent, so moving between children never swaps the
   *  sidebar tab. */
  coordinatorDockThreadId = $derived(
    this.coordinatorParentId ?? this.root.handleAgentEvent.thread.id
  )

  /** Resolves as soon as the session id exists; transcript and attention
   *  restoration continue independently and never block a new prompt. */
  sessionReady: Promise<string> = $state(Promise.resolve(''))

  /** Prevents a slower background reconnect from replacing the session chosen
   *  for a newly submitted prompt. */
  sessionBindingVersion = 0

  async ensureSessionReady(): Promise<string> {
    if (this.root.handleAgentEvent.sessionId) return this.root.handleAgentEvent.sessionId
    const { projectId, id } = this.root.handleAgentEvent.thread
    const bindingVersion = ++this.sessionBindingVersion
    const readySessionId = await invoke('agent:ensureSession', projectId, id)
    if (bindingVersion === this.sessionBindingVersion) {
      this.root.handleAgentEvent.sessionId = readySessionId
      threadMessages.setSessionId(projectId, id, readySessionId)
    }
    return readySessionId
  }

  composerRestoreKey = $state(0)

  /** Send or queue a message. When the agent is busy the text is queued and
   *  sent automatically once the agent finishes. The user can also Steer it
   *  immediately as an intervention, Edit it, or Delete it. */
  async prepareSessionForSend(): Promise<void> {
    // Let the mount-time lookup finish first so it cannot persist an older
    // harness session after this send-specific lookup.
    const { projectId, id } = this.root.handleAgentEvent.thread
    // A parked lifecycle (a circle has already started and completed) must not
    // be re-started by a plain send: the designated Next-step/Review/Implement
    // buttons own stage re-entry. A fresh selection (startedAt cleared by
    // select) may still start on send, because that is the user asking to run
    // the newly selected Engineering stage.
    const lifecycleStarted =
      this.root.handleAgentEvent.engineeringLifecycle !== null &&
      this.root.handleAgentEvent.engineeringLifecycle !== undefined &&
      this.root.handleAgentEvent.engineeringLifecycle.startedAt !== undefined
    if (
      this.root.handleAgentEvent.engineeringLifecycle?.selection !== undefined &&
      this.root.handleAgentEvent.engineeringLifecycle.selection !== 'none' &&
      this.root.handleAgentEvent.engineeringLifecycle.activeStage === undefined &&
      this.root.handleAgentEvent.engineeringLifecycle.humanGate === undefined &&
      !lifecycleStarted
    ) {
      const started = await invoke('engineeringLifecycle:start', projectId, id)
      this.root.handleAgentEvent.engineeringLifecycle = started.state
      if (started.state.activeStage === 'brainstorm' || started.state.activeStage === 'spec') {
        const workflow = await invoke('brainstorm:ensureWorkflow', projectId, id)
        if (!workflow.entryChoice) {
          await invoke(
            'brainstorm:chooseEntry',
            projectId,
            id,
            started.state.activeStage === 'brainstorm' ? 'brainstorm' : 'spec'
          )
        }
      } else if (started.state.activeStage === 'prd') {
        await invoke('prd:ensureWorkflow', projectId, id)
      }
    }
    await this.sessionReady
    const bindingVersion = ++this.sessionBindingVersion
    const readySessionId = await invoke(
      'agent:ensureSession',
      projectId,
      id,
      this.root.loadOlderMessages.settings.harnessId
    )
    if (bindingVersion !== this.sessionBindingVersion) return
    if (!this.root.loadOlderMessages.alive) return
    this.root.handleAgentEvent.sessionId = readySessionId
    this.sessionReady = Promise.resolve(readySessionId)
    threadMessages.setSessionId(projectId, id, readySessionId)
  }

  openAssignmentTask(task: AssignmentTask): void {
    if (task.owner === 'senior') {
      this.assignmentFocusTaskId = task.id
      void this.openAssignmentTaskThread(
        this.root.submitSpecDecision.assignment?.coordinatorThreadId ??
          this.root.handleAgentEvent.thread.id
      )
      return
    }
    if (task.threadId) {
      void this.openAssignmentTaskThread(task.threadId)
      return
    }
    // A task with no worker thread yet opens the Assignment document, which
    // belongs to the coordinator when this view is a worker or auditor child.
    if (this.openOwnerStudio('assignment')) return
    this.assignmentFocusTaskId = task.id
    workspaceState.specAgentSidebarOpen = false
    this.root.harnessUsage.studioDocument = 'assignment'
    this.root.submitSpecDecision.showSpecStudio = true
  }

  async openAssignmentTaskThread(threadId: string): Promise<void> {
    const linkedThread =
      threadId === this.root.handleAgentEvent.thread.id
        ? this.root.handleAgentEvent.thread
        : (this.assignmentThreads.find((candidate) => candidate.id === threadId) ??
          (await invoke('thread:get', this.root.handleAgentEvent.thread.projectId, threadId)))
    if (linkedThread) workspaceState.openThread(linkedThread, this.root.contextUsage.project)
  }

  /** The live thread a dispatched task currently runs in. A reassigned task
   *  points at its newest worker, so resolution needs no history; an unassigned
   *  or deleted thread resolves to nothing and its review badge stays inert. */
  resolveAssignmentTaskThread(threadId: string | undefined): Thread | undefined {
    if (!threadId) return undefined
    if (threadId === this.root.handleAgentEvent.thread.id) return this.root.handleAgentEvent.thread
    return (
      this.assignmentThreads.find((candidate) => candidate.id === threadId) ??
      (this.assignmentCoordinatorThread?.id === threadId
        ? this.assignmentCoordinatorThread
        : undefined)
    )
  }

  /** Leave a worker/auditor view for the coordinator that owns it. The child is
   *  hidden from every thread list, so this control is the way back.
   *
   * The coordinator is revealed by id rather than merely selected: selecting a
   * thread the current view cannot render left the shell exactly where it was, so
   * the button looked dead. The by-id route moves to the view that owns the
   * thread's family first, and reports a lookup that fails instead of swallowing
   * it.
   */
  openCoordinatorParent(): void {
    const parentId = this.coordinatorParentThread?.id ?? this.coordinatorParentId
    if (!parentId) return
    const projectId =
      this.coordinatorParentThread?.projectId ?? this.root.handleAgentEvent.thread.projectId
    void openThreadById(projectId, parentId)
  }

  /**
   * Studio surfaces belong to the thread that owns the work. From a worker or
   * auditor view the coordinator owns them, so the callback switches to that
   * thread rather than replacing the child's conversation with a document it
   * does not own. Returns false when this view already owns the Studio.
   */
  openOwnerStudio(documentKind: 'assignment' | 'audit'): boolean {
    const owner = this.coordinatorParentThread
    if (!owner || owner.id === this.root.handleAgentEvent.thread.id) return false
    workspaceState.openThreadStudio(owner, this.root.contextUsage.project, documentKind)
    return true
  }

  /** The composer chip a destination is being picked for, and which verb applies. */
  relocationRequest = $state<{
    item: ComposerRelocationItem
    mode: ComposerRelocationMode
  } | null>(null)

  /**
   * Carry the requested item to the chosen chat and land there with it.
   *
   * The request arrives as a value rather than being read from the state that
   * opened the picker: the palette closes the picker before it reports the pick,
   * and that close clears the request, so reading it here would always find
   * nothing and the carry would do nothing at all.
   *
   * The carry is a transaction: the destination is written and persisted first,
   * and only then does this composer give the item up, so a failure leaves every
   * draft exactly as it was and nothing is reported as moved. The composer is
   * remounted on the way out because it was drawn from the draft the move just
   * changed.
   */
  async commitComposerRelocation(
    request: { item: ComposerRelocationItem; mode: ComposerRelocationMode },
    target: Thread
  ): Promise<void> {
    if (this.relocationRequest !== null) this.relocationRequest = null
    const noun = relocationNoun(request.item)
    logRendererDev(
      `[relocation] commit ${request.mode} ${request.item.kind} ${this.root.handleAgentEvent.thread.id} -> ${target.id}`
    )
    try {
      await applyComposerRelocation({
        projectId: this.root.handleAgentEvent.thread.projectId,
        sourceThreadId: this.root.handleAgentEvent.thread.id,
        targetThreadId: target.id,
        item: request.item,
        mode: request.mode
      })
    } catch (error) {
      logRendererDev(
        `[relocation] failed: ${error instanceof Error ? error.message : String(error)}`
      )
      reportError(error, `Could not carry the ${noun} to that chat; nothing was changed.`)
      return
    }
    logRendererDev(`[relocation] carried ${noun} to ${target.id}`)
    toast.success(`${request.mode === 'copy' ? 'Copied' : 'Moved'} ${noun} to ${target.title}`)
    this.composerRestoreKey += 1
    const targetProject =
      this.root.contextUsage.project ??
      (await invoke('project:get', target.projectId).catch(() => null))
    workspaceState.openThreadInOwningView(target, targetProject)
  }

  /** Ultrafast requires an advertised native Codex tier. */
  ultrafastSupportedFor(harnessId: string, providerId: string, modelId: string): boolean {
    return (
      harnessId === 'codex' &&
      providerId === 'openai' &&
      this.providers.some(
        (provider) =>
          provider.harnessId === harnessId &&
          provider.id === providerId &&
          provider.models.some((model) => model.id === modelId && model.ultrafastSupported)
      )
    )
  }

  /** True when the selected model exposes a fast tier, per the live catalog. */
  fastSupportedFor(harnessId: string, providerId: string, modelId: string): boolean {
    const provider = this.providers.find(
      (candidate) => candidate.harnessId === harnessId && candidate.id === providerId
    )
    const model = provider?.models.find((candidate) => candidate.id === modelId)
    return supportsFastInference(harnessId, providerId, model?.fastSupported)
  }

  async changeAssignmentWorkerModel(worker: Thread, selected: ThreadSettings): Promise<void> {
    const normalized = normalizeFastInference(
      selected,
      selected.harnessId,
      selected.providerId,
      selected.modelId,
      this.fastSupportedFor(selected.harnessId, selected.providerId, selected.modelId),
      this.ultrafastSupportedFor(selected.harnessId, selected.providerId, selected.modelId)
    )
    try {
      const updatedWorker = await invoke(
        'thread:updateSettings',
        worker.projectId,
        worker.id,
        normalized
      )
      this.assignmentThreads = this.assignmentThreads.map((candidate) =>
        candidate.id === updatedWorker.id ? updatedWorker : candidate
      )
      scopeState.updateThread(updatedWorker)
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The worker model could not be updated.'
    }
  }

  async openDurableAuditWork(): Promise<void> {
    if (this.root.contextUsage.durableAuditThread) {
      workspaceState.openThread(
        this.root.contextUsage.durableAuditThread,
        this.root.contextUsage.project
      )
      return
    }
    coordinatorDockState.restore(
      this.root.handleAgentEvent.thread.projectId,
      this.coordinatorDockThreadId
    )
    contextSidebarState.openCoordinator(
      this.root.handleAgentEvent.thread.projectId,
      this.coordinatorDockThreadId,
      'Audit coordinator'
    )
  }

  async openCoordinatorAuditReport(
    report: AuditReport | null = this.root.contextUsage.auditReport
  ): Promise<void> {
    const coordinator =
      this.assignmentCoordinatorThread ??
      (this.root.handleAgentEvent.thread.coordinatorThreadId
        ? await invoke(
            'thread:get',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.coordinatorThreadId
          )
        : null)
    if (!coordinator) {
      this.root.handleAgentEvent.errorMessage = 'The coordinator could not be opened.'
      return
    }
    workspaceState.openThreadStudio(
      coordinator,
      this.root.contextUsage.project,
      'audit',
      undefined,
      report ? { reportId: report.id, version: report.version } : undefined
    )
  }

  /** Toggle the Independent Audit. Turning it on stages the choice: the audit
   *  coordinator docks into the sidebar right away, and engineering stages are
   *  excluded for this thread's lifetime once the first run starts. Turning it
   *  off discards the staging (or disables a committed audit that has not
   *  started its first run). Clicking "Run audit" in the coordinator commits. */
  async toggleIndependentAudit(enabled: boolean): Promise<void> {
    if (this.independentAuditInitialized) return
    if (enabled) {
      this.pendingIndependentAudit = true
      saveIndependentAuditIntent(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        true
      )
      return
    }
    if (this.independentAuditEnabled && this.pendingIndependentAudit === null) {
      // Committed (pre-init) audit: disable durably so Engineering unlocks.
      try {
        await invoke(
          'thread:setIndependentAudit',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          false
        )
      } catch (error) {
        reportError(error, 'The independent audit could not be changed.')
        return
      }
    }
    this.pendingIndependentAudit = null
    clearIndependentAuditIntent(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
  }

  changeSpecModel(selected: ThreadSettings): void {
    const normalized = normalizeFastInference(
      selected,
      selected.harnessId,
      selected.providerId,
      selected.modelId,
      this.fastSupportedFor(selected.harnessId, selected.providerId, selected.modelId),
      this.ultrafastSupportedFor(selected.harnessId, selected.providerId, selected.modelId)
    )
    rendererRecovery.addRecentModel(
      modelKey(normalized.harnessId, normalized.providerId, normalized.modelId)
    )
    this.root.contextUsage.updateSettings({
      ...this.root.loadOlderMessages.settings,
      ...normalized
    })
  }

  /** Switch the thread's text model from the provider-error card's picker.
   *  The card renders the thread's live settings, so this only has to apply the
   *  pick to the thread (which also updates the card's picker in place). */
  changeThreadModel(selected: ThreadSettings): void {
    const normalized = normalizeFastInference(
      selected,
      selected.harnessId,
      selected.providerId,
      selected.modelId,
      this.fastSupportedFor(selected.harnessId, selected.providerId, selected.modelId),
      this.ultrafastSupportedFor(selected.harnessId, selected.providerId, selected.modelId)
    )
    rendererRecovery.addRecentModel(
      modelKey(normalized.harnessId, normalized.providerId, normalized.modelId)
    )
    this.root.contextUsage.updateSettings({
      ...this.root.loadOlderMessages.settings,
      ...normalized
    })
  }

  editingMessageId = $state<string | null>(null)

  editingText = $state('')

  editingMessageAttachments = $state<PromptAttachment[]>([])

  editingMessageProjectReferences = $state<PromptProjectReference[]>([])

  /**
   * The references the edited message carried (a quoted response excerpt, a
   * picked design element, an annotated document passage, a note on a video
   * moment, a numbered mark on a picture).
   *
   * Editing replaces the turn the message started, so the edited message is
   * resent as the same request: its references and their comments travel with
   * it, exactly as they did the first time, instead of being dropped by the new
   * turn.
   */
  editingMessageReferences = $state<ResponseReferenceAnchor[]>([])

  /** Edit a user message in place   the bubble itself becomes editable. */
  editMessage(msg: AgentMessage): void {
    this.editingMessageId = msg.id
    this.editingText = messageText(msg)
    const references = msg.references ?? []
    this.editingMessageReferences = references
    // A mark's picture is composed at send time, so the copy this message's own
    // parts already hold is stale evidence: the resend draws it again from the
    // references. Keeping it would deliver the same picture twice and its marks
    // without the picture they were drawn on.
    const regenerated = new SvelteSet(markAttachmentFilenames(references))
    this.editingMessageAttachments = msg.parts
      .filter((p): p is Extract<AgentPart, { type: 'file' }> => p.type === 'file')
      .filter((p) => p.filename === undefined || !regenerated.has(p.filename))
      .map((p) => ({ mime: p.mime, url: p.url, filename: p.filename }))
    this.editingMessageProjectReferences = msg.projectReferences ?? []
    void tick().then(() => {
      document.querySelector<HTMLElement>(`#msg-${msg.id} [contenteditable]`)?.focus()
    })
  }

  cancelEdit(): void {
    this.editingMessageId = null
    this.editingText = ''
    this.editingMessageAttachments = []
    this.editingMessageProjectReferences = []
    this.editingMessageReferences = []
  }

  /**
   * Send the edited message with the currently selected model   history from
   * the edited message downwards is replaced by the new exchange.
   *
   * The edit is applied to the conversation before any IPC happens: the message
   * the reader is editing keeps its id, its position and its bubble, takes the
   * new words in the same publish, and the turn reads as working at that same
   * instant. Editing never removes the reader's own message from the screen,
   * not for a frame and not while the mirror is truncated and the session is
   * rebound. Everything slow (the truncation, the session) happens afterwards,
   * with the message already where it belongs.
   */
  async submitEditedMessage(msg: AgentMessage): Promise<void> {
    const text = this.editingText.trim()
    if (!text || this.root.switchProject.busy) return
    // A send that the view would silently refuse (a spec still formulating)
    // must not leave the edited bubble reading as working.
    if (this.root.harnessUsage.specFormulating) return
    const { projectId, id: threadId } = this.root.handleAgentEvent.thread
    const conversationId = this.root.props.controller?.conversationId ?? threadId
    const attachments = this.editingMessageAttachments
    const projectReferences = this.editingMessageProjectReferences
    // The references the message already carried are part of the request, not
    // decoration on the bubble: a resend that dropped them asked the agent a
    // different question, without the passages, comments and marks it had.
    const promptReferences = this.editingMessageReferences
    const promptContext = referencePromptContext(promptReferences)
    const controller = this.root.props.controller
    this.root.handleAgentEvent.errorMessage = ''
    // Leave edit mode with the new words already in the message: the bubble
    // goes from the editor to the edited text, never through the old text and
    // never through no message at all.
    this.editingMessageId = null
    this.editingText = ''
    this.editingMessageAttachments = []
    this.editingMessageProjectReferences = []
    this.editingMessageReferences = []
    threadMessages.beginEdit(
      projectId,
      conversationId,
      msg.id,
      text,
      attachments,
      projectReferences,
      promptReferences
    )
    // The turn is running from this instant: the working state, its clock and
    // the tail follow are all armed synchronously, before the truncation and
    // the session binding the backend still has to do.
    this.root.buildSpecActionPrompt.beginLocalTurn(msg.id)
    agentRuns.setBusy(projectId, conversationId, true, msg.id)
    agentRuns.beginDispatch(projectId, conversationId)
    // The edited message is the tail now, so the reader lands on it and keeps
    // following the turn it starts.
    this.root.loadOlderMessages.scrollToLatest()
    speechController.observeSent(`message-edit-${threadId}-${msg.id}`, text)
    // A controller-driven conversation (a side chat) keeps its references on the
    // conversation and sends those, so the edited message's references are
    // re-attached there before the resend reads them. Their comments ride along
    // for the same reason they exist: the comment is the part the agent has to
    // answer.
    if (controller?.addSelection) {
      controller.clearReferences?.()
      for (const reference of promptReferences) {
        const referenceId = controller.addSelection({
          text: reference.text,
          ...(reference.messageId === undefined ? {} : { messageId: reference.messageId }),
          ...(reference.startOffset === undefined ? {} : { startOffset: reference.startOffset }),
          ...(reference.endOffset === undefined ? {} : { endOffset: reference.endOffset })
        })
        if (referenceId && reference.comment) {
          controller.updateReferenceComment?.(referenceId, reference.comment)
        }
      }
    }
    try {
      if (controller?.truncateBefore) {
        // Controller-driven conversations (temporary chats) truncate against
        // their own backend and keep the message the edit rewrote.
        const edited = threadMessages
          .messages(projectId, conversationId)
          .find((message) => message.id === msg.id)
        await controller.truncateBefore(msg.id, edited)
      } else {
        await threadMessages.truncateForEdit(projectId, threadId, msg.id)
        // Truncation discarded the harness session   bind to the fresh one so
        // the resend's streamed events are not filtered out.
        await this.prepareSessionForSend()
      }
    } catch (error) {
      agentRuns.setIdle(projectId, conversationId)
      this.root.abortRun.clearLocalTurn()
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The message could not be edited.'
      return
    }
    // Direct: the edit replaces the running history, so it must dispatch now
    // instead of parking behind a turn whose history it just replaced. The
    // message keeps its id, so the send rewrites that row rather than
    // appending a second copy of the same prompt.
    await this.root.handleAgentEvent.sendMessage(
      text,
      attachments,
      undefined,
      true,
      promptContext,
      promptReferences,
      projectReferences,
      undefined,
      [],
      false,
      [],
      msg.id
    )
  }

  // ─── Message attribution (model + harness) ────────────────────────────

  allModels = $derived(this.providers.flatMap((p) => p.models))

  /** Display name of the thread's selected model, or null when none is set. */
  centeredModelName = $derived.by(() => {
    const settings = this.root.loadOlderMessages.settings
    if (!settings.modelId) return null
    const model = catalogModelEntry(this.allModels, {
      providerId: settings.providerId,
      modelId: settings.modelId
    })
    return model?.name ?? settings.modelId
  })

  /**
   * The in-progress assistant message may not have received its model metadata
   * yet. Use the selection that was sent to the harness until the live turn is
   * finished, then let the persisted message attribution take over.
   */
  currentWorkingTraceAttribution = $derived.by(() => {
    const selection = this.liveWorkingSelection ?? this.root.loadOlderMessages.settings
    const modelId = selection.modelId
    const baseModelId = fastBaseModelId(modelId)
    // The provider is resolved once, by harness and id, and the model is then
    // read from that provider: picking either by model id alone answered with
    // another provider's name and mark when one model is offered by several.
    const provider = resolveModelProvider(this.providers, {
      providerId: selection.providerId,
      harnessId: selection.harnessId,
      modelId
    })
    const model =
      providerModel(provider, modelId) ??
      providerModel(provider, baseModelId) ??
      catalogModelEntry(this.allModels, { providerId: selection.providerId, modelId }) ??
      catalogModelEntry(this.allModels, {
        providerId: selection.providerId,
        modelId: baseModelId
      })
    const thinkingPresets = model?.thinkingPresets ?? []

    return {
      modelLabel: modelId
        ? (model?.name ?? fastVariantForModelId(modelId)?.label ?? modelId)
        : null,
      thinkingLevel:
        thinkingPresets.length > 0
          ? (resolveDefaultThinkingLevel(thinkingPresets, undefined, selection.thinkingLevel) ??
            null)
          : null,
      providerName: provider?.name ?? null,
      providerId: provider?.id ?? null,
      harnessId: selection.harnessId || null,
      harnessName: selection.harnessId ? agentDisplayName(selection.harnessId) : null,
      accountLabel:
        this.harnessAccounts.find(
          (account) =>
            account.id === selection.accountId && account.providerId === selection.providerId
        )?.label ?? null,
      accountId: selection.accountId ?? null,
      ovenLabel: this.ovenLabelForId(this.root.loadOlderMessages.settings.ovenId),
      ovenIsLocal:
        !this.root.loadOlderMessages.settings.ovenId ||
        this.root.loadOlderMessages.settings.ovenId === LOCAL_OVEN_ID,
      ovenAppearance: this.ovenAppearanceForId(this.root.loadOlderMessages.settings.ovenId),
      isFast: fastVariantForModelId(modelId) !== null
    }
  })

  ovensForAttribution = $state.raw<OvenState | null>(null)

  ovenLabelForId(id?: string | null): string {
    const ovenId = id ?? LOCAL_OVEN_ID
    return (
      this.ovensForAttribution?.ovens.find((oven) => oven.id === ovenId)?.name ??
      (ovenId === LOCAL_OVEN_ID ? 'Local' : 'Oven')
    )
  }

  ovenAppearanceForId(id?: string | null): OvenAppearance {
    const ovenId = id ?? LOCAL_OVEN_ID
    const oven = this.ovensForAttribution?.ovens.find((candidate) => candidate.id === ovenId)
    return oven
      ? {
          icon: oven.icon,
          color: oven.color,
          ...(oven.customSvg ? { customSvg: oven.customSvg } : {})
        }
      : { icon: 'cpu', color: '#6b7280' }
  }
}
