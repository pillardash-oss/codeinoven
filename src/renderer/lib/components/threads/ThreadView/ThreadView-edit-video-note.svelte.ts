import { invoke } from '$lib/ipc.svelte'

import { workspaceState } from '$lib/stores/workspace.svelte'
import { browserAddressFocus } from '$lib/stores/browser-address-focus'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { rendererRecovery, publishDraftActivity } from '$lib/stores/renderer-recovery.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { conversationAttention } from '$lib/stores/conversation-attention.svelte'
import { type ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'
import { artifactElementFocusState } from '$lib/stores/artifact-element-focus.svelte'
import { videoNoteFocusState } from '$lib/stores/video-note-focus.svelte'
import { compositionFrameFocusState } from '$lib/stores/composition-frame-focus.svelte'
import { designCoordinatorState } from '$lib/stores/design-coordinator.svelte'
import { toast } from 'svelte-sonner'
import type {
  AgentMessage,
  AgentPart,
  BrainstormDocument,
  BrainstormSectionId,
  UserMessageSummary,
  EngineeringLifecycleState
} from '$shared/types'
import {
  normalizeLifecycleStages,
  representativeLifecycleSelection
} from '$shared/engines/engineering-lifecycle-engine'
import { messageText } from '../thread-message-presentation'
import { HISTORY_WINDOW_SIZE, mergedUserMessageSummaries } from '../thread-history'
import type { ParkedEntrySend, PendingMessageDelete } from './ThreadView-types'
import type { ThreadView } from './ThreadView-board.svelte'
import { SvelteSet } from 'svelte/reactivity'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewEditVideoNote extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  loadingNewerMessages = $state(false)

  /** Full persisted user-message history for the header's quick-jump list. */
  fullUserMessageHistory = $state<UserMessageSummary[]>([])

  userMessageHistoryLoaded = false

  userMessageHistoryLoading: Promise<void> | null = $state(null)

  /** Composer recall texts: the merged full history, minus blank entries that
   *  would only produce an empty recall step. Keyed on the structure snapshot
   *  a user message's text only ever changes through a merge that reports
   *  itself structural, so recall never lags behind what the user typed. */
  composerHistoryTexts = $derived(
    mergedUserMessageSummaries(
      this.root.buildSpecActionPrompt.structureMessages,
      this.fullUserMessageHistory
    )
      .map((entry) => entry.content)
      .filter((text) => text.trim().length > 0)
  )

  /** Send-time engineering entry card: PRD/Spec need context, so the "Brainstorm
   *  first | Jump directly into…" choice is shown only after the user tries to send,
   *  never when the Toolbox switch is toggled. */
  pendingEngineeringEntry = $state<'prd' | 'spec' | null>(null)

  /** The send that opened the entry card. The composer clears its buffer at
   *  submit time, so the payload waits here and its draft is handed back while
   *  the card is up; the resolved entry choice resends it. */
  pendingEntrySend = $state<ParkedEntrySend | null>(null)

  /** Toolbox presentation mirrors the staged selection so switches flip
   *  immediately, while every side effect stays deferred until the send. */
  pendingLifecycleDisplay = $derived.by((): EngineeringLifecycleState | null => {
    const pending = this.root.harnessUsage.pendingLifecycleSelection
    const base = this.root.handleAgentEvent.engineeringLifecycle
    if (!pending) return base
    const autopilot = pending.autopilot === true
    const selectedStages = autopilot ? [] : normalizeLifecycleStages(pending.stages)
    // When the staged selection turns everything off, the toolbox must read as
    // off too   a stale `startedAt` marker from a previous run would keep the
    // icon lit after the user toggled the modes off.
    const cleared = !autopilot && selectedStages.length === 0
    return {
      projectId: base?.projectId ?? this.root.handleAgentEvent.thread.projectId,
      threadId: base?.threadId ?? this.root.handleAgentEvent.thread.id,
      selection: representativeLifecycleSelection(selectedStages, autopilot),
      selectedStages,
      autopilot,
      completedStages: base?.completedStages ?? [],
      ...(base?.activeStage ? { activeStage: base.activeStage } : {}),
      ...(base?.humanGate ? { humanGate: base.humanGate } : {}),
      ...(base?.failure ? { failure: base.failure } : {}),
      ...(!cleared && base?.startedAt ? { startedAt: base.startedAt } : {}),
      updatedAt: base?.updatedAt ?? Date.now()
    }
  })

  /**
   * Bring a noted video moment back in front of the reader: show the video board,
   * put the composition preview on the exact frame the note was written at, and
   * let the timeline open the note itself. A tab the user has since closed still
   * has a timeline to land on, so the seek is best effort.
   */
  /**
   * Bring a noted video moment back in front of the reader: show the video board,
   * open the composition the moment belongs to, put its preview on the exact frame
   * the note was written at, and let the timeline open the note itself.
   *
   * Opening the composition is what moves the board onto that folder, and the
   * timeline that can take the request only exists once it has.
   */
  editVideoNote(reference: ResponseReferenceAnchor): void {
    const seconds = reference.seconds ?? 0
    const directory = reference.directory ?? ''
    videoNoteFocusState.request({
      projectId: this.root.handleAgentEvent.thread.projectId,
      threadId: this.root.handleAgentEvent.thread.id,
      referenceId: reference.id,
      seconds,
      directory
    })
    this.openCompositionAt(
      directory,
      seconds,
      'The composition this note was written on could not be opened.'
    )
  }

  /**
   * Reopen the composition frame a mark was drawn on and open its comment.
   *
   * A mark on a captured frame is drawn on a picture the app produced from the
   * composition, not on a part of the conversation, so there is no message to
   * jump to: the edit action opens the video board on that composition and asks
   * the surface that draws frames to put the mark's moment back on screen, which
   * is where its badge and its comment live.
   */
  editCompositionFrameMark(reference: ResponseReferenceAnchor): void {
    const seconds = reference.markSeconds ?? 0
    const directory = reference.directory ?? ''
    compositionFrameFocusState.request({
      projectId: this.root.handleAgentEvent.thread.projectId,
      threadId: this.root.handleAgentEvent.thread.id,
      referenceId: reference.id,
      seconds,
      directory
    })
    this.openCompositionAt(
      directory,
      seconds,
      'The composition this mark was drawn on could not be opened.'
    )
  }

  /**
   * Show the video board on one composition with its playhead on one second.
   *
   * Opening the composition is what moves the board onto that folder, and every
   * surface that lands there reads its own request store, so the order matters:
   * the request is made by the caller before this opens anything.
   */
  openCompositionAt(directory: string, seconds: number, failure: string): void {
    designCoordinatorState.openBoard(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      'video'
    )
    if (!directory) return
    void invoke(
      'design:open',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      directory,
      null,
      true,
      'video'
    )
      .then((opened) => {
        contextSidebarState.focus(opened.tabId)
        return invoke('browser:transport', opened.tabId, 'seek', seconds).catch(() => undefined)
      })
      .catch(() => {
        toast.error(failure, { description: directory })
      })
  }

  /**
   * Bring a marked picture back in front of the reader and open the mark's comment.
   *
   * A mark is drawn on a picture in the fullscreen viewer and its badge lives
   * there, so the edit action opens that viewer on the very part the mark names:
   * the reference carries the message and the media URL it was drawn on, and the
   * viewer hands the mark to the picture's surface, which opens the editor once
   * its badge is measured. A frame mark's surface also seeks its video to the
   * mark's second before the editor opens, because a comment about a moment has
   * to be written over that moment.
   */
  async editMediaMark(reference: ResponseReferenceAnchor): Promise<void> {
    if (reference.messageId) await this.root.loadOlderMessages.jumpToMessage(reference.messageId)
    if (!this.root.loadOlderMessages.alive) return
    const message = this.root.loadOlderMessages.messages.find(
      (entry) => entry.id === reference.messageId
    )
    const part = message?.parts.find(
      (entry): entry is Extract<AgentPart, { type: 'file' }> =>
        entry.type === 'file' && entry.url === reference.mediaUrl
    )
    if (!message || !part) return
    this.openMessageViewer(message, part)
    this.root.unmirroredTraceStartTime.imageMarkEditorId = reference.id
  }

  /**
   * Jump back to a selection's highlight and open its comment editor.
   *
   * The editor opens first, before the excerpt is found: the commented message
   * can sit outside the mounted window, in which case there is no range to pin
   * a bubble to, and a comment that is merely not on screen must still be
   * readable and editable rather than the action silently doing nothing. The
   * message is then brought on screen, the range rebuilt, and the highlight
   * scrolled to.
   */
  /**
   * Bring a commented artifact element back in front of the reader.
   *
   * The pin and the comment editor are drawn by the artifact card that renders
   * the artifact, so the edit action scrolls that card into view and hands it the
   * pick. The key an artifact carries is derived from its own source and is
   * always `[a-z0-9-]`, so it needs no selector escaping.
   */
  editArtifactElement(reference: ResponseReferenceAnchor): void {
    const key = reference.artifactKey
    if (!key) return
    const card = document.querySelector(`[data-artifact-key="${key}"]`)
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    artifactElementFocusState.request(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      key,
      reference.id
    )
  }

  brainstorm = $state<BrainstormDocument | null>(null)

  brainstormVersions = $state<BrainstormDocument[]>([])

  selectedBrainstormVersion = $state<number | undefined>()

  studioBrainstorm = $derived(
    this.brainstormVersions.find(
      (candidate) => candidate.version === this.selectedBrainstormVersion
    ) ?? this.brainstorm
  )

  /** Page forward from a far-back jump anchor until the cache reaches the tail. */
  async fillForwardFrom(projectId: string, threadId: string, anchorId: string): Promise<void> {
    if (this.loadingNewerMessages) return
    this.loadingNewerMessages = true
    try {
      let cursorId = anchorId
      for (let pageCount = 0; pageCount < 25; pageCount++) {
        const page = await invoke(
          'thread:loadMessagesAround',
          projectId,
          threadId,
          cursorId,
          HISTORY_WINDOW_SIZE
        )
        if (!this.root.loadOlderMessages.alive) return
        if (page.messages.length === 0) return
        threadMessages.mergePage(projectId, threadId, page.messages)
        if (!page.hasNewer) return
        cursorId = page.messages[page.messages.length - 1].id
      }
    } catch {
      // Non-fatal   a residual gap can still be filled by scrolling.
    } finally {
      this.loadingNewerMessages = false
    }
  }

  /** For a user message that follows an assistant turn (a steer), return the
   *  previous turn's start/end timestamps and total duration so it can be
   *  rendered as an audit line above the user's message. */
  getPreviousTurnAudit(
    msgIndex: number
  ): { startTime: number; endTime: number; duration: number } | null {
    if (msgIndex === 0) return null
    const lastAssistant = this.root.loadOlderMessages.messages[msgIndex - 1]
    if (lastAssistant?.role !== 'assistant') return null
    // A run that is still going and whose last assistant row is a mid-turn step
    // (tool calls, no answer) has not completed: the message below only steers
    // the live turn. Claiming "Previous turn completed" there told the reader
    // the agent had answered and finished, which is what made a steered prompt
    // read as unanswered.
    if (this.root.switchProject.busy && messageText(lastAssistant).trim().length === 0) return null
    let turnStartIndex = msgIndex - 2
    while (
      turnStartIndex >= 0 &&
      this.root.loadOlderMessages.messages[turnStartIndex]?.role === 'assistant'
    ) {
      turnStartIndex--
    }
    const userMsg = this.root.loadOlderMessages.messages[turnStartIndex]
    if (userMsg?.role !== 'user' || !userMsg.createdAt || !lastAssistant.completedAt) return null
    return {
      startTime: userMsg.createdAt,
      endTime: lastAssistant.completedAt,
      duration: lastAssistant.completedAt - userMsg.createdAt
    }
  }

  /** Load the thread's full persisted user-message history for the header jump list. */
  async refreshUserMessageHistory(): Promise<void> {
    const { projectId, id } = this.root.handleAgentEvent.thread
    if (this.userMessageHistoryLoaded) return
    if (this.userMessageHistoryLoading) return this.userMessageHistoryLoading
    const loadPromise = (async (): Promise<void> => {
      try {
        const history = await invoke('thread:loadUserMessages', projectId, id)
        if (!this.root.loadOlderMessages.alive) return
        this.fullUserMessageHistory = history
        this.userMessageHistoryLoaded = true
      } catch {
        // Non-fatal   the dropdown falls back to the loaded message window.
      } finally {
        this.userMessageHistoryLoading = null
      }
    })()
    this.userMessageHistoryLoading = loadPromise
    return loadPromise
  }

  async refreshPendingPermissions(): Promise<void> {
    const { projectId, id } = this.root.handleAgentEvent.thread
    try {
      if (this.root.props.controller) {
        // The side chat's own queue is authoritative for its own conversation
        // the parent thread must never show a card the side chat owns.
        const knownIds = new SvelteSet(
          conversationAttention
            .permissions(
              this.root.props.controller.projectId,
              this.root.props.controller.conversationId
            )
            .map((request) => request.id)
        )
        const pending = await invoke('agent:listPermissions', projectId, id)
        conversationAttention.reconcile(
          this.root.props.controller.projectId,
          this.root.props.controller.conversationId,
          pending,
          knownIds
        )
        return
      }
      this.root.handleAgentEvent.pendingPermissions = await invoke(
        'agent:listPermissions',
        projectId,
        id
      )
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'Pending permissions could not be loaded.'
    }
  }

  /**
   * Open the conversation's browser from the composer: reveal the page it
   * already has, or start a blank tab when it has none, handing that tab's
   * address bar the keyboard so the user begins browsing straight away.
   *
   * Both halves are the gestures the user already has on the rail, composed
   * here: the reveal is the browser toggle's own read (the conversation on
   * screen), and the create is the strip's new-tab path, which is blank and
   * takes the caret.
   */
  openThreadBrowser(): void {
    const existingTabId = contextSidebarState.rememberedBrowserTabId
    if (existingTabId) {
      contextSidebarState.focus(existingTabId)
      return
    }
    const tabId = contextSidebarState.openBrowserForContext(
      '',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      undefined,
      true
    )
    browserAddressFocus.request(tabId)
  }

  /**
   * Open one of a message's attachments in the fullscreen preview, collected
   * with its previewable siblings so the modal can step between them. This is
   * the click behaviour for an image thumbnail and for a chip the preview can
   * render (PDF, document, Markdown, text); media chips land here too.
   */
  openMessageViewer(
    msg: AgentMessage,
    part: Extract<AgentPart, { type: 'file' }>,
    startAt?: number,
    playing?: boolean
  ): void {
    const items = this.root.studioTemporaryChatContext.previewableFileParts(msg)
    const index = items.findIndex((item) => item.url === part.url)
    if (index === -1) return
    this.root.studioTemporaryChatContext.messageViewer = {
      items,
      index,
      messageId: msg.id,
      annotatable: msg.inlineArtifact === true,
      ...(startAt !== undefined ? { startAt } : {}),
      ...(playing !== undefined ? { playing } : {})
    }
    this.root.studioTemporaryChatContext.loadViewerItem(items[index])
  }

  applyBrainstormDocument(updated: BrainstormDocument): BrainstormDocument {
    this.brainstorm = updated
    this.brainstormVersions = this.brainstormVersions.some(
      (candidate) => candidate.version === updated.version
    )
      ? this.brainstormVersions.map((candidate) =>
          candidate.version === updated.version ? updated : candidate
        )
      : [...this.brainstormVersions, updated]
    this.selectedBrainstormVersion = updated.version
    return updated
  }

  openBrainstormStudio(): void {
    if (!this.brainstorm) return
    this.selectedBrainstormVersion = this.brainstorm.version
    workspaceState.specAgentSidebarOpen = false
    this.root.harnessUsage.studioDocument = 'brainstorm'
    this.root.submitSpecDecision.showSpecStudio = true
  }

  selectBrainstormVersion(version: number): void {
    this.selectedBrainstormVersion = version
  }

  async chooseEngineeringEntry(choice: 'brainstorm_first' | 'jump_in'): Promise<void> {
    const target = this.pendingEngineeringEntry
    if (target === null) return
    this.pendingEngineeringEntry = null
    if (target === 'prd') {
      await this.root.harnessUsage.choosePrdEntry(
        choice === 'brainstorm_first' ? 'brainstorm_first' : 'start_prd'
      )
    } else {
      await this.root.submitBrainstormDecision.chooseBrainstormEntry(
        choice === 'brainstorm_first' ? 'brainstorm' : 'spec'
      )
    }
    await this.resumePendingEntrySend()
  }

  /** Send the message that opened the entry card, now that the choice deciding
   *  how it is handled is persisted. The draft went back to the composer while
   *  the card was up, so it clears first and a failed send restores it through
   *  the same `restorable` path every other send uses. */
  async resumePendingEntrySend(): Promise<void> {
    const parked = this.pendingEntrySend
    if (!parked) return
    this.pendingEntrySend = null
    const { projectId, id } = this.root.handleAgentEvent.thread
    rendererRecovery.clearDraft(projectId, id)
    publishDraftActivity(projectId, id, false)
    this.root.currentWorkingTraceAttribution.composerRestoreKey += 1
    // The quoted excerpts the draft put back on screen now travel with the
    // parked payload, exactly as a composer send consumes them once.
    if (parked.promptReferences.length > 0) this.root.steerQueuedMessage.clearResponseReferences()
    await this.root.handleAgentEvent.sendMessage(
      parked.text,
      parked.attachments,
      parked.specAction,
      parked.direct,
      parked.promptContext,
      parked.promptReferences,
      parked.projectReferences,
      parked.presentation,
      parked.taskReferences,
      true,
      parked.startAfterThreads
    )
  }

  async saveBrainstorm(edited: BrainstormDocument): Promise<BrainstormDocument | null> {
    this.root.harnessUsage.brainstormBusy = true
    this.root.harnessUsage.brainstormError = ''
    try {
      return this.applyBrainstormDocument(
        await invoke(
          'brainstorm:saveDraft',
          edited.projectId,
          edited.threadId,
          edited.id,
          edited.version,
          edited.content
        )
      )
    } catch (error) {
      this.root.harnessUsage.brainstormError =
        error instanceof Error ? error.message : 'The Brainstorm could not be saved.'
      return null
    } finally {
      this.root.harnessUsage.brainstormBusy = false
    }
  }

  async addBrainstormAnnotation(
    section: BrainstormSectionId,
    body: string,
    anchor: {
      quote: string
      startLine: number
      endLine: number
      startOffset: number
      endOffset: number
    }
  ): Promise<BrainstormDocument | null> {
    const current = this.brainstorm
    if (!current) return null
    try {
      return this.applyBrainstormDocument(
        await invoke(
          'brainstorm:addAnnotation',
          current.projectId,
          current.threadId,
          current.id,
          current.version,
          { section, body, author: 'user', ...anchor }
        )
      )
    } catch (error) {
      this.root.harnessUsage.brainstormError =
        error instanceof Error ? error.message : 'The comment could not be added.'
      return null
    }
  }

  async updateBrainstormAnnotation(
    annotationId: string,
    body: string
  ): Promise<BrainstormDocument | null> {
    const current = this.brainstorm
    if (!current) return null
    try {
      return this.applyBrainstormDocument(
        await invoke(
          'brainstorm:updateAnnotation',
          current.projectId,
          current.threadId,
          current.id,
          current.version,
          annotationId,
          body
        )
      )
    } catch (error) {
      this.root.harnessUsage.brainstormError =
        error instanceof Error ? error.message : 'The comment could not be updated.'
      return null
    }
  }

  async resolveBrainstormAnnotation(annotationId: string): Promise<BrainstormDocument | null> {
    const current = this.brainstorm
    if (!current) return null
    try {
      return this.applyBrainstormDocument(
        await invoke(
          'brainstorm:resolveAnnotation',
          current.projectId,
          current.threadId,
          current.id,
          current.version,
          annotationId
        )
      )
    } catch (error) {
      this.root.harnessUsage.brainstormError =
        error instanceof Error ? error.message : 'The comment could not be resolved.'
      return null
    }
  }

  async selectLofiPrototype(prototypeId: string): Promise<void> {
    const current = this.brainstorm
    if (!current || this.root.harnessUsage.brainstormBusy) return
    this.root.harnessUsage.brainstormBusy = true
    this.root.harnessUsage.brainstormError = ''
    try {
      this.applyBrainstormDocument(
        await invoke(
          'agent:reviewBrainstorm',
          current.projectId,
          current.threadId,
          current.id,
          current.version,
          `Generate one direct HiFi prototype H1 based on selected LoFi prototype ${prototypeId}. Preserve all existing LoFi prototypes and the aligned Brainstorm content.`,
          { fidelity: 'hifi', count: 1 }
        )
      )
    } catch (error) {
      this.root.harnessUsage.brainstormError =
        error instanceof Error ? error.message : 'The HiFi prototype could not be generated.'
    } finally {
      this.root.harnessUsage.brainstormBusy = false
    }
  }

  forkingMessageId = $state<string | null>(null)

  messagePendingDelete = $state<PendingMessageDelete | null>(null)

  deletingMessageId = $state<string | null>(null)

  /** Confirmation copy must state the exact scope of each delete mode. */
  deleteConfirmTitle = $derived.by(() => {
    switch (this.messagePendingDelete?.mode) {
      case 'single':
        return 'Delete just this message?'
      case 'up':
        return 'Delete from this point up?'
      default:
        return 'Delete from this point down?'
    }
  })

  deleteConfirmBody = $derived.by(() => {
    const content = this.messagePendingDelete?.content.trim() ?? ''
    const subject = content.length > 0 ? `“${content.slice(0, 80)}”` : 'This message'
    switch (this.messagePendingDelete?.mode) {
      case 'single':
        return `Only ${subject} and its work trace will be deleted. Earlier and later messages stay and the conversation closes over the gap.`
      case 'up':
        return `${subject} and every message before it will be deleted. Later messages remain as the start of the conversation.`
      default:
        return `${subject} and every message after it will be deleted. Earlier messages remain as the start of the conversation.`
    }
  })

  /** Fork the thread from this message upwards into a new conversation. */
  async forkFromMessage(msg: AgentMessage): Promise<void> {
    if (this.forkingMessageId) return
    this.forkingMessageId = msg.id
    try {
      const forked = await invoke(
        'thread:fork',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        `${this.root.handleAgentEvent.thread.title} (fork)`,
        undefined,
        msg.id
      )
      this.root.props.onForked?.(forked)
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The chat could not be forked.'
    } finally {
      this.forkingMessageId = null
    }
  }

  /** Fork from a message selected in the history side panel (by id). */
  async forkFromHistoryMessage(id: string): Promise<void> {
    if (this.forkingMessageId || this.root.switchProject.busy) return
    const msg = this.root.loadOlderMessages.messages.find((candidate) => candidate.id === id)
    if (msg) {
      await this.forkFromMessage(msg)
      return
    }
    // The message may live outside the loaded window   fork by id directly.
    this.forkingMessageId = id
    try {
      const forked = await invoke(
        'thread:fork',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        `${this.root.handleAgentEvent.thread.title} (fork)`,
        undefined,
        id
      )
      this.root.props.onForked?.(forked)
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The chat could not be forked.'
    } finally {
      this.forkingMessageId = null
    }
  }

  /** Open the confirmation dialog before deleting history up to and including a message. */
  requestDeleteMessage(msg: AgentMessage): void {
    if (this.root.switchProject.busy) return
    this.messagePendingDelete = { id: msg.id, content: messageText(msg), mode: 'down' }
  }

  /** Open the confirmation dialog for a deletion requested from the history side panel. */
  requestHistoryMessageDelete(id: string, content: string, mode: 'down' | 'single' | 'up'): void {
    if (this.root.switchProject.busy) return
    this.messagePendingDelete = { id, content, mode }
  }

  cancelDeleteMessage(): void {
    this.messagePendingDelete = null
  }

  /** Delete history around the pending message, discarding the harness session. */
  async confirmDeleteMessage(): Promise<void> {
    const pending = this.messagePendingDelete
    if (!pending || this.deletingMessageId) return
    this.messagePendingDelete = null
    this.deletingMessageId = pending.id
    try {
      // Deletion drops the chosen span and the harness session. The next send
      // rebinds a fresh session via prepareSessionForSend, which replays the
      // remaining mirrored transcript as context.
      if (this.root.props.controller?.removeAround) {
        // Controller-driven conversations (temporary chats) own their backend
        // deletion   the thread mirror must never be touched for them.
        await this.root.props.controller.removeAround(pending.id, pending.mode)
      } else {
        await threadMessages.remove(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          pending.id,
          pending.mode
        )
        // The persisted user-message history changed   force a reload so the
        // history panel never shows deleted messages.
        this.userMessageHistoryLoaded = false
        this.fullUserMessageHistory = []
        void this.refreshUserMessageHistory()
      }
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The message could not be deleted.'
    } finally {
      this.deletingMessageId = null
    }
  }
}
