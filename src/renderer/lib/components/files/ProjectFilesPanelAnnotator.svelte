<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import { onDestroy, tick } from 'svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import ResponseAnnotationBubble from '../chats/ResponseAnnotationBubble.svelte'
  import ResponseAnnotationComment from '../chats/ResponseAnnotationComment.svelte'
  import ResponseSelectionPopover from '../chats/ResponseSelectionPopover.svelte'
  import {
    applyAnnotationHighlights,
    measureAnnotationBubbles,
    rangeForAnnotation,
    releaseAnnotationHighlights,
    ANNOTATION_BUBBLE_SIZE,
    type AnnotationBubblePosition
  } from '$lib/selection-anchors'
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
  }

  let { projectId, threadId, path, content }: Props = $props()

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
  const editingPosition = $derived(editingId ? bubblePositions[editingId] : undefined)

  /** One-based position in the composer, so a bubble and the composer chip for
   *  the same annotation are named by the same number. */
  function annotationNumber(id: string): number {
    return threadReferences.findIndex((reference) => reference.id === id) + 1
  }

  /** Re-measure where each annotation's bubble belongs in the viewport. */
  function updateBubbles(): void {
    bubblePositions = measureAnnotationBubbles(scroller, ranges)
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
  }

  /** Spin the selected passage into a thread of its own, seeded as its draft. */
  function openPassageThread(): void {
    const candidate = pendingSelection
    if (!candidate) return
    closeSelection()
    openPassageInNewThread(projectId, threadId, candidate.text)
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
    <div bind:this={documentRoot}>
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
  <ResponseSelectionPopover
    text={pendingSelection.text}
    x={pendingSelection.x}
    y={pendingSelection.y}
    selectionLabel="passage"
    onAdd={addAnnotation}
    onElaborate={() => openPassageChat('elaborate')}
    onQuickChat={() => openPassageChat('quick')}
    onNewThread={openPassageThread}
    onClose={closeSelection}
  />
{/if}

{#if editingReference && editingPosition}
  <ResponseAnnotationComment
    x={editingPosition.x + ANNOTATION_BUBBLE_SIZE / 2}
    y={editingPosition.y}
    initialComment={editingReference.comment ?? ''}
    targetId={`document-annotation-${threadId}-${editingReference.id}`}
    scope={{ kind: 'project', projectId }}
    onDraftChange={(comment) => persistCommentDraft(editingReference.id, comment)}
    onDone={(comment) => saveComment(editingReference.id, comment)}
    onRemove={() => removeAnnotation(editingReference.id)}
    onClose={() => (editingId = null)}
  />
{/if}
