<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import { onDestroy, tick } from 'svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import ResponseAnnotationBubble from '../chats/ResponseAnnotationBubble.svelte'
  import ResponseAnnotationComment from '../chats/ResponseAnnotationComment.svelte'
  import SelectionActionMenu from '../shared/SelectionActionMenu.svelte'
  import {
    annotationAtPoint,
    anchorTextMatches,
    annotationFallbackAnchor,
    applyAnnotationHighlights,
    measureAnnotationBubbles,
    rangeForAnnotation,
    releaseAnnotationHighlights,
    withUnmeasuredAnchors,
    ANNOTATION_BUBBLE_SIZE,
    type AnnotationBubblePosition
  } from '$lib/selection-anchors'
  import {
    registerSelectionAnnotationClaim,
    isEditingTarget,
    trackLiveSelection
  } from '$lib/selection-menu'
  import { responseReferencesState } from '$lib/stores/response-references.svelte'
  import { contextSidebarState, EXPLAIN_SELECTION_PROMPT } from '$lib/stores/context-sidebar.svelte'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import { documentAnnotationFocusState } from '$lib/stores/document-annotation-focus.svelte'
  import { openPassageInNewThread } from '$lib/quoted-passage'
  import {
    captureDocumentSelection,
    documentAnnotationChatContext,
    documentAnnotationReference,
    type DocumentSelectionCandidate
  } from './project-files-panel-annotator'

  interface Props {
    projectId: string
    /** The conversation whose composer takes the annotations. */
    threadId: string
    /** Project-relative path of the document being annotated. */
    path: string
    /** Source being rendered, which is the file's draft while it is edited. */
    content: string
    /** True when this view is the fullscreen reader. Its sidebar is behind the
     *  modal, so an action that lands there has to give the modal up. */
    fullscreen?: boolean
    /** Dismiss the fullscreen reader. Required to leave it from an action. */
    onExitFullscreen?: () => void
  }

  let { projectId, threadId, path, content, fullscreen = false, onExitFullscreen }: Props = $props()

  /** Highlight registry name for document annotations. A conversation
   *  publishes its own name, so both a conversation and a document can be
   *  annotated on screen at the same time. */
  const DOCUMENT_HIGHLIGHT_NAME = 'document-annotation-anchor'
  /** This view's identity as that name's publisher, so another view tearing
   *  down can never clear the highlights this one published. */
  const highlightOwner = {}

  let scroller = $state<HTMLDivElement | null>(null)
  /** The rendered document every anchor offset is resolved against. */
  let documentRoot = $state<HTMLDivElement | null>(null)
  let pendingSelection = $state<DocumentSelectionCandidate | null>(null)
  /** Whether the selection menu is on screen. Read as a flag rather than as the
   *  candidate itself: the menu follows the passage the user keeps highlighting,
   *  and a tracker keyed on the candidate would re-register on every keystroke of
   *  the selection instead of once while the menu is open. */
  const selectionMenuOpen = $derived(Boolean(pendingSelection))
  let editingId = $state<string | null>(null)
  let bubblePositions = $state<Record<string, AnnotationBubblePosition>>({})
  const ranges = new SvelteMap<string, Range>()
  let destroyed = false
  let bubbleFrame = 0

  /** Everything the conversation's composer is carrying, in the order it
   *  numbers those references. */
  const threadReferences = $derived(responseReferencesState.forThread(projectId, threadId))
  /** The slice that belongs to this document: an annotation is pinned by the
   *  document it was made in, so another file's annotations are not drawn here
   *  even though they travel in the same message. */
  const annotations = $derived(
    threadReferences.filter((reference) => reference.kind === 'file' && reference.filePath === path)
  )
  /** What the anchors currently resolve to. Reading the anchor fields, not just
   *  the count, means a re-anchor only happens when a passage actually moved. */
  const anchorSignature = $derived(
    annotations
      .map(
        (reference) =>
          `${reference.id}:${reference.startOffset}:${reference.endOffset}:${reference.text}`
      )
      .join('\n')
  )
  const editingReference = $derived(
    annotations.find((reference) => reference.id === editingId) ?? null
  )
  /** Where the open note editor anchors. A note whose passage can no longer be
   *  found in the document (the agent rewrote it) is still attached to the next
   *  message, so its editor docks on the panel instead of the action doing
   *  nothing. */
  const editingAnchor = $derived(
    editingId ? (bubblePositions[editingId] ?? annotationFallbackAnchor(scroller)) : null
  )

  /** One-based position in the composer, so a bubble and the composer chip for
   *  the same annotation are named by the same number. */
  function annotationNumber(id: string): number {
    return threadReferences.findIndex((reference) => reference.id === id) + 1
  }

  /** Re-measure where each annotation's bubble belongs in the viewport. */
  function updateBubbles(): void {
    bubblePositions = withUnmeasuredAnchors(
      measureAnnotationBubbles(scroller, ranges),
      annotations.map((reference) => reference.id),
      () => annotationFallbackAnchor(scroller)
    )
  }

  function scheduleBubbleUpdate(): void {
    if (bubbleFrame) return
    bubbleFrame = requestAnimationFrame(() => {
      bubbleFrame = 0
      updateBubbles()
    })
  }

  /**
   * Bring the live annotation ranges back in line with the rendered document.
   *
   * Deliberately not a one-shot restore: the document is replaced whenever the
   * content changes or a block re-renders, and a range built before that points
   * at text nodes that are gone, which paints no highlight and measures no
   * bubble. A passage that can no longer be found (the agent rewrote the
   * document) keeps its annotation attached to the composer, it simply stops
   * being pinned.
   */
  function syncAnnotations(): void {
    const liveIds = annotations.map((reference) => reference.id)
    for (const reference of annotations) {
      // A range that still spans the passage it was built for is kept as it is.
      // Rebuilding it would replace the live selection the annotation was just
      // made from with a reconstructed one, and a rebuild that lands on a
      // rewritten document is the only way the range can be lost at all.
      const existing = ranges.get(reference.id)
      if (
        existing &&
        existing.startContainer.isConnected &&
        existing.endContainer.isConnected &&
        anchorTextMatches(existing, reference.text)
      ) {
        continue
      }
      const range = documentRoot
        ? rangeForAnnotation(documentRoot, {
            startOffset: reference.startOffset,
            endOffset: reference.endOffset,
            // The excerpt is the anchor's check value: when the document is
            // rewritten the offsets are verified against the passage before a
            // highlight is drawn, and the passage is searched for by text when
            // it has moved.
            quote: reference.text
          })
        : null
      if (!range) {
        ranges.delete(reference.id)
        continue
      }
      ranges.set(reference.id, range)
    }
    for (const id of [...ranges.keys()]) if (!liveIds.includes(id)) ranges.delete(id)
    applyAnnotationHighlights(ranges, highlightOwner, DOCUMENT_HIGHLIGHT_NAME)
    scheduleBubbleUpdate()
  }

  function captureSelection(): void {
    pendingSelection = captureDocumentSelection(documentRoot)
  }

  function closeSelection(): void {
    pendingSelection = null
    document.getSelection()?.removeAllRanges()
  }

  /**
   * The candidate a right-click opens for a passage already annotated here.
   *
   * A right-click on a highlight asks to work on that passage again, so the
   * candidate is rebuilt from the annotation rather than from the document
   * selection, which is collapsed when the user right-clicks without selecting
   * the passage first.
   */
  function annotationSelectionCandidate(
    referenceId: string,
    x: number,
    y: number
  ): DocumentSelectionCandidate | null {
    const reference = annotations.find((candidate) => candidate.id === referenceId)
    const range = ranges.get(referenceId)
    if (!reference || !range) return null
    if (reference.startOffset === undefined || reference.endOffset === undefined) return null
    return {
      text: reference.text,
      range,
      startOffset: reference.startOffset,
      endOffset: reference.endOffset,
      anchor: { x, y },
      referenceId
    }
  }

  /**
   * Take a right-click that landed in the rendered document.
   *
   * The menu is the one a highlight opens, at the cursor instead of beside the
   * passage, so both ways of reaching a passage's actions are one control. A
   * click on a passage that already carries a note opens that note's editor
   * along with the menu, which is how a note is found again from the words it
   * was written about.
   */
  function claimDocumentSelectionMenu(event: MouseEvent): boolean {
    const target = event.target
    if (!(target instanceof Element)) return false
    if (!target.closest('[data-annotation-surface]')) return false
    if (isEditingTarget(target)) return false
    // A link and an external-address control answer for themselves, so their
    // menu keeps the items that open them.
    if (target.closest('a, [data-external-url]')) return false
    const annotatedId = annotationAtPoint(ranges, event.clientX, event.clientY)
    const candidate = annotatedId
      ? annotationSelectionCandidate(annotatedId, event.clientX, event.clientY)
      : captureDocumentSelection(documentRoot)
    if (!candidate) return false
    event.preventDefault()
    event.stopPropagation()
    if (annotatedId) editingId = annotatedId
    pendingSelection = candidate
    return true
  }

  /** What the menu's note item does: write a note on a passage, or reopen the
   *  one a passage already carries. */
  function writeNoteOnSelection(): void {
    const candidate = pendingSelection
    if (!candidate) return
    const referenceId = candidate.referenceId
    if (referenceId) {
      closeSelection()
      editingId = referenceId
      return
    }
    addAnnotation()
  }

  /**
   * Follow the selection while the menu is open.
   *
   * Shift and an arrow key extend or trim a selection with no pointer event, and
   * the menu has to describe the passage highlighted now rather than the one
   * highlighted when the pointer came up. A selection that collapses or leaves
   * the document closes the menu, which is what its absence means.
   */
  /**
   * Whether an emptied selection happened inside this document.
   *
   * A caret that has moved into a field is not the user clearing this passage:
   * the note editor takes focus the moment the menu opens a note, and a menu
   * that closed on that would take the actions away from the note being written.
   * A selection that emptied inside the document is the passage being cleared,
   * and closes the menu.
   */
  function selectionTouchesDocument(): boolean {
    const selection = document.getSelection()
    const root = documentRoot
    if (!selection || !root) return true
    return root.contains(selection.anchorNode) || root.contains(selection.focusNode)
  }

  $effect(() => {
    if (!selectionMenuOpen) return
    return trackLiveSelection(
      () => captureDocumentSelection(documentRoot),
      (candidate) => {
        if (!candidate && !selectionTouchesDocument()) return
        pendingSelection = candidate
      }
    )
  })

  /** Own the right-click menu inside this document while its view is mounted. */
  $effect(() => registerSelectionAnnotationClaim(claimDocumentSelectionMenu))

  /** Attach the passage to the conversation's composer and open its note editor,
   *  exactly like a response selection: the passage is already part of the next
   *  message before the note is written. */
  function addAnnotation(): void {
    const candidate = pendingSelection
    if (!candidate) return
    const id = crypto.randomUUID()
    responseReferencesState.setForThread(projectId, threadId, [
      ...threadReferences,
      documentAnnotationReference(id, path, candidate)
    ])
    ranges.set(id, candidate.range)
    applyAnnotationHighlights(ranges, highlightOwner, DOCUMENT_HIGHLIGHT_NAME)
    updateBubbles()
    editingId = id
    closeSelection()
  }

  /**
   * Open a read-only side chat about the selected passage.
   *
   * The document is the pinned context, the way a studio hands its own document
   * to the same side chat: a passage read on its own is often unreadable without
   * the section around it, and the context names the file the passage sits in, so
   * the agent can go and read the live copy rather than trusting the snapshot.
   *
   * The settings are the app's last-used project-thread settings, not this
   * conversation's live ones: the side chat is opened by a panel, which is not the
   * conversation and owns no settings of its own. That is how every other panel
   * outside the conversation opens a side chat.
   */
  function openPassageChat(mode: 'elaborate' | 'quick'): void {
    const candidate = pendingSelection
    if (!candidate) return
    contextSidebarState.openTemporaryChat(
      projectId,
      threadId,
      mode,
      candidate.text,
      documentAnnotationChatContext(path, content),
      threadSettings.lastUsed,
      true,
      mode === 'elaborate' ? EXPLAIN_SELECTION_PROMPT : undefined
    )
    closeSelection()
    // The side chat opens in the sidebar, which the fullscreen reader covers.
    // Leaving fullscreen is what makes the action visible at all.
    if (fullscreen) onExitFullscreen?.()
  }

  /** Spin the selected passage into a thread of its own, seeded as its draft. */
  function openPassageThread(): void {
    const candidate = pendingSelection
    if (!candidate) return
    closeSelection()
    openPassageInNewThread(projectId, threadId, candidate.text)
    if (fullscreen) onExitFullscreen?.()
  }

  /** Save or clear the note attached to one annotation. */
  function saveComment(id: string, comment: string): void {
    responseReferencesState.updateComment(projectId, threadId, id, comment)
    editingId = null
  }

  function persistCommentDraft(id: string, comment: string): void {
    responseReferencesState.updateCommentDraft(projectId, threadId, id, comment)
  }

  /** Remove the annotation from the document and from the next message in one
   *  step: there is no separate annotation store to clean up. */
  function removeAnnotation(id: string): void {
    responseReferencesState.setForThread(
      projectId,
      threadId,
      threadReferences.filter((reference) => reference.id !== id)
    )
    ranges.delete(id)
    applyAnnotationHighlights(ranges, highlightOwner, DOCUMENT_HIGHLIGHT_NAME)
    updateBubbles()
    if (editingId === id) editingId = null
  }

  // Re-anchor whenever the document or the annotation set changes.
  $effect(() => {
    void content
    void anchorSignature
    void tick().then(() => {
      if (destroyed) return
      syncAnnotations()
    })
  })

  /**
   * A composer edit action lands here: it names one annotation, and this view is
   * where that annotation's passage and note are drawn. The request can arrive
   * before this view exists, because the same click is what opens the document, so
   * it stays pending until the annotation it names is on screen.
   */
  $effect(() => {
    const request = documentAnnotationFocusState.pending(projectId, threadId)
    if (!request) return
    const target = annotations.find((reference) => reference.id === request.referenceId)
    if (!target) return
    editingId = target.id
    documentAnnotationFocusState.consume(request.token)
  })

  // A pin is measured in viewport coordinates, so it has to be re-measured when
  // the panel it floats over changes size (a sidebar drag, a window resize).
  $effect(() => {
    const element = scroller
    if (!element) return
    const observer = new ResizeObserver(scheduleBubbleUpdate)
    observer.observe(element)
    return () => observer.disconnect()
  })

  onDestroy(() => {
    destroyed = true
    if (bubbleFrame) cancelAnimationFrame(bubbleFrame)
    releaseAnnotationHighlights(highlightOwner, DOCUMENT_HIGHLIGHT_NAME)
  })
