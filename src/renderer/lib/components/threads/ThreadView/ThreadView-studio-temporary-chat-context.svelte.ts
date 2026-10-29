import { tick } from 'svelte'
import { createComposerAttachmentPreview } from '../../chats/chat-composer-preview.svelte'
import type { PreviewPagerState } from '../../ui/PreviewPager.svelte'
import { attachmentPreviewKind, isImageMime, isVideoMime } from '$lib/mime'
import { invoke } from '$lib/ipc.svelte'

import { assistants } from '$lib/stores/assistants.svelte'
import { buildAssistantTagCandidates } from '$lib/components/assistant/assistant-view'
import { contextSidebarState, EXPLAIN_SELECTION_PROMPT } from '$lib/stores/context-sidebar.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { type ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'
import { revealAnnotatedDocument } from '$lib/reveal-file'
import { documentAnnotationFocusState } from '$lib/stores/document-annotation-focus.svelte'
import { toast } from 'svelte-sonner'
import type {
  ThreadContextUsage,
  AgentCapabilityEntry,
  AgentMessage,
  AgentEvent,
  PromptAttachment,
  Project,
  EngineeringSpec,
  UsageEfficiencyKpis
} from '$shared/types'
import { type GenerationMessageUsage } from '$lib/generation-details'
import { annotationFallbackAnchor } from '$lib/selection-anchors'
import { providerReportedWindows } from '../thread-usage-merge'
import type { PreviewableFilePart, StudioTemporaryChatDocument } from './ThreadView-types'
import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewStudioTemporaryChatContext extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  /**
   * What the Assistant tab's composer offers behind an `@`: its assistants and
   * their threads. Every other view has no assistant space to point at, so the
   * list stays empty there and the menu is exactly what it always was.
   */
  assistantTagCandidates = $derived(
    this.root.props.assistantSpaceThreads
      ? buildAssistantTagCandidates({
          assistants: assistants.assistants,
          threads: this.root.props.assistantSpaceThreads,
          excludeThreadId: this.root.handleAgentEvent.thread.id,
          // The assistant's own icon is what identifies it on a tag, exactly as
          // it identifies the assistant in the tab.
          assistantIcons: assistants.iconUrls
        })
      : []
  )

  /** When this window learned the current run was busy, from the run store or a
   *  controller. In-memory only   a refresh re-seeds it at reconnect time   so it
   *  is the fallback for the live timer, not its authority: the persisted turn
   *  anchor below outranks it wherever the transcript still holds the prompt. */
  activeTurnStartTime = $derived(
    this.root.props.controller?.activeTurnStartTime ??
      (() => {
        const since = agentRuns.busySince(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id
        )
        return since && since > 0 ? since : undefined
      })()
  )

  streamedGenerationUsage = $state<{ messageId: string; usage: GenerationMessageUsage } | null>(
    null
  )

  recordGenerationUsage(
    event: Extract<AgentEvent, { type: 'message.completed' | 'usage.updated' }>
  ): void {
    const previous =
      this.streamedGenerationUsage?.messageId === event.messageId
        ? this.streamedGenerationUsage.usage
        : undefined
    this.streamedGenerationUsage = {
      messageId: event.messageId,
      usage: {
        ...previous,
        ...(event.harnessId ? { harnessId: event.harnessId } : {}),
        ...(event.providerId ? { providerId: event.providerId } : {}),
        ...(event.tokens ? { tokens: event.tokens } : {}),
        ...(event.normalizedUsage ? { normalizedUsage: event.normalizedUsage } : {}),
        tokenUsageScope: event.tokenUsageScope ?? 'message'
      }
    }
  }

  /** Stop the Engineering lifecycle from the prominent failure card. The failed
   *  stage already ended, so no in-flight turn needs the replacement guard
   *  cancelling reveals the normal card for the stage underneath. */
  async cancelEngineeringFailure(): Promise<void> {
    try {
      this.root.handleAgentEvent.engineeringLifecycle = await invoke(
        'engineeringLifecycle:cancel',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        true
      )
      this.root.contextUsage.updateSettings(
        this.root.harnessUsage.settingsForEngineeringState(
          this.root.handleAgentEvent.engineeringLifecycle
        )
      )
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The Engineering stage could not be cancelled.'
    }
  }

  /** Skills visible to the thread's active harness: harness-native, global-layer,
   *  and CodeInOven-registered (Utilities) skills. Rendered as slash actions. */
  capabilitySkills = $state<AgentCapabilityEntry[]>([])

  capabilityHarnessName = $state('')

  storedEfficiencyKpis = $state<UsageEfficiencyKpis | undefined>(undefined)

  efficiencyKpiRequestVersion = 0

  async refreshEfficiencyKpis(
    projectId = this.root.handleAgentEvent.thread.projectId,
    threadId = this.root.handleAgentEvent.thread.id
  ): Promise<void> {
    if (this.root.props.controller) return
    const requestVersion = ++this.efficiencyKpiRequestVersion
    try {
      const kpis = await invoke('thread:efficiencyKpis', projectId, threadId)
      if (
        requestVersion !== this.efficiencyKpiRequestVersion ||
        projectId !== this.root.handleAgentEvent.thread.projectId ||
        threadId !== this.root.handleAgentEvent.thread.id
      ) {
        return
      }
      this.storedEfficiencyKpis = kpis
    } catch {
      // Efficiency telemetry is best-effort and must never disrupt the thread.
    }
  }

  /**
   * Seed the meter from a thread-attached usage snapshot. The snapshot lives on
   * the thread row (not localStorage), so it restores instantly on mount, is
   * validated for integrity, and is evacuated automatically when the thread is
   * deleted. Usage never carries across a harness/provider switch, so the
   * snapshot is only shown when it belongs to the thread's current provider.
   */
  seedContextUsageSnapshot(snapshot: ThreadContextUsage | undefined): void {
    if (!snapshot || this.root.contextUsage.contextUsageDisplay) return
    if (
      snapshot.harnessId !== this.root.loadOlderMessages.settings.harnessId ||
      snapshot.providerId !== this.root.loadOlderMessages.settings.providerId
    ) {
      return
    }
    // A snapshot persisted before the synthetic usage-limit bar was retired can
    // still carry that window; strip it on read so the battery only ever shows
    // provider-reported quota.
    this.root.contextUsage.contextUsageDisplay = {
      ...snapshot,
      rateLimits: providerReportedWindows(snapshot.rateLimits ?? [])
    }
  }

  /** Fullscreen preview for a message attachment: the same cache the composer
   *  previews attachments with, keyed by the attachment's `file://` URL. */
  attachmentPreview = createComposerAttachmentPreview()

  /**
   * The queued message's own files, open fullscreen. They are files the user
   * attached rather than material the agent delivered, so they carry no
   * annotation surface and they render through the same cache that feeds the
   * chips' thumbnails.
   */
  queuedAttachmentViewer = $state<{ items: PromptAttachment[]; index: number } | null>(null)

  /** The message file parts a fullscreen preview can render, and which one is
   *  open. Parts no preview can render stay out of `items`, so the pager walks
   *  only the attachments that can be shown. */
  messageViewer = $state<{
    items: PreviewableFilePart[]
    index: number
    /** The message the parts came from, so a mark can name what it was drawn on. */
    messageId: string
    /**
     * Whether this message published its parts as an inline artifact, which is
     * what makes its pictures annotatable. A mark is answered back to the agent
     * as an attachment beside the comment, so the lane is for the material the
     * agent delivered, not for what the user attached themselves.
     */
    annotatable: boolean
    /**
     * Where the media was up to when it was opened: an inline video hands over
     * its position, so the fullscreen player starts where the small one stopped
     * instead of at the beginning.
     */
    startAt?: number
    /**
     * Whether that media was running when it was handed over.
     *
     * The inline player stays mounted behind this surface, so it is stopped before
     * the hand-off; without carrying the state over, clicking fullscreen on a
     * playing recording paused it. Only the item that was opened keeps it: paging
     * to a sibling is a fresh look at another file.
     */
    playing?: boolean
  } | null>(null)

  /**
   * Where a selection's comment opens when its highlight cannot be measured.
   *
   * A quoted excerpt has no rect while its message is outside the mounted
   * window, while the conversation is hidden behind another view, or after a
   * rebuild failed. The comment is still attached to the next message, so its
   * editor docks on the message that carries the excerpt, and on the top of the
   * conversation when even that message is not mounted.
   */
  responseAnchorFallback(id: string): { x: number; y: number } | null {
    const messageId = this.root.steerQueuedMessage.annotationReferences.find(
      (reference) => reference.id === id
    )?.messageId
    const rect = messageId
      ? document.getElementById(`msg-${messageId}`)?.getBoundingClientRect()
      : undefined
    if (rect && rect.width > 0 && rect.height > 0) {
      return { x: Math.round(rect.left + Math.min(rect.width / 2, 240)), y: Math.round(rect.top) }
    }
    return annotationFallbackAnchor(this.root.loadOlderMessages.scrollEl)
  }

  /**
   * Jump to the document one annotation was made in: reveal it in the project tree
   * and open it in the annotate view, which is the only surface that draws the
   * annotated passage and its note, then open that note. A document that has since
   * been deleted has nothing to show, so it is reported rather than opened.
   */
  editDocumentAnnotation(reference: ResponseReferenceAnchor): void {
    const path = reference.filePath
    if (!path) return
    void revealAnnotatedDocument(this.root.handleAgentEvent.thread.projectId, path).then(
      (opened) => {
        if (!opened) {
          toast.error('The annotated document is no longer in this project.', {
            description: path
          })
          return
        }
        documentAnnotationFocusState.request(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          reference.id
        )
      }
    )
  }

  /**
   * Bring a commented design element back in front of the reader.
   *
   * The comment outlives the page it was written on, so the edit action hands the
   * reference to the browser's inspection session, which reopens the screen it was
   * picked from when that page is closed and reveals the element again. A folder or
   * page that has since been deleted has nothing to show, and the session reports
   * that instead of opening a substitute.
   */
  editDesignAnnotation(reference: ResponseReferenceAnchor): void {
    // The design inspector is the browser's own session and is not part of the
    // conversation this view owns. Importing it statically would carry the browser
    // inspector into the first-paint chunk through the thread view, so it is
    // loaded on demand; by the time a comment needs focusing the browser is open
    // and the module is already in memory.
    void import('$lib/stores/browser-inspector.svelte').then((module) =>
      module.browserInspector.revealComment(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        reference
      )
    )
  }

  /** Where the open comment editor anchors.
   *
   * The measured bubble position when the highlight is on screen, and the
   * message's own anchor when it is not: the editor is gated on this reference
   * existing, never on the highlight happening to be measurable, so editing a
   * comment can never silently do nothing. */
  commentEditorAnchor = $derived.by(() => {
    const id = this.root.steerQueuedMessage.commentEditorReferenceId
    if (!id) return null
    return (
      this.root.steerQueuedMessage.responseBubblePositions[id] ?? this.responseAnchorFallback(id)
    )
  })

  responseReferenceContext(): string | undefined {
    if (this.root.steerQueuedMessage.responseReferences.length === 0) return undefined
    return [
      'The user quoted excerpts from your earlier response as references, may have picked elements from a design open in the app browser or from an HTML or SVG artifact you rendered in this conversation, may have annotated passages of a project document in the file panel, may have noted moments on a video composition timeline in the video board, and may have drawn numbered marks on a picture you rendered in the conversation. A reference carrying a "User comment:" line is user-authored input that your reply must explicitly address   if it asks a question, answer it; if it corrects or challenges, respond to it; never treat it as ignorable context. A design element reference points at an element in the design by its CSS path, so change that element where it is defined rather than a page that merely resembles it. An artifact element reference names the artifact it was picked in, the CSS path of the element inside it and the text of the element, so change the markup of that artifact at that element rather than a different render that happens to look alike. A file reference names the document it came from and quotes the passage the user marked, so read that file and address each annotation. A video note names a composition and a timecode on it, so change what the composition draws at that moment   the frame function, the timeline placement or the caption that covers it   rather than the file as a whole. An image reference names a picture you rendered, describes the area the user marked on it, and is attached as the same picture with every mark drawn on it as its number, so read that attachment and change the picture where each numbered mark points rather than treating the mark as a separate request. References without a comment are context the user wants accounted for. Combine all references and the typed message into one work list and cover every item.',
      ...this.root.steerQueuedMessage.responseReferences.map((reference) => {
        const comment = reference.comment ? `User comment: ${reference.comment}\n` : ''
        const tag =
          reference.kind === 'design' || reference.kind === 'svg' || reference.kind === 'html'
            ? 'element'
            : reference.kind === 'file'
              ? 'file'
              : reference.kind === 'video'
                ? 'video'
                : reference.kind === 'image'
                  ? 'image'
                  : 'selection'
        return `[${reference.label}]\n${comment}<${tag}>\n${reference.text}\n</${tag}>`
      })
    ].join('\n\n')
  }

  specReadyToolVisible = $state(false)

  /** A retry may only follow a completed, non-error assistant response for the
   * current user turn. Older responses must not unlock a new spec request. */
  hasFinalAgentResponse = $derived.by(() => {
    let latestUserIndex = -1
    for (let index = this.root.loadOlderMessages.messages.length - 1; index >= 0; index -= 1) {
      if (this.root.loadOlderMessages.messages[index]?.role === 'user') {
        latestUserIndex = index
        break
      }
    }
    if (latestUserIndex === -1) return false
    return this.root.loadOlderMessages.messages
      .slice(latestUserIndex + 1)
      .some(
        (message) =>
          message.role === 'assistant' &&
          message.completedAt !== undefined &&
          message.error === undefined &&
          message.parts.some((part) => part.type === 'text' && part.text.trim().length > 0)
      )
  })

  STUDIO_TEMPORARY_CONTEXT_LIMIT = 90_000

  studioTemporaryChatContext(document: StudioTemporaryChatDocument, markdown: string): string {
    const label =
      document === 'brainstorm'
        ? 'Brainstorm'
        : document === 'spec'
          ? 'Specification'
          : document === 'assignment'
            ? 'Assignment'
            : 'Audit report'
    const boundedMarkdown =
      markdown.length <= this.STUDIO_TEMPORARY_CONTEXT_LIMIT
        ? markdown
        : `${markdown.slice(0, this.STUDIO_TEMPORARY_CONTEXT_LIMIT)}\n\n[Document truncated for context limit]`
    return [
      `The user is viewing this ${label} in Spec Studio. Treat it as read-only project context for questions about the attached selection.`,
      `<spec-studio-document type="${document}">`,
      boundedMarkdown,
      '</spec-studio-document>'
    ].join('\n\n')
  }

  openStudioSelectionChat(
    document: StudioTemporaryChatDocument,
    mode: 'elaborate' | 'quick',
    selection: string,
    documentContext: string
  ): void {
    const context = this.studioTemporaryChatContext(document, documentContext)
    contextSidebarState.openTemporaryChat(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      mode,
      selection,
      context,
      this.root.loadOlderMessages.settings,
      true,
      mode === 'elaborate' ? EXPLAIN_SELECTION_PROMPT : undefined
    )
  }

  /**
   * Bring one message element into view. A window that had to be remounted for
   * the jump may not have rendered on the first tick, so the lookup retries
   * across a few frames instead of giving up: the reader clicks once and
   * expects the message, not a first click that loads it and a later one that
   * finally reveals it.
   */
  async revealMessageById(id: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await tick()
      const element = document.getElementById(`msg-${id}`)
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }

  /** The row that carries the history button: it is the top of the mounted
   *  window, so the blocks a load mounts are exactly the ones between it and the
   *  seam the window already had (see `historyArrivedBlocks`). Plain local state,
   *  not `$state`: nothing renders from it, the load reads it when it runs. */
  historyHeadEl: HTMLElement | null = $state(null)

  /** Track the history row for as long as it is mounted. */
  trackHistoryHead(node: HTMLElement): () => void {
    this.historyHeadEl = node
    return () => {
      if (this.historyHeadEl === node) this.historyHeadEl = null
    }
  }

  /** The earliest block of the mounted window, the seam a history load inserts
   *  above. Must be read BEFORE the window moves: afterwards the seam sits under
   *  the pages that arrived on top of it. Null with an empty window, and while
   *  the history row is not mounted there is nothing for a load to insert above. */
  historySeamElement(): Element | null {
    return this.historyHeadEl?.nextElementSibling ?? null
  }

  /** The blocks a history load mounted, in document order. Element identity is
   *  the boundary and the window only ever grows upward, so every sibling above
   *  the seam and below the history row is new, whether it is a prompt, an
   *  answer, a working trace or a card. Walking it here rather than listing the
   *  mounted message ids is what lets one arrival cover the whole page instead of
   *  the message blocks alone. */
  historyArrivedBlocks(seam: Element | null): HTMLElement[] {
    const blocks: HTMLElement[] = []
    if (!this.historyHeadEl || !seam || !seam.isConnected) return blocks
    for (
      let node = seam.previousElementSibling;
      node && node !== this.historyHeadEl;
      node = node.previousElementSibling
    ) {
      if (node instanceof HTMLElement) blocks.push(node)
    }
    return blocks.reverse()
  }

  /** Re-check auth after a proactive sign-in and clear the card once it works. */
  async refreshAfterProactiveSignIn(): Promise<void> {
    try {
      const authenticated = await invoke(
        'agent:getHarnessAuthStatus',
        this.root.handleAgentEvent.thread.projectId,
        this.root.loadOlderMessages.settings.harnessId,
        this.root.loadOlderMessages.settings.accountId
      )
      if (authenticated === true) {
        this.root.submitBrainstormDecision.proactiveAuthIssue = null
        this.root.handleAgentEvent.providerStatus = null
      }
    } catch {
      // Keep the card; the user can dismiss it or send their message.
    }
  }

  /**
   * Discovery scope for the slash menu's commands and skills. Temporary side
   * chats own no Thread row, so their skills are discovered against the parent
   * thread's project scope combined with the side chat's own harness, which
   * the composer can switch before the first turn.
   */
  capabilityScope(): { projectId: string; threadId: string; harnessId?: string } {
    if (this.root.props.controller?.parentThreadId) {
      return {
        projectId: this.root.props.controller.projectId,
        threadId: this.root.props.controller.parentThreadId,
        harnessId: this.root.loadOlderMessages.settings.harnessId
      }
    }
    return {
      projectId: this.root.handleAgentEvent.thread.projectId,
      threadId: this.root.handleAgentEvent.thread.id
    }
  }

  /** Load the skills the thread's harness can see (harness-native, global, and
   *  CodeInOven-registered). Discovery is supplementary   the composer keeps
   *  working when it fails. */
  async refreshCapabilitySkills(): Promise<void> {
    const scope = this.capabilityScope()
    try {
      const capabilities = await invoke(
        'agent:listContextCapabilities',
        scope.projectId,
        scope.threadId,
        scope.harnessId
      )
      if (capabilities.harnessId !== this.root.loadOlderMessages.settings.harnessId) return
      this.capabilityHarnessName = capabilities.harnessName
      this.capabilitySkills = capabilities.skill
    } catch {
      // Capability discovery is supplementary; messaging remains available.
      this.capabilitySkills = []
    }
  }

  /** Ask the agent to load and follow a skill by name. This is the route for
   *  skills with no runnable native command in the current conversation (a
   *  side chat owns no thread row, and a global or CodeInOven skill is not a
   *  harness slash command at all). */
  requestSkillUse(skillName: string, args: string): void {
    const request = args.trim()
    this.root.harnessUsage.sendComposerMessage(
      request
        ? `${request}\n\n(Use the "${skillName}" skill for this.)`
        : `Use the "${skillName}" skill.`,
      []
    )
  }

  /** Invoke a capability skill the harness does not expose as a native slash
   *  command by sending a turn that asks the agent to load and follow it. */
  triggerCapabilitySkill(actionKey: string, args: string): void {
    const skill = this.capabilitySkills.find(
      (candidate) => `cio-skill:${candidate.id}` === actionKey
    )
    if (!skill) return
    this.requestSkillUse(skill.name, args)
  }

  /**
   * Every file part of `msg` that the fullscreen preview can render, in the
   * order the message shows them. A part with no preview is left out, so
   * navigation never lands on an empty frame.
   */
  previewableFileParts(msg: AgentMessage): PreviewableFilePart[] {
    const items: PreviewableFilePart[] = []
    for (const part of msg.parts) {
      if (part.type !== 'file') continue
      const filename = part.filename ?? part.url.split('/').pop() ?? 'file'
      const kind = attachmentPreviewKind(part.mime, filename)
      if (!kind) continue
      items.push({
        url: part.url,
        filename,
        mime: part.mime,
        media: kind === 'image' || kind === 'video' || kind === 'audio'
      })
    }
    return items
  }

  /** Prepare the payload for the item a preview is about to show: media render
   *  straight from the file through the blob cache, every other kind through
   *  the shared document/text cache. */
  loadViewerItem(item: PreviewableFilePart): void {
    if (item.media) return
    this.attachmentPreview.open({ mime: item.mime, url: item.url, filename: item.filename })
  }

  /** Move the open preview by `delta` items, loading the payload it lands on. */
  stepMessageViewer(delta: number): void {
    const viewer = this.messageViewer
    if (!viewer) return
    const index = viewer.index + delta
    if (index < 0 || index >= viewer.items.length) return
    this.messageViewer = {
      items: viewer.items,
      index,
      messageId: viewer.messageId,
      annotatable: viewer.annotatable
    }
    this.loadViewerItem(viewer.items[index])
  }

  closeMessageViewer(): void {
    this.messageViewer = null
    this.attachmentPreview.close()
  }

  /**
   * Open one of the queued message's files fullscreen, stepping between its
   * siblings. Only files a preview can render are listed, so the pager never
   * lands on an empty frame.
   */
  openQueuedAttachment(attachment: PromptAttachment): void {
    const items = this.root.steerQueuedMessage.queuedAttachments.filter((file) =>
      attachmentPreviewKind(file.mime, file.filename ?? 'file')
    )
    const index = items.findIndex((item) => item.url === attachment.url)
    const item = items[index]
    if (!item) return
    this.queuedAttachmentViewer = { items, index }
    void this.attachmentPreview.load(item)
  }

  /** Move the open queued-file preview by `delta` and read the file it lands on. */
  stepQueuedAttachmentViewer(delta: number): void {
    const viewer = this.queuedAttachmentViewer
    if (!viewer) return
    const index = viewer.index + delta
    const item = viewer.items[index]
    if (!item) return
    this.queuedAttachmentViewer = { items: viewer.items, index }
    void this.attachmentPreview.load(item)
  }

  closeQueuedAttachmentViewer(): void {
    this.queuedAttachmentViewer = null
    this.attachmentPreview.close()
  }

  /** Sibling navigation for the open queued-file preview, absent for a message
   *  that carries fewer than two previewable files. */
  queuedAttachmentPager = $derived.by<PreviewPagerState | undefined>(() => {
    const viewer = this.queuedAttachmentViewer
    if (!viewer || viewer.items.length < 2) return undefined
    return {
      index: viewer.index,
      count: viewer.items.length,
      onPrevious: () => this.stepQueuedAttachmentViewer(-1),
      onNext: () => this.stepQueuedAttachmentViewer(1)
    }
  })

  /** Sibling navigation for the open message preview, absent for a message with
   *  fewer than two previewable attachments. */
  messageViewerPager = $derived.by<PreviewPagerState | undefined>(() => {
    const viewer = this.messageViewer
    if (!viewer || viewer.items.length < 2) return undefined
    return {
      index: viewer.index,
      count: viewer.items.length,
      onPrevious: () => this.stepMessageViewer(-1),
      onNext: () => this.stepMessageViewer(1)
    }
  })

  /**
   * The item the open lightbox is showing when it is material a mark can be
   * drawn on: an artifact picture or an artifact video. Null for everything
   * else, which is what keeps the plain lightbox plain.
   */
  viewerAnnotatableItem = $derived.by(() => {
    const viewer = this.messageViewer
    if (!viewer || !viewer.annotatable) return null
    const item = viewer.items[viewer.index]
    if (!item) return null
    return isImageMime(item.mime) || isVideoMime(item.mime) ? item : null
  })

  async cancelSpecReadyTool(): Promise<void> {
    const current = this.root.submitBrainstormDecision.spec
    if (!current) return
    this.specReadyToolVisible = false
    try {
      await invoke(
        'thread:dismissSpecReview',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        current.id,
        current.version
      )
    } catch (error) {
      this.specReadyToolVisible = true
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The specification review could not be cancelled.'
    }
  }

  proceedWithReadySpec(): void {
    const current = this.root.submitBrainstormDecision.spec
    if (!current) return
    if (this.root.loadOlderMessages.settings.assignmentMode) {
      if (this.root.submitSpecDecision.assignment)
        this.root.submitSpecDecision.openAssignmentStudio()
      else void this.root.submitSpecDecision.generateAssignmentDraft()
      return
    }
    this.specReadyToolVisible = false
    void this.root.submitSpecDecision.submitSpecDecision('implement', current, '')
  }

  updateSpecAnnotation(annotationId: string, body: string): Promise<EngineeringSpec | null> {
    const current = this.root.submitBrainstormDecision.spec
    if (!current) return Promise.resolve(null)
    return this.root.abortRun.runSpecAction(() =>
      invoke(
        'spec:updateAnnotation',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        current.id,
        current.version,
        annotationId,
        body
      )
    )
  }

  // ─── Continue a chat in a project ──────────────────────────────────────

  continueInProjectOpen = $state(false)

  continueInProjectBusy = $state(false)

  openContinueInProject(): void {
    this.continueInProjectOpen = true
  }

  /** Continue the whole chat conversation as a new thread in the chosen project. */
  async continueChatInProject(project: Project): Promise<void> {
    if (this.continueInProjectBusy) return
    this.continueInProjectBusy = true
    try {
      const forked = await invoke(
        'thread:fork',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        this.root.handleAgentEvent.thread.title,
        undefined,
        undefined,
        project.id
      )
      this.continueInProjectOpen = false
      this.root.props.onContinueInProject?.(forked)
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The chat could not be continued in a project.'
    } finally {
      this.continueInProjectBusy = false
    }
  }
}
