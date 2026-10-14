<script lang="ts">
  import { tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { SvelteMap } from 'svelte/reactivity'
  import { Check, Pencil } from '@lucide/svelte'
  import InlineImageFigure from './InlineImageFigure.svelte'
  import ResponseAnnotationComment from '../chats/ResponseAnnotationComment.svelte'
  import {
    responseReferencesState,
    type ResponseReferenceAnchor
  } from '$lib/stores/response-references.svelte'
  import {
    IMAGE_MARK_BADGE_SIZE,
    IMAGE_MARK_STROKE_WIDTH,
    IMAGE_MARK_TAP_SLOP_PX,
    imageMarkBadgePoint,
    imageMarkDescriptor,
    imageMarkPointsAttribute,
    normalizeImageMark,
    referenceMarkNumber,
    type ImageMarkPoint
  } from '$lib/image-annotation'
  import type { FileBlobUrlManager } from '$lib/media-urls.svelte.ts'

  /**
   * The mark surface for one inline artifact picture.
   *
   * A picture the agent rendered is the one artifact a user most often wants to
   * answer by pointing at it, and text alone cannot say where. This draws a
   * freehand mark over the picture, keeps every mark as a composer reference
   * (so it is listed, commented, cleared and sent exactly like the app's other
   * annotations), and hands the numbered marks to the send path, which rebuilds
   * the picture with the marks drawn on it. Audio and video get no inspector:
   * there is nothing to point at.
   */
  interface Props {
    projectId: string
    threadId: string
    url: string
    mime: string
    filename: string
    imageUrls: FileBlobUrlManager
    /** The message the picture arrived in, so a mark can be jumped back to. */
    messageId?: string
    /** Marks already drawn on this picture, in composer order. */
    marks: ResponseReferenceAnchor[]
    /** A mark whose comment the user asked to edit from elsewhere. */
    editingId: string | null
    /** Open the fullscreen viewer. */
    onExpand: () => void
    /** The comment editor closed, so the caller can clear its request. */
    onEditClosed: () => void
  }

  let {
    projectId,
    threadId,
    url,
    mime,
    filename,
    imageUrls,
    messageId,
    marks,
    editingId,
    onExpand,
    onEditClosed
  }: Props = $props()

  /** Whether the pointer draws on the picture instead of opening it. */
  let armed = $state(false)
  /** The stroke being drawn, in normalized coordinates. */
  let draftPoints = $state<ImageMarkPoint[]>([])
  /** The mark whose editor this surface opened by itself. */
  let localEditingId = $state<string | null>(null)
  /** Bumped whenever the open editor must re-measure against the layout. */
  let measureToken = $state(0)

  /**
   * Badge elements by reference id.
   *
   * The open editor is anchored to its own badge, so this is how the editor
   * follows the picture through scrolling and resizing rather than being placed
   * once and drifting away from the mark it comments on. It is reactive so the
   * anchor is re-measured the moment a badge mounts.
   */
  const badgeElements = new SvelteMap<string, HTMLElement>()

  // Plain locals for the gesture: where it started in client coordinates and how
  // far it travelled, which is what tells a tap from a drawn area.
  let drawing = false
  let strokeOriginX = 0
  let strokeOriginY = 0
  let strokeTravel = 0

  /** The editor an external jump asked for wins over one opened here. */
  const activeEditingId = $derived(editingId ?? localEditingId)
  const editingMark = $derived(
    activeEditingId ? (marks.find((mark) => mark.id === activeEditingId) ?? null) : null
  )

  /** Where the open editor anchors: its badge, re-measured as the layout moves. */
  const editorAnchor = $derived.by(() => {
    void measureToken
    const mark = editingMark
    if (!mark) return null
    const badge = badgeElements.get(mark.id)
    if (!badge) return null
    const rect = badge.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.bottom }
  })

  function badgeAttachment(id: string): Attachment<HTMLButtonElement> {
    return (node) => {
      badgeElements.set(id, node)
      return () => badgeElements.delete(id)
    }
  }

  /** The pointer position as a point normalized to the picture box. */
  function normalizedPoint(event: PointerEvent, layer: HTMLElement): ImageMarkPoint | null {
    const box = layer.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return null
    return {
      x: (event.clientX - box.left) / box.width,
      y: (event.clientY - box.top) / box.height
    }
  }

  function startStroke(event: PointerEvent & { currentTarget: HTMLDivElement }): void {
    const point = normalizedPoint(event, event.currentTarget)
    if (!point) return
    // The conversation's own pointer-up handler turns a drag into a quoted
    // selection; a draw on the picture is not a selection, so the gesture stays
    // inside the overlay.
    event.preventDefault()
    event.stopPropagation()
    drawing = true
    strokeTravel = 0
    strokeOriginX = event.clientX
    strokeOriginY = event.clientY
    draftPoints = normalizeImageMark([point])
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveStroke(event: PointerEvent & { currentTarget: HTMLDivElement }): void {
    if (!drawing) return
    strokeTravel = Math.max(
      strokeTravel,
      Math.hypot(event.clientX - strokeOriginX, event.clientY - strokeOriginY)
    )
    const point = normalizedPoint(event, event.currentTarget)
    if (!point) return
    draftPoints = normalizeImageMark([...draftPoints, point])
  }

  function endStroke(event: PointerEvent & { currentTarget: HTMLDivElement }): void {
    if (!drawing) return
    event.stopPropagation()
    drawing = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const drawn = normalizeImageMark(draftPoints)
    draftPoints = []
    if (drawn.length === 0) return
    // A tap is a comment on a place, not a mark around an area: the whole
    // gesture below the slop collapses to the single point it started at.
    const points =
      strokeTravel <= IMAGE_MARK_TAP_SLOP_PX
        ? normalizeImageMark([{ x: drawn[0]?.x ?? 0, y: drawn[0]?.y ?? 0 }])
        : drawn
    addMark(points)
  }

  /** Attach a new mark and open its comment editor, the way a new selection does. */
  async function addMark(points: ImageMarkPoint[]): Promise<void> {
    const id = crypto.randomUUID()
    const current = responseReferencesState.forThread(projectId, threadId)
    responseReferencesState.setForThread(projectId, threadId, [
      ...current,
      {
        id,
        label: '',
        text: imageMarkDescriptor(filename, points),
        kind: 'image',
        imageUrl: url,
        ...(messageId ? { messageId } : {}),
        points
      }
    ])
    // The store caps how many references a thread may hold and numbers the
    // labels it actually kept, so a mark beyond the cap never opens an editor
    // for a reference that does not exist.
    if (!responseReferencesState.forThread(projectId, threadId).some((entry) => entry.id === id)) {
      return
    }
    localEditingId = id
    await tick()
    measureToken += 1
  }

  function requestEdit(id: string): void {
    localEditingId = id
    measureToken += 1
  }

  function closeEditor(): void {
    localEditingId = null
    onEditClosed()
  }

  function saveComment(id: string, comment: string): void {
    responseReferencesState.updateComment(projectId, threadId, id, comment)
    closeEditor()
  }

  function draftComment(id: string, comment: string): void {
    responseReferencesState.updateCommentDraft(projectId, threadId, id, comment)
  }

  function removeMark(id: string): void {
    const current = responseReferencesState.forThread(projectId, threadId)
    responseReferencesState.setForThread(
      projectId,
      threadId,
      current.filter((reference) => reference.id !== id)
    )
    badgeElements.delete(id)
    closeEditor()
  }

  function toggleArmed(): void {
    armed = !armed
    if (armed) return
    drawing = false
    draftPoints = []
  }

  function remeasure(): void {
    if (!activeEditingId) return
    measureToken += 1
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    // The comment field owns Escape while it is open, so disarming here would
    // fight the editor for the same key.
    if (activeEditingId) return
    armed = false
    drawing = false
    draftPoints = []
  }
</script>

<svelte:window onkeydown={handleKeydown} onscrollcapture={remeasure} onresize={remeasure} />

{#snippet overlay()}
  <svg
    class="pointer-events-none absolute inset-0 h-full w-full"
    viewBox="0 0 1 1"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    {#each marks as mark (mark.id)}
      {@const points = mark.points ?? []}
      {#if points.length > 1}
        <polyline
          points={imageMarkPointsAttribute(points)}
          fill="none"
          stroke="var(--color-accent)"
          stroke-width={IMAGE_MARK_STROKE_WIDTH}
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
      {/if}
    {/each}
    {#if draftPoints.length > 1}
      <polyline
        class="opacity-70"
        points={imageMarkPointsAttribute(draftPoints)}
        fill="none"
        stroke="var(--color-accent)"
        stroke-width={IMAGE_MARK_STROKE_WIDTH}
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    {/if}
  </svg>

  {#each marks as mark, index (mark.id)}
    {@const badge = imageMarkBadgePoint(mark.points ?? [])}
    {@const number = referenceMarkNumber(mark.label, index)}
    <button
      type="button"
      class="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-accent text-[0.625rem] font-semibold text-on-accent shadow-md transition-transform hover:scale-110"
      style:left={`${badge.x * 100}%`}
      style:top={`${badge.y * 100}%`}
      style:width={`${IMAGE_MARK_BADGE_SIZE}px`}
      style:height={`${IMAGE_MARK_BADGE_SIZE}px`}
      title={mark.comment ? `Edit mark ${number}: ${mark.comment}` : `Comment on mark ${number}`}
      aria-label={mark.comment
        ? `Edit comment on mark ${number}: ${mark.comment}`
        : `Comment on mark ${number}`}
      onclick={() => requestEdit(mark.id)}
      {@attach badgeAttachment(mark.id)}
    >
      {number}
    </button>
  {/each}

  {#if armed}
    <div
      class="absolute inset-0 z-30 cursor-crosshair touch-none select-none"
      role="presentation"
      onpointerdown={startStroke}
      onpointermove={moveStroke}
      onpointerup={endStroke}
      onpointercancel={endStroke}
    ></div>
  {/if}

  <div class="absolute top-1.5 right-1.5 z-40 flex items-center gap-1">
    {#if armed}
      <span
        class="rounded bg-black/60 px-1.5 py-0.5 text-[0.625rem] font-medium text-white"
        aria-live="polite"
      >
        Draw on the picture · Esc to finish
      </span>
    {/if}
    <button
      type="button"
      class={[
        'flex h-7 w-7 items-center justify-center rounded-md border border-black/10 bg-white/85 text-black shadow-sm transition-all hover:bg-white',
        armed ? 'opacity-100' : 'opacity-60 hover:opacity-100'
      ]}
      aria-pressed={armed}
      title={armed ? 'Finish annotating this picture' : 'Annotate: draw a mark on this picture'}
      aria-label={armed ? 'Finish annotating this picture' : 'Annotate this picture'}
      onclick={toggleArmed}
    >
      {#if armed}
        <Check size={13} />
      {:else}
        <Pencil size={13} />
      {/if}
    </button>
  </div>
{/snippet}

<InlineImageFigure {url} {mime} {filename} {imageUrls} {onExpand} {overlay} />

{#if editingMark && editorAnchor}
  <ResponseAnnotationComment
    x={editorAnchor.x}
    y={editorAnchor.y}
    title="Comment on image mark"
    dragHandleTitle="Move image mark comment"
    closeLabel="Close image mark comment"
    removeTitle="Remove this mark and its comment"
    initialComment={editingMark.comment ?? ''}
    targetId={`image-mark-comment-${threadId}-${editingMark.id}`}
    scope={{ kind: 'project', projectId }}
    allowEmptyRemove
    onDraftChange={(comment) => draftComment(editingMark.id, comment)}
    onDone={(comment) => saveComment(editingMark.id, comment)}
    onRemove={() => removeMark(editingMark.id)}
    onClose={closeEditor}
  />
{/if}