</script>

<div class="relative flex min-h-0 flex-1 flex-col">
  <div
    bind:this={scroller}
    class="min-h-0 flex-1 overflow-auto px-4 py-3"
    role="document"
    aria-label={`Annotated preview of ${path}`}
    onpointerup={captureSelection}
    onscroll={scheduleBubbleUpdate}
  >
    <div bind:this={documentRoot} data-annotation-surface>
      <MarkdownView text={content} class="text-sm text-foreground" />
    </div>
  </div>
</div>

<!-- Comment bubbles pinned to the annotated passages of this document -->
{#each annotations as reference (reference.id)}
  {@const position = bubblePositions[reference.id]}
  {#if position?.visible}
    <ResponseAnnotationBubble
      x={position.x}
      y={position.y}
      number={annotationNumber(reference.id)}
      hasComment={Boolean(reference.comment)}
      active={editingId === reference.id}
      title={reference.comment
        ? `Edit the note on this passage of ${path}`
        : `Add a note to this passage of ${path}`}
      onClick={() => (editingId = reference.id)}
    />
  {/if}
{/each}

{#if pendingSelection}
  <SelectionActionMenu
    text={pendingSelection.text}
    anchor={pendingSelection.anchor}
    selectionLabel="passage"
    annotated={Boolean(pendingSelection.referenceId)}
    onComment={writeNoteOnSelection}
    onElaborate={() => openPassageChat('elaborate')}
    onQuickChat={() => openPassageChat('quick')}
    onNewThread={openPassageThread}
    onClose={closeSelection}
  />
{/if}

{#if editingReference && editingAnchor}
  <ResponseAnnotationComment
    x={editingAnchor.x + ANNOTATION_BUBBLE_SIZE / 2}
    y={editingAnchor.y}
    initialComment={editingReference.comment ?? ''}
    targetId={`document-annotation-${threadId}-${editingReference.id}`}
    scope={{ kind: 'project', projectId }}
    onDraftChange={(comment) => persistCommentDraft(editingReference.id, comment)}
    onDone={(comment) => saveComment(editingReference.id, comment)}
    onRemove={() => removeAnnotation(editingReference.id)}
    onClose={() => (editingId = null)}
  />
{/if}
