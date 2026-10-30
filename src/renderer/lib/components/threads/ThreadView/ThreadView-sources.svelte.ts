import { appendPartDelta } from '$shared/agent-part-merge'
import { SvelteSet } from 'svelte/reactivity'
import { temporaryChatContext } from '$lib/temporary-chat-context'
import { invoke } from '$lib/ipc.svelte'

import {
  initialSettingsFor,
  normalizeChatSettings,
  settingsStoreFor,
  type ModelScope
} from '$lib/stores/thread-settings.svelte'
import { contextSidebarState, EXPLAIN_SELECTION_PROMPT } from '$lib/stores/context-sidebar.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { modelKey, parseModelKey } from '$lib/model-keys'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { visionModels } from '$lib/stores/vision-models.svelte'
import { collectAgentSources, type AgentSource } from '$lib/agent-sources'
import { isAbsoluteCitationPath, normalizeCitationPath } from '$lib/agent-source-citations'
import { toPosixPath } from '$shared/paths'
import { revealFileInAppTree } from '$lib/reveal-file'
import { openPassageInNewThread } from '$lib/quoted-passage'
import { citationPathsState } from '$lib/stores/citation-paths.svelte'
import { toast } from 'svelte-sonner'
import { reportError } from '$lib/stores/app-errors.svelte'
import type {
  Thread,
  ThreadSettings,
  AgentPart,
  AgentDefaultsConfig,
  AgentModelSelection,
  AgentRole,
  AgentQuestion,
  SpecGenerationTraceUpdate,
  AssignmentGenerationTraceUpdate,
  AssignmentModelSelection,
  PendingAgentQuestionRequest,
  ImageDescriptorErrorRequest,
  ImageDescriptorReplyAction,
  AttachmentStorageScope
} from '$shared/types'
import { annotationAtPoint } from '$lib/selection-anchors'
import { isEditingTarget } from '$lib/selection-menu'
import {
  captureResponseSelection,
  type ResponseSelectionCandidate
} from '../thread-response-ranges'
import { messageText } from '../thread-message-presentation'
import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewSources extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  loaded = $derived(
    this.root.props.controller?.loaded ??
      threadMessages.loaded(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
  )

  /** True while a large first load is still revealing its tail in batches.
   *  Publishing a batch bumps this thread's revision, which is what re-runs the
   *  read; the pending-reveal set itself is plain state owned by the cache. */
  revealing = $derived.by(() => {
    const { projectId, id } = this.root.handleAgentEvent.thread
    threadMessages.streamRevision(projectId, id)
    return threadMessages.revealing(projectId, id)
  })

  // Intentional initial-value capture   the view is remounted (keyed) per thread.
  // For controller-driven conversations, the controller owns the settings proxy.
  /**
   * Which model memory this conversation belongs to: an assistant task, a
   * standalone chat, or a project thread. It decides the settings a thread
   * starts on, the store a change is committed to, and the model lists the
   * pickers show, so a model picked for one kind of conversation never reshapes
   * another kind's. Props, not state: the view is remounted (keyed) per thread.
   */
  modelScope(): ModelScope {
    if (this.root.props.assistantMode) return 'assistant'
    return this.root.props.chatMode ? 'chat' : 'project'
  }

  /** The settings a thread starts on: its own, else its family's model memory. */
  initialThreadSettings(source: Thread): ThreadSettings {
    const next = initialSettingsFor(this.modelScope(), source)
    return this.root.props.chatMode ? normalizeChatSettings(next) : next
  }

  agentDefaults = $state<AgentDefaultsConfig>({ syncFromThreadChanges: false })

  /** Commit to the model memory of this conversation's family, so a model picked
   *  for a chat or an assistant task never changes what another kind starts on. */
  commitSettings(next: ThreadSettings): void {
    settingsStoreFor(this.modelScope()).commit(next)
  }

  /** Keep Recent aligned with the model that actually starts a turn. Picker
   *  selections are recorded for instant feedback, but sends can use an
   *  inherited or otherwise preselected model without opening the picker. */
  recordModelUse(): void {
    if (
      !this.root.loadOlderMessages.settings.harnessId ||
      !this.root.loadOlderMessages.settings.providerId ||
      !this.root.loadOlderMessages.settings.modelId
    )
      return
    rendererRecovery.addModelRecentFor(
      this.modelScope(),
      modelKey(
        this.root.loadOlderMessages.settings.harnessId,
        this.root.loadOlderMessages.settings.providerId,
        this.root.loadOlderMessages.settings.modelId
      )
    )
  }

  pendingImageDescriptorError = $state<ImageDescriptorErrorRequest | null>(null)

  responseSelection = $state<ResponseSelectionCandidate | null>(null)

  /** Whether the selection menu is on screen. Read as a flag rather than as the
   *  candidate itself: the menu follows the text the user keeps highlighting, and
   *  a tracker keyed on the candidate would re-register on every keystroke of
   *  the selection instead of once while the menu is open. */
  selectionMenuOpen = $derived(Boolean(this.responseSelection))

  handleResponsePointerUp(): void {
    this.responseSelection = captureResponseSelection()
  }

  /**
   * The candidate a right-click opens for an annotation already on the chat.
   *
   * Right-clicking a highlighted passage is a request to work on that passage
   * again, so the candidate is rebuilt from the annotation rather than from the
   * document selection, which is collapsed when the user right-clicks without
   * selecting first.
   */
  referenceSelectionCandidate(
    referenceId: string,
    x: number,
    y: number
  ): ResponseSelectionCandidate | null {
    const reference = this.root.steerQueuedMessage.annotationReferences.find(
      (candidate) => candidate.id === referenceId
    )
    const range = this.root.steerQueuedMessage.responseReferenceRanges.get(referenceId)
    if (!reference || !range) return null
    if (
      reference.messageId === undefined ||
      reference.startOffset === undefined ||
      reference.endOffset === undefined
    )
      return null
    return {
      text: reference.text,
      messageId: reference.messageId,
      range,
      startOffset: reference.startOffset,
      endOffset: reference.endOffset,
      anchor: { x, y },
      referenceId
    }
  }

  /**
   * Take a right-click that landed in a response.
   *
   * The menu is the same one a highlight opens, at the cursor instead of beside
   * the selection, so the two ways of reaching a passage's actions are one
   * control. A passage the user has already commented on is offered that
   * comment's edit item, and the bubble itself opens only when the item is
   * chosen or the indicator is clicked: a right-click is a request for the
   * menu, so opening the bubble along with it would cover the actions the user
   * just asked for on every right-click of an annotated passage.
   */
  claimResponseSelectionMenu(event: MouseEvent): boolean {
    const target = event.target
    if (!(target instanceof Element)) return false
    if (!target.closest('[data-assistant-response]')) return false
    if (isEditingTarget(target)) return false
    // A link and an external-address control answer for themselves, so their
    // menu keeps the items that open them.
    if (target.closest('a, [data-external-url]')) return false
    const annotatedId = annotationAtPoint(
      this.root.steerQueuedMessage.responseReferenceRanges,
      event.clientX,
      event.clientY
    )
    const live = annotatedId
      ? this.referenceSelectionCandidate(annotatedId, event.clientX, event.clientY)
      : captureResponseSelection()
    if (!live) return false
    event.preventDefault()
    event.stopPropagation()
    this.responseSelection = live
    return true
  }

  closeResponseSelection(): void {
    this.responseSelection = null
    document.getSelection()?.removeAllRanges()
  }

  /**
   * What the menu's comment item does: write a comment on a fresh selection, or
   * reopen the one a passage already carries.
   */
  commentOnResponseSelection(): void {
    const selection = this.responseSelection
    if (!selection) return
    const referenceId = selection.referenceId
    if (referenceId) {
      this.closeResponseSelection()
      this.root.steerQueuedMessage.commentEditorReferenceId = referenceId
      return
    }
    this.root.steerQueuedMessage.addResponseReference()
  }

  temporaryConversationContext(): string {
    return temporaryChatContext(this.root.loadOlderMessages.messages, messageText)
  }

  openTemporarySelectionChat(mode: 'elaborate' | 'quick'): void {
    const selection = this.responseSelection
    if (!selection) return
    contextSidebarState.openTemporaryChat(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      mode,
      selection.text,
      this.temporaryConversationContext(),
      this.root.loadOlderMessages.settings,
      true,
      mode === 'elaborate' ? EXPLAIN_SELECTION_PROMPT : undefined
    )
    this.closeResponseSelection()
  }

  /** Open a quick chat anchored at the last agent turn   as if the user had
   *  selected the latest response, but with no selection attached so it works
   *  even while the agent is still working. */
  openQuickChatFromLastTurn(): void {
    contextSidebarState.openTemporaryChat(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      'quick',
      '',
      this.temporaryConversationContext(),
      this.root.loadOlderMessages.settings,
      false
    )
  }

  /** Spin the selection off into a brand-new thread in the same project, seeded
   *  as its composer draft. The same hand-off is offered for a passage of an
   *  annotated document, so both go through one implementation. */
  openSelectionInNewThread(): void {
    const selection = this.responseSelection
    if (!selection) return
    this.closeResponseSelection()
    openPassageInNewThread(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      selection.text
    )
  }

  specGenerationTraceParts = $state<AgentPart[]>([])

  specGenerationTraceActive = $state(false)

  specGenerationTraceStartedAt = $state<number | undefined>()

  assignmentGenerationTraceParts = $state<AgentPart[]>([])

  assignmentGenerationTraceActive = $state(false)

  assignmentGenerationTraceStartedAt = $state<number | undefined>()

  specTracePartStart(part: AgentPart): number | undefined {
    if (part.type === 'reasoning') return part.time?.start
    if (part.type === 'tool') return part.state.time?.start
    if (part.type === 'subagent') return part.activity.time?.start
    return undefined
  }

  clearSpecGenerationTrace(): void {
    this.specGenerationTraceParts = []
    this.specGenerationTraceStartedAt = undefined
    this.specGenerationTraceActive = false
  }

  clearAssignmentGenerationTrace(): void {
    this.assignmentGenerationTraceParts = []
    this.assignmentGenerationTraceStartedAt = undefined
    this.assignmentGenerationTraceActive = false
  }

  applySpecGenerationTrace(update: SpecGenerationTraceUpdate): void {
    if (update.type === 'started') {
      this.specGenerationTraceParts = []
      this.specGenerationTraceStartedAt = update.startedAt
      this.specGenerationTraceActive = true
      return
    }
    if (update.type === 'completed') {
      this.clearSpecGenerationTrace()
      return
    }
    if (update.type === 'part.updated') {
      if (!this.specGenerationTraceActive) {
        this.specGenerationTraceParts = []
        this.specGenerationTraceStartedAt = this.specTracePartStart(update.part) ?? Date.now()
        this.specGenerationTraceActive = true
      }
      const partIndex = this.specGenerationTraceParts.findIndex(
        (candidate) => candidate.id === update.part.id
      )
      this.specGenerationTraceParts =
        partIndex === -1
          ? [...this.specGenerationTraceParts, update.part]
          : this.specGenerationTraceParts.map((candidate, index) =>
              index === partIndex ? update.part : candidate
            )
      return
    }
    if (!this.specGenerationTraceActive) return
    this.specGenerationTraceParts = this.specGenerationTraceParts.map((part) =>
      part.id === update.partId ? appendPartDelta(part, update.field, update.delta) : part
    )
  }

  /** Live trace of the isolated Assignment draft offshoot   mirrors the spec
   *  generation trace so the coordinator thread always bubbles up offshoot
   *  sessions while they work. */
  applyAssignmentGenerationTrace(update: AssignmentGenerationTraceUpdate): void {
    if (update.type === 'started') {
      this.assignmentGenerationTraceParts = []
      this.assignmentGenerationTraceStartedAt = update.startedAt
      this.assignmentGenerationTraceActive = true
      return
    }
    if (update.type === 'completed') {
      this.clearAssignmentGenerationTrace()
      return
    }
    if (update.type === 'part.updated') {
      if (!this.assignmentGenerationTraceActive) {
        this.assignmentGenerationTraceParts = []
        this.assignmentGenerationTraceStartedAt = this.specTracePartStart(update.part) ?? Date.now()
        this.assignmentGenerationTraceActive = true
      }
      const partIndex = this.assignmentGenerationTraceParts.findIndex(
        (candidate) => candidate.id === update.part.id
      )
      this.assignmentGenerationTraceParts =
        partIndex === -1
          ? [...this.assignmentGenerationTraceParts, update.part]
          : this.assignmentGenerationTraceParts.map((candidate, index) =>
              index === partIndex ? update.part : candidate
            )
      return
    }
    if (!this.assignmentGenerationTraceActive) return
    this.assignmentGenerationTraceParts = this.assignmentGenerationTraceParts.map((part) =>
      part.id === update.partId ? appendPartDelta(part, update.field, update.delta) : part
    )
  }

  assignmentSeniorSettingsPersistence: Promise<void> = $state(Promise.resolve())

  auditSettingsForThread(): ThreadSettings {
    if (
      (this.root.handleAgentEvent.thread.assignmentId !== undefined &&
        this.root.handleAgentEvent.thread.coordinatorThreadId !== undefined &&
        this.root.handleAgentEvent.thread.assignmentRole === undefined) ||
      this.root.handleAgentEvent.thread.achievementRole === 'auditor'
    ) {
      return { ...this.root.loadOlderMessages.settings }
    }
    if (this.root.loadOlderMessages.settings.loopAuditor) {
      return {
        ...this.root.loadOlderMessages.settings,
        ...this.root.loadOlderMessages.settings.loopAuditor,
        loopMode: false
      }
    }
    const inheritedAuditor = rendererRecovery.auditModelKey
      ? parseModelKey(rendererRecovery.auditModelKey)
      : null
    if (inheritedAuditor) {
      return {
        ...this.root.loadOlderMessages.settings,
        ...inheritedAuditor,
        loopMode: false
      }
    }
    return this.agentDefaults.auditor
      ? { ...this.root.loadOlderMessages.settings, ...this.agentDefaults.auditor }
      : { ...this.root.loadOlderMessages.settings }
  }

  workerModelForThread(): AssignmentModelSelection {
    return {
      harnessId:
        this.agentDefaults.worker?.harnessId ?? this.root.loadOlderMessages.settings.harnessId,
      providerId:
        this.agentDefaults.worker?.providerId ?? this.root.loadOlderMessages.settings.providerId,
      modelId: this.agentDefaults.worker?.modelId ?? this.root.loadOlderMessages.settings.modelId,
      thinkingLevel: this.root.loadOlderMessages.settings.thinkingLevel,
      inferenceMode: this.agentDefaults.worker
        ? this.agentDefaults.worker.inferenceMode
        : this.root.loadOlderMessages.settings.inferenceMode,
      contextWindow: this.agentDefaults.worker
        ? this.agentDefaults.worker.contextWindow
        : this.root.loadOlderMessages.settings.contextWindow
    }
  }

  syncAgentRole(role: AgentRole, selection: AgentModelSelection): void {
    void invoke('config:syncAgentRole', role, selection)
      .then((config) => {
        if (!this.root.loadOlderMessages.alive) return
        this.agentDefaults = config.agentDefaults
      })
      .catch(() => undefined)
  }

  /**
   * Files uploaded to or produced in this chat   surfaced via the Sources panel.
   * File citations are only listed when confirmed to exist on disk. Citations
   * inside the project display with their project-relative path (the tail of
   * the path stays visible), while `path` itself is never rewritten so clicks
   * keep targeting the exact file.
   */
  sources = $derived.by((): AgentSource[] => {
    const projectPath = this.root.contextUsage.project?.path?.trim()
    return collectAgentSources(this.root.loadOlderMessages.messages)
      .filter((source) => {
        if (source.kind !== 'file-citation') return true
        return (
          citationPathsState.isValidPath(source.path) ||
          citationPathsState.isKnownExternalPath(source.path)
        )
      })
      .map((source) => {
        if (source.kind !== 'file-citation' || !source.path || !projectPath) return source
        const root = toPosixPath(projectPath).replace(/\/+$/u, '')
        if (isAbsoluteCitationPath(source.path)) {
          const target = normalizeCitationPath(source.path)
          const rootKey = normalizeCitationPath(root)
          if (!target.startsWith(`${rootKey}/`)) return source
          return {
            ...source,
            displayPath: target.slice(rootKey.length + 1),
            title: source.line ? `${source.path}:${source.line}` : source.path
          }
        }
        const fullPath = `${root}/${source.path}`
        return {
          ...source,
          path: fullPath,
          displayPath: source.path,
          title: source.line ? `${fullPath}:${source.line}` : fullPath
        }
      })
  })

  /** Rehydrate a pending image-descriptor error card after a renderer remount. */
  async refreshPendingImageDescriptorError(): Promise<void> {
    const { projectId, id } = this.root.handleAgentEvent.thread
    try {
      const pending = await invoke('agent:listImageDescriptorErrors', projectId, id)
      this.pendingImageDescriptorError = pending[0] ?? null
    } catch {
      // Non-fatal   the card re-appears on the next imageDescriptor.error event.
    }
  }

  /** Resolve a pending image-descriptor error card: retry with a (possibly new)
   *  vision model, or ignore and send whatever partial output exists onward.
   *  Dismissing always clears the card, even when the engine already settled the
   *  request, because the user must never be trapped behind a dead card. */
  async replyImageDescriptor(
    requestId: string,
    action: ImageDescriptorReplyAction,
    selection?: AgentModelSelection,
    imagePath?: string
  ): Promise<void> {
    const { projectId, id } = this.root.handleAgentEvent.thread
    if (action === 'ignore' && this.pendingImageDescriptorError?.id === requestId) {
      this.pendingImageDescriptorError = null
    }
    try {
      await invoke(
        'agent:replyImageDescriptor',
        projectId,
        id,
        requestId,
        action,
        selection,
        imagePath
      )
      if (this.pendingImageDescriptorError?.id === requestId)
        this.pendingImageDescriptorError = null
    } catch (error) {
      // A dismissal is a request to close the card, never a request the engine
      // must still hold: when the request is already settled the card closes
      // anyway, so a dead card can never become undismissable.
      if (action === 'ignore') {
        this.pendingImageDescriptorError = null
        return
      }
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The image descriptor could not be retried.'
      throw error
    }
  }

  /** Open the file picker for a replacement image on the vision error card and
   *  hand the chosen path to the descriptor, which retries the failed image
   *  with it. The picked file is retained in the thread's attachment scratch
   *  (project tmp for project threads), the same stable spot pasted images
   *  come from. */
  async pickImageDescriptorReplacement(requestId: string): Promise<void> {
    const { projectId, id } = this.root.handleAgentEvent.thread
    const scope: AttachmentStorageScope = {
      kind: this.root.props.chatMode ? 'chat' : 'project',
      projectId,
      threadId: id
    }
    const picked = await invoke('dialog:pickFile', scope)
    if (!picked) return
    await this.replyImageDescriptor(requestId, 'pick_image', undefined, picked)
  }

  /** Record the model executing the turn as vision-capable (the descriptor ran
   *  for it by mistake) and continue the blocked turn without a description. */
  async reportImageDescriptorFalsePositive(requestId: string): Promise<void> {
    const { projectId, id } = this.root.handleAgentEvent.thread
    const reportedModel = this.pendingImageDescriptorError?.requestingModel?.modelId
    try {
      await invoke('agent:replyImageDescriptor', projectId, id, requestId, 'false_positive')
      if (reportedModel) visionModels.markReported(reportedModel)
      this.pendingImageDescriptorError = null
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The vision report could not be saved.'
      throw error
    }
  }

  resolvedQuestionRequestIds = new SvelteSet<string>()

  updateAssignmentSeniorModel(selection: AssignmentModelSelection): void {
    const previousHarnessId = this.root.loadOlderMessages.settings.harnessId
    const previousProviderId = this.root.loadOlderMessages.settings.providerId
    const updated: ThreadSettings = {
      ...this.root.loadOlderMessages.settings,
      harnessId: selection.harnessId,
      providerId: selection.providerId,
      modelId: selection.modelId,
      thinkingLevel: selection.thinkingLevel,
      inferenceMode: selection.inferenceMode,
      contextWindow: selection.contextWindow
    }

    this.root.loadOlderMessages.settings = updated
    this.root.submitSpecDecision.assignmentError = ''
    if (previousHarnessId !== updated.harnessId || previousProviderId !== updated.providerId) {
      this.root.contextUsage.contextUsageDisplay = undefined
      this.root.contextUsage.accountUsageCache.markStale()
    }
    this.syncAgentRole('seniorEngineer', selection)
    this.commitSettings(updated)

    this.assignmentSeniorSettingsPersistence = this.assignmentSeniorSettingsPersistence
      .catch(() => undefined)
      .then(async () => {
        await invoke(
          'thread:updateSettings',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          updated
        )
      })
    void this.assignmentSeniorSettingsPersistence.catch((error) => {
      this.root.submitSpecDecision.assignmentError =
        error instanceof Error
          ? error.message
          : 'The Sr. Engineer model could not be saved to the task.'
    })
  }

  /** Persist the global image-descriptor default chosen from the composer card. */
  setImageDescriptorDefault(selection: AgentModelSelection): void {
    this.agentDefaults = { ...this.agentDefaults, imageDescriptor: selection }
    void invoke('config:update', { agentDefaults: this.agentDefaults }).catch(() => undefined)
  }

  // ─── Export conversation transcript (background, off the UI thread) ─────

  transcriptExportOpen = $state(false)

  openTranscriptExport(): void {
    this.transcriptExportOpen = true
  }

  /** Kick off the background export and surface its completion in a toast. */
  async exportTranscript(includeTrace: boolean): Promise<void> {
    const currentProjectId = this.root.handleAgentEvent.thread.projectId
    const currentThreadId = this.root.handleAgentEvent.thread.id
    this.transcriptExportOpen = false
    const progressToast = toast.loading('Exporting transcript in the background…')
    let exportedPath = ''
    try {
      const result = await invoke('thread:exportTranscript', currentProjectId, currentThreadId, {
        includeTrace
      })
      toast.dismiss(progressToast)
      if (!result) return
      exportedPath = result.path
      // Let a project transcript be revealed inside the app's file tree; chat
      // transcripts live outside any project, so reveal them in the OS.
      const onReview = (): void => {
        if (result.location === 'chat') {
          void invoke('shell:revealExternalPath', exportedPath).then((revealed) => {
            if (!revealed) {
              toast.error('The transcript could not be revealed in the file manager.')
            }
          })
          return
        }
        void revealFileInAppTree(currentProjectId, exportedPath)
      }
      toast.success('Transcript exported successfully', {
        description:
          result.location === 'chat'
            ? 'Stored in the temporary chat directory.'
            : 'Stored in your project’s .cio scratch space.',
        action: { label: 'Review transcript', onClick: onReview }
      })
    } catch (error) {
      toast.dismiss(progressToast)
      reportError(error, 'The transcript could not be exported.')
    }
  }

  /**
   * Persist the draft progress of one question card. The main process answers
   * `null` when the request already settled (it was answered, dismissed, timed
   * out, or retired with its session), so a save that lost that race closes the
   * stale card instead of reporting a failure for a card nobody can answer.
   */
  async handleQuestionUpdate(
    requestId: string,
    questionIndex: number,
    answers: string[],
    nextQuestionIndex?: number
  ): Promise<PendingAgentQuestionRequest | null> {
    const updated = await invoke(
      'agent:updateQuestion',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      requestId,
      questionIndex,
      answers,
      nextQuestionIndex
    )
    if (!updated) {
      this.resolvedQuestionRequestIds.add(requestId)
      this.root.handleAgentEvent.pendingQuestionRequests =
        this.root.handleAgentEvent.pendingQuestionRequests.filter(
          (request) => request.requestId !== requestId
        )
      return null
    }
    this.root.handleAgentEvent.pendingQuestionRequests =
      this.root.handleAgentEvent.pendingQuestionRequests.map((request) =>
        request.requestId === requestId ? updated : request
      )
    return updated
  }

  /** Open the explain side chat for a single agent question so the user can
   *  understand it (and its options) before answering. The card already pauses
   *  the question timeout; here we populate the chat and set a question-specific
   *  auto prompt. */
  handleQuestionExplain(requestId: string, question: AgentQuestion): void {
    contextSidebarState.openTemporaryChat(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      'elaborate',
      this.formatQuestionForTemporaryChat(question),
      this.temporaryConversationContext(),
      this.root.loadOlderMessages.settings,
      true,
      question.secretRequest ? this.EXPLAIN_SECRET_PROMPT : this.EXPLAIN_QUESTION_PROMPT,
      requestId
    )
  }

  /** Open a user-driven quick chat with the active agent question attached as
   *  its selection and the surrounding thread available as read-only context. */
  handleQuestionQuickChat(requestId: string, question: AgentQuestion): void {
    contextSidebarState.openTemporaryChat(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      'quick',
      this.formatQuestionForTemporaryChat(question),
      this.temporaryConversationContext(),
      this.root.loadOlderMessages.settings,
      true,
      undefined,
      requestId
    )
  }

  EXPLAIN_QUESTION_PROMPT =
    'Explain this question and all of its options clearly so the user can understand it and make a more informed decision. Base the explanation on the surrounding context. Use simple, everyday language and avoid unnecessary technical jargon unless it is truly needed. Be clear, concise, and neutral   do not recommend a specific answer. Do not perform any execution, make code changes, run tests, or do anything beyond: read-only explanation focused only on this question and its options.'

  EXPLAIN_SECRET_PROMPT =
    'Explain this secret request clearly so the user can understand what the agent needs, why it needs it, and where the user can obtain or create it, based on the surrounding context. Use simple, everyday language and avoid unnecessary technical jargon unless it is truly needed. Be clear, concise, and neutral: never invent, guess, or suggest an actual secret value, and do not recommend a specific provider or credential unless the context already names one. Do not perform any execution, make code changes, run tests, or do anything beyond: read-only explanation focused only on this secret request.'

  formatQuestionForTemporaryChat(question: AgentQuestion): string {
    const parts: string[] = []
    if (question.header) parts.push(`Question: ${question.header}`)
    if (question.prompt) parts.push(`Prompt: ${question.prompt}`)
    if (question.description) parts.push(`Description: ${question.description}`)
    if (question.secretRequest) {
      if (question.secretEnvironmentVariable) {
        parts.push(`Exposed to the agent as: ${question.secretEnvironmentVariable}`)
      }
      if (question.secretUtilityId) parts.push(`Bound to utility: ${question.secretUtilityId}`)
      parts.push(
        '(The user pastes the value; it is stored in the encrypted vault and is never sent to the model.)'
      )
    }
    if (question.richOptions && question.richOptions.length > 0) {
      parts.push(
        'Options:',
        ...question.richOptions.map((option) =>
          [
            `- ${option.label}`,
            option.description ? `  ${option.description}` : '',
            option.instruction ? `  Instruction the user must follow: ${option.instruction}` : '',
            option.recommended ? '  (recommended by the agent)' : ''
          ]
            .filter(Boolean)
            .join('\n')
        )
      )
    } else if (question.options && question.options.length > 0) {
      parts.push('Options:', ...question.options.map((option) => `- ${option}`))
    }
    if (question.multiple) parts.push('(The user may select more than one option.)')
    return parts.join('\n\n')
  }
}
