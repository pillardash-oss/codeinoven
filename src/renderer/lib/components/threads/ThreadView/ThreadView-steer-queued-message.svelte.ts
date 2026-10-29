import { tick } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import { messageId } from '$shared/id'
import {
  rendererRecovery,
  type StartAfterThreadReference
} from '$lib/stores/renderer-recovery.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { claimQueuedMessage, releaseQueuedMessage } from '$lib/stores/queued-message-claim'
import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
import {
  isResponseSelection,
  responseReferencesState,
  type ResponseReferenceAnchor
} from '$lib/stores/response-references.svelte'
import type {
  Thread,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  UserMessagePresentation
} from '$shared/types'
import type { SendPayload } from '../ConversationController.svelte'
import {
  applyAnnotationHighlights,
  measureAnnotationBubbles,
  withUnmeasuredAnchors,
  type AnnotationBubblePosition
} from '$lib/selection-anchors'
import {
  responseRangeFor,
  responseRangeIsCurrent,
  RESPONSE_HIGHLIGHT_NAME
} from '../thread-response-ranges'
import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewSteerQueuedMessage extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  responseReferences = $derived(
    responseReferencesState.forThread(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
  )

  /**
   * The selections this conversation draws on screen.
   *
   * A thread keeps them in its own store; a side chat owns no Thread row, so its
   * controller keeps them on its tab. Both describe a passage, its comment and
   * the range it came from, which is everything the highlight, the bubble and
   * the comment editor need, so the surface is the same for either.
   */
  annotationReferences = $derived(
    this.root.props.controller?.references
      ? [...this.root.props.controller.references]
      : this.responseReferences
  )

  responseReferenceRanges = new SvelteMap<string, Range>()

  /** Viewport position for the comment bubble of each reference anchor. Every
   *  live reference has an entry, so a comment whose highlight cannot be
   *  measured still has an anchor its editor can open at. */
  responseBubblePositions = $state<Record<string, AnnotationBubblePosition>>({})

  commentEditorReferenceId = $state<string | null>(null)

  /** Republish the live annotation ranges to the CSS Custom Highlight registry. */
  refreshResponseHighlights(): void {
    applyAnnotationHighlights(
      this.responseReferenceRanges,
      this.root.unmirroredTraceStartTime.responseHighlightOwner,
      RESPONSE_HIGHLIGHT_NAME
    )
  }

  /** Re-measure where each annotation's comment bubble belongs in the viewport. */
  updateResponseBubblePositions(): void {
    // Nothing annotated (and nothing measured): skip the forced layout that
    // reading every range rect costs, so the common conversation pays nothing.
    if (
      this.responseReferenceRanges.size === 0 &&
      Object.keys(this.responseBubblePositions).length === 0
    )
      return
    this.responseBubblePositions = withUnmeasuredAnchors(
      measureAnnotationBubbles(this.root.loadOlderMessages.scrollEl, this.responseReferenceRanges),
      this.annotationReferences.map((reference) => reference.id),
      this.root.studioTemporaryChatContext.responseAnchorFallback
    )
  }

  responseBubblePositionFrame = 0

  /** Frame handle and budget for the bounded retry that rebuilds a range whose
   *  anchor has not mounted yet (see `syncResponseHighlights`). */
  responseRangeRetryFrame = 0

  scheduleResponseBubbleUpdate(): void {
    if (this.responseBubblePositionFrame) return
    this.responseBubblePositionFrame = requestAnimationFrame(() => {
      this.responseBubblePositionFrame = 0
      this.updateResponseBubblePositions()
    })
  }

  /**
   * Bring the live annotation ranges back in line with the conversation DOM.
   *
   * This is deliberately not a one-shot restore. An annotation is anchored to a
   * character range inside `[data-assistant-response]`, and that element is not
   * stable across a view's life: the newest answer renders inside the working
   * trace while the conversation reads as busy and only moves into its
   * final-answer block once the run settles, the mounted history window grows
   * after the first paint, and every publish re-renders message blocks. A range
   * built before any of those points at nodes that are gone, which paints no
   * highlight and measures no bubble.
   *
   * Only ranges that actually went stale are rebuilt (see
   * `responseRangeIsCurrent`), so this stays cheap enough to run on every
   * conversation publish.
   */
  syncResponseHighlights(references: ResponseReferenceAnchor[]): void {
    const missing = this.rebuildResponseRanges(references)
    this.scheduleResponseBubbleUpdate()
    // A rebuild can miss for a single frame while the anchor mounts: a history
    // window that has just been merged, or the newest answer leaving the
    // working trace for its final-answer block. Retrying a bounded number of
    // frames turns "the comment is gone for good" into "the comment arrives a
    // frame late", and stops the moment every reference has its range.
    if (missing === 0 || this.root.unmirroredTraceStartTime.responseRangeRetriesLeft === 0) return
    if (this.responseRangeRetryFrame) return
    this.root.unmirroredTraceStartTime.responseRangeRetriesLeft -= 1
    this.responseRangeRetryFrame = requestAnimationFrame(() => {
      this.responseRangeRetryFrame = 0
      if (!this.root.loadOlderMessages.alive) return
      if (this.rebuildResponseRanges(references) === 0) this.scheduleResponseBubbleUpdate()
    })
  }

  /** Rebuild every stale range from the conversation DOM, and report how many
   *  references still have no range once the pass is over. */
  rebuildResponseRanges(references: ResponseReferenceAnchor[]): number {
    let changed = false
    let missing = 0
    const liveIds = references.map((reference) => reference.id)
    for (const reference of references) {
      const existing = this.responseReferenceRanges.get(reference.id)
      if (responseRangeIsCurrent(existing, reference)) continue
      const range = responseRangeFor(this.root.loadOlderMessages.scrollEl, reference)
      if (range) {
        this.responseReferenceRanges.set(reference.id, range)
        changed = true
      } else {
        missing += 1
        if (existing) {
          this.responseReferenceRanges.delete(reference.id)
          changed = true
        }
      }
    }
    // A detached selection is no longer part of the chat component.
    for (const id of [...this.responseReferenceRanges.keys()]) {
      if (liveIds.includes(id)) continue
      this.responseReferenceRanges.delete(id)
      changed = true
    }
    if (changed) this.refreshResponseHighlights()
    return missing
  }

  scheduleResponseHighlightRestore(references: ResponseReferenceAnchor[]): void {
    void tick().then(() => {
      if (!this.root.loadOlderMessages.alive) return
      this.syncResponseHighlights(references)
    })
  }

  addResponseReference(): void {
    const selection = this.root.sources.responseSelection
    if (!selection) return
    // Temporary chats keep their composer references on the controller   the
    // thread-scoped store below is invisible to them   but they became a
    // reference like any other, so the comment editor opens on the passage and
    // the comment rides to the harness with it.
    if (this.root.props.controller?.addSelection) {
      const referenceId = this.root.props.controller.addSelection({
        text: selection.text,
        messageId: selection.messageId,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset
      })
      if (!referenceId) return
      this.responseReferenceRanges.set(referenceId, selection.range)
      this.refreshResponseHighlights()
      this.updateResponseBubblePositions()
      this.root.sources.closeResponseSelection()
      this.commentEditorReferenceId = referenceId
      return
    }
    const id = crypto.randomUUID()
    responseReferencesState.setForThread(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      [
        ...this.responseReferences,
        {
          id,
          label: `Selection ${this.responseReferences.length + 1}`,
          text: selection.text,
          messageId: selection.messageId,
          startOffset: selection.startOffset,
          endOffset: selection.endOffset
        }
      ]
    )
    this.responseReferenceRanges.set(id, selection.range)
    this.refreshResponseHighlights()
    this.updateResponseBubblePositions()
    this.root.sources.closeResponseSelection()
    // Open the comment editor by default so the user can start typing right
    // away; the selection is already attached to the chat component.
    this.commentEditorReferenceId = id
  }

  removeResponseReference(id: string): void {
    responseReferencesState.setForThread(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      this.responseReferences.filter((reference) => reference.id !== id)
    )
    this.responseReferenceRanges.delete(id)
    this.refreshResponseHighlights()
    this.updateResponseBubblePositions()
    if (this.commentEditorReferenceId === id) this.commentEditorReferenceId = null
  }

  clearResponseReferences(): void {
    responseReferencesState.clearThread(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
    this.responseReferenceRanges.clear()
    this.refreshResponseHighlights()
    this.responseBubblePositions = {}
    this.commentEditorReferenceId = null
  }

  async editResponseReference(id: string): Promise<void> {
    const reference = this.annotationReferences.find((candidate) => candidate.id === id)
    if (!reference) return
    // A document annotation is drawn in the file panel and a design element in
    // the browser, not in the conversation, so each of their edit actions opens
    // the surface that draws it instead of a response range here.
    if (reference.kind === 'file') {
      this.root.studioTemporaryChatContext.editDocumentAnnotation(reference)
      return
    }
    if (reference.kind === 'design') {
      this.root.studioTemporaryChatContext.editDesignAnnotation(reference)
      return
    }
    if (reference.kind === 'video') {
      this.root.editVideoNote.editVideoNote(reference)
      return
    }
    // A mark on an inline picture is drawn by the picture's own surface, so its
    // edit action brings that picture back on screen and lets the surface open
    // the comment: the reference has no text range to jump to. A mark drawn on a
    // captured composition frame has no part to bring back, so it opens the
    // composition at its moment instead.
    if (reference.kind === 'image') {
      if (reference.markSeconds !== undefined && (reference.directory ?? '') !== '') {
        this.root.editVideoNote.editCompositionFrameMark(reference)
        return
      }
      await this.root.editVideoNote.editMediaMark(reference)
      return
    }
    // An element picked inside an inline artifact is pinned by the artifact card
    // that draws it, so its edit action brings that card up and lets it open the
    // comment.
    if (reference.kind === 'svg' || reference.kind === 'html') {
      this.root.editVideoNote.editArtifactElement(reference)
      return
    }
    if (!isResponseSelection(reference)) return
    this.commentEditorReferenceId = id
    // Bring the commented message back on screen first. It can lie outside the
    // mounted window entirely (a restore, a long transcript), and the range is
    // built from that element   without it there is no highlight to scroll to
    // and no bubble to pin.
    if (reference.messageId) await this.root.loadOlderMessages.jumpToMessage(reference.messageId)
    if (!this.root.loadOlderMessages.alive) return
    this.syncResponseHighlights(this.annotationReferences)
    await tick()
    if (!this.root.loadOlderMessages.alive) return
    this.updateResponseBubblePositions()
    const range = this.responseReferenceRanges.get(id)
    if (!range) return
    const element =
      range.startContainer.parentElement ??
      (range.startContainer.parentNode instanceof Element ? range.startContainer.parentNode : null)
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  /** Remove a single composer selection reference, routing to the controller for temporary chats. */
  removeComposerReference(id: string): void {
    if (this.root.props.controller?.removeReference) {
      this.root.props.controller.removeReference(id)
      // The side chat's ranges and bubble positions live in this view, so a
      // reference the controller dropped has to stop being drawn here too.
      this.responseReferenceRanges.delete(id)
      this.refreshResponseHighlights()
      this.updateResponseBubblePositions()
      if (this.commentEditorReferenceId === id) this.commentEditorReferenceId = null
      return
    }
    this.removeResponseReference(id)
  }

  /** Clear all composer selection references, routing to the controller for temporary chats. */
  clearComposerReferences(): void {
    if (this.root.props.controller?.clearReferences) {
      this.root.props.controller.clearReferences()
      this.responseReferenceRanges.clear()
      this.refreshResponseHighlights()
      this.responseBubblePositions = {}
      this.commentEditorReferenceId = null
      return
    }
    this.clearResponseReferences()
  }

  commentEditorReference(): ResponseReferenceAnchor | null {
    const id = this.commentEditorReferenceId
    if (!id) return null
    return this.annotationReferences.find((reference) => reference.id === id) ?? null
  }

  idleAttentionHandled = false

  async handleIdleAttention(): Promise<void> {
    const { projectId, id } = this.root.handleAgentEvent.thread
    try {
      this.root.handleAgentEvent.pendingPermissions = await invoke(
        'agent:listPermissions',
        projectId,
        id
      )
      if (!this.root.loadOlderMessages.alive) return
      if (this.root.handleAgentEvent.pendingPermissions.length > 0) return
      const pendingImageDescriptorErrors = await invoke(
        'agent:listImageDescriptorErrors',
        projectId,
        id
      )
      if (!this.root.loadOlderMessages.alive) return
      if (pendingImageDescriptorErrors.length > 0) {
        this.root.sources.pendingImageDescriptorError = pendingImageDescriptorErrors[0]
        return
      }
      const pending = await invoke('agent:listQuestions', projectId, id)
      if (!this.root.loadOlderMessages.alive) return
      this.root.handleAgentEvent.pendingQuestionRequests = pending.filter(
        (request) => !this.root.sources.resolvedQuestionRequestIds.has(request.requestId)
      )
      if (this.root.handleAgentEvent.pendingQuestionRequests.length > 0) return
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error
          ? error.message
          : 'Pending attention requests could not be reconciled.'
      return
    }

    if (!this.root.loadOlderMessages.alive || this.root.harnessUsage.specFormulating) return
    if (this.root.switchProject.busy) {
      // A restore raced a new turn; let the next idle transition retry.
      this.idleAttentionHandled = false
      return
    }
    // A scope worktree still building for this thread holds the queue: the
    // message must wait for the scope switch, not run in the old checkout.
    // Reset the guard so the scope job settling retries automatically.
    if (!this.root.loadOlderMessages.hasController && scopeJobs.hasPendingScopeJob(projectId, id)) {
      this.idleAttentionHandled = false
      return
    }
    const pending = this.queuedMessage
    const pendingAttachments = this.queuedAttachments
    const pendingPromptContext = this.queuedPromptContext
    const pendingPromptReferences = this.queuedPromptReferences
    const pendingProjectReferences = this.queuedProjectReferences
    const pendingPresentation = this.queuedPresentation
    const pendingTaskReferences = this.queuedTaskReferences
    const pendingStartAfterThreads = this.queuedStartAfterThreads
    if (!pending && !this.queuedHasContent) return
    if (pendingStartAfterThreads.length > 0) {
      const dependencies = await Promise.all(
        pendingStartAfterThreads.map((reference) => invoke('thread:get', projectId, reference.id))
      )
      if (
        dependencies.some(
          (dependency) =>
            !dependency || !this.root.unmirroredTraceStartTime.isTerminalThread(dependency.status)
        )
      ) {
        this.idleAttentionHandled = false
        return
      }
    }
    // Claim synchronously before sending so the background dispatcher (or any
    // concurrent path) cannot also deliver this same queued message. If we lose
    // the race, whoever claimed it will send it   never send here.
    if (!claimQueuedMessage(projectId, id)) return
    try {
      // Dequeue only the head   remaining queued messages stay FIFO for the
      // following idle transitions (one message per turn).
      this.clearQueuedState()
      await this.root.handleAgentEvent.sendMessage(
        pending,
        pendingAttachments,
        undefined,
        undefined,
        pendingPromptContext,
        pendingPromptReferences,
        pendingProjectReferences,
        pendingPresentation,
        pendingTaskReferences,
        true
      )
    } finally {
      releaseQueuedMessage(projectId, id)
    }
  }

  scheduleIdleAttention(): void {
    if (this.idleAttentionHandled) return
    this.idleAttentionHandled = true
    void this.handleIdleAttention()
  }

  /** Clear the in-memory head entry and dequeue the persisted head message.
   *  Remaining queued messages stay in the FIFO for the next idle turn. */
  clearQueuedState(): void {
    this.queuedMessage = ''
    this.queuedAttachments = []
    this.queuedPromptContext = undefined
    this.queuedPromptReferences = []
    this.queuedProjectReferences = []
    this.queuedPresentation = undefined
    this.queuedTaskReferences = []
    this.queuedStartAfterThreads = []
    this.queuedHasContent = false
    rendererRecovery.clearQueuedMessage(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
  }

  /** Bring persisted queued messages back after a reload or thread remount.
   *  The head entry hydrates the in-memory copy; the rest stay in the store. */
  restoreQueuedMessage(): void {
    this.syncQueuedFromStore()
    if (!this.queuedMessage && !this.queuedHasContent) return
    const entry = rendererRecovery.queuedMessageFor(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
    if (!entry) return
    if (entry.promptReferences.length > 0) {
      responseReferencesState.setForThread(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        entry.promptReferences
      )
      this.scheduleResponseHighlightRestore(entry.promptReferences)
    }
  }

  /** Mirror the store's head queued message into the in-memory card state.
   *  Keeps the card showing the next message the FIFO will actually send. */
  syncQueuedFromStore(): void {
    const head = rendererRecovery.queuedMessageFor(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
    if (!head) {
      this.queuedMessage = ''
      this.queuedAttachments = []
      this.queuedPromptContext = undefined
      this.queuedPromptReferences = []
      this.queuedProjectReferences = []
      this.queuedPresentation = undefined
      this.queuedTaskReferences = []
      this.queuedStartAfterThreads = []
      this.queuedHasContent = false
      return
    }
    this.queuedMessage = head.text
    this.queuedAttachments = head.attachments
    this.queuedPromptContext = head.promptContext
    this.queuedPromptReferences = head.promptReferences
    this.queuedProjectReferences = head.projectReferences
    this.queuedPresentation = head.presentation
    this.queuedTaskReferences = head.taskReferences
    this.queuedStartAfterThreads = head.startAfterThreads
    this.queuedHasContent =
      head.text !== '' ||
      head.attachments.length > 0 ||
      Boolean(head.promptContext) ||
      head.promptReferences.length > 0 ||
      head.projectReferences.length > 0 ||
      head.taskReferences.length > 0
    // The card's chips lead with a picture's own thumbnail, so the head's files
    // are read into the cache the composer previews attachments from. A file
    // already cached is skipped, so a repeated sync reads nothing.
    if (head.attachments.length > 0)
      void this.root.studioTemporaryChatContext.attachmentPreview.loadAll(head.attachments)
  }

  queuedMessage = $state('')

  queuedAttachments = $state<PromptAttachment[]>([])

  queuedPromptContext = $state<string | undefined>()

  queuedPromptReferences = $state<ResponseReferenceAnchor[]>([])

  queuedProjectReferences = $state<PromptProjectReference[]>([])

  queuedPresentation = $state<UserMessagePresentation | undefined>()

  queuedTaskReferences = $state<PromptAssignmentTaskReference[]>([])

  queuedStartAfterThreads = $state<StartAfterThreadReference[]>([])

  queuedStartAfterPendingRemoval = $state<StartAfterThreadReference | null>(null)

  /** True when a queued payload exists even though the message text is empty
   *  (e.g. a selection carrying only a user comment). */
  queuedHasContent = $state(false)

  queuedCardVisible = $derived(
    (this.queuedMessage !== '' || this.queuedHasContent) &&
      !this.root.harnessUsage.specFormulating &&
      !this.root.unmirroredTraceStartTime.isAssignmentAuditorThread
  )

  /**
   * Park a composer send in the thread's FIFO queue instead of dispatching it
   * now: the idle dispatcher drains one message per idle turn.
   *
   * The queue, the persisted recovery snapshot and the dispatch path all key on
   * `thread.projectId:thread.id`, so this is exactly the parking the primary
   * surface uses   and it is why a controller-driven conversation backed by a
   * real thread (a browser tab's assistant) can queue too.
   */
  parkComposerSend(send: {
    text: string
    attachments: PromptAttachment[]
    promptContext?: string
    promptReferences: ResponseReferenceAnchor[]
    projectReferences: PromptProjectReference[]
    presentation?: UserMessagePresentation
    taskReferences: PromptAssignmentTaskReference[]
    startAfterThreads: StartAfterThreadReference[]
  }): void {
    this.queuedMessage = send.text
    this.queuedAttachments = send.attachments
    this.queuedPromptContext = send.promptContext
    this.queuedPromptReferences = send.promptReferences
    this.queuedProjectReferences = send.projectReferences
    this.queuedPresentation = send.presentation
    this.queuedTaskReferences = send.taskReferences
    this.queuedStartAfterThreads = send.startAfterThreads
    this.queuedHasContent = true
    // Append to the thread's FIFO queue   a later queued message sends after
    // earlier ones, one per idle turn. The in-memory mirror then follows the
    // Store head so the queue card always shows the next message to send.
    rendererRecovery.setQueuedMessage(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      {
        text: send.text,
        attachments: send.attachments,
        promptContext: send.promptContext,
        promptReferences: send.promptReferences,
        projectReferences: send.projectReferences,
        presentation: send.presentation,
        taskReferences: send.taskReferences,
        startAfterThreads: send.startAfterThreads
      }
    )
    this.syncQueuedFromStore()
    this.idleAttentionHandled = false
    void this.handleIdleAttention()
  }

  /** Steer   send the queued message immediately as an intervention while the agent is working. */
  async steerQueuedMessage(): Promise<void> {
    const msg = this.queuedMessage
    const attachments = this.queuedAttachments
    const promptContext = this.queuedPromptContext
    const promptReferences = this.queuedPromptReferences
    const projectReferences = this.queuedProjectReferences
    const presentation = this.queuedPresentation
    const taskReferences = this.queuedTaskReferences
    if (
      (!msg && !this.queuedHasContent) ||
      !this.root.switchProject.busy ||
      this.root.harnessUsage.specFormulating
    )
      return

    if (this.root.props.controller) {
      this.clearQueuedState()
      this.root.handleAgentEvent.errorMessage = ''
      const payload: SendPayload = {
        text: msg,
        attachments,
        promptContext,
        promptReferences,
        projectReferences,
        presentation,
        taskReferences
      }
      await this.root.props.controller.steer(payload)
      return
    }
    this.clearQueuedState()
    // The running trace stays exactly as it is: the harness has not taken the
    // message yet, so the work still streaming belongs to the turn it steers and
    // must keep rendering above the message. The durable fold moves to the new
    // turn on its own when delivery clears the hold, and that move is what
    // freezes this turn's trace and opens the next one under the message.
    // The steered message lands at the tail. A reader scrolled up into the
    // running turn keeps their position and their mounted messages   releasing
    // the tail lock here would re-window the conversation and hide on-screen
    // history mid-read. Tail-follow stays engaged only when already at the tail.
    this.root.handleAgentEvent.errorMessage = ''

    const { projectId, id } = this.root.handleAgentEvent.thread
    const userMessageId = messageId()
    this.root.sources.recordModelUse()

    try {
      const sendPromise = threadMessages.steer(
        projectId,
        id,
        msg,
        attachments,
        userMessageId,
        promptContext,
        promptReferences,
        projectReferences,
        presentation,
        taskReferences
      )
      await tick()
      if (this.root.loadOlderMessages.scrollEl && !this.root.loadOlderMessages.userScrolledAway)
        this.root.loadOlderMessages.scrollEl.scrollTop =
          this.root.loadOlderMessages.scrollEl.scrollHeight
      await sendPromise
    } catch (error) {
      if (!this.queuedMessage && !this.queuedHasContent) {
        this.queuedMessage = msg
        this.queuedAttachments = attachments
        this.queuedPromptContext = promptContext
        this.queuedPromptReferences = promptReferences
        this.queuedProjectReferences = projectReferences
        this.queuedPresentation = presentation
        this.queuedTaskReferences = taskReferences
        this.queuedHasContent = true
        // Put it back at the front of the FIFO (steer consumed the head).
        const remaining = rendererRecovery.queuedMessagesFor(projectId, id)
        rendererRecovery.clearAllQueuedMessages(projectId, id)
        rendererRecovery.setQueuedMessage(projectId, id, {
          text: msg,
          attachments,
          promptContext,
          promptReferences,
          projectReferences,
          presentation,
          taskReferences,
          startAfterThreads: []
        })
        for (const entry of remaining) rendererRecovery.setQueuedMessage(projectId, id, entry)
        this.syncQueuedFromStore()
      }
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'Steer message could not be sent.'
      if (promptReferences.length > 0) {
        responseReferencesState.setForThread(projectId, id, promptReferences)
        this.scheduleResponseHighlightRestore(promptReferences)
      }
    }
  }

  /** Return the queued message to the composer for editing. */
  editQueuedMessage(): void {
    if (!this.queuedMessage && !this.queuedHasContent) return
    rendererRecovery.setDraft(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      this.queuedMessage,
      this.queuedAttachments,
      this.queuedProjectReferences,
      this.queuedTaskReferences
    )
    responseReferencesState.setForThread(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      this.queuedPromptReferences
    )
    this.scheduleResponseHighlightRestore(this.queuedPromptReferences)
    this.clearQueuedState()
    this.root.currentWorkingTraceAttribution.composerRestoreKey += 1
  }

  /** Delete every queued message for the thread. */
  deleteAllQueuedMessages(): void {
    this.queuedMessage = ''
    this.queuedAttachments = []
    this.queuedPromptContext = undefined
    this.queuedPromptReferences = []
    this.queuedProjectReferences = []
    this.queuedPresentation = undefined
    this.queuedTaskReferences = []
    this.queuedStartAfterThreads = []
    this.queuedHasContent = false
    rendererRecovery.clearAllQueuedMessages(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id
    )
  }

  persistQueuedStartAfterThreads(): void {
    rendererRecovery.updateQueuedHead(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      {
        text: this.queuedMessage,
        attachments: this.queuedAttachments,
        promptContext: this.queuedPromptContext,
        promptReferences: this.queuedPromptReferences,
        projectReferences: this.queuedProjectReferences,
        presentation: this.queuedPresentation,
        taskReferences: this.queuedTaskReferences,
        startAfterThreads: this.queuedStartAfterThreads
      }
    )
    this.idleAttentionHandled = false
    void this.handleIdleAttention()
  }

  addQueuedStartAfterThread(selectedThread: Thread): void {
    if (this.queuedStartAfterThreads.some((reference) => reference.id === selectedThread.id)) return
    this.queuedStartAfterThreads = [
      ...this.queuedStartAfterThreads,
      { id: selectedThread.id, title: selectedThread.title }
    ]
    this.persistQueuedStartAfterThreads()
  }

  confirmRemoveQueuedStartAfterThread(): void {
    const dependency = this.queuedStartAfterPendingRemoval
    if (!dependency) return
    this.queuedStartAfterPendingRemoval = null
    this.queuedStartAfterThreads = this.queuedStartAfterThreads.filter(
      (reference) => reference.id !== dependency.id
    )
    this.persistQueuedStartAfterThreads()
  }
}
