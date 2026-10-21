<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioPalette from '@pdslng/cio-icon/CioPalette.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import { tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { SvelteMap } from 'svelte/reactivity'

  import { getAnnotationToolbarHost, hasAnnotationToolbarHost } from '$lib/annotation-toolbar'
  import { Popover } from 'bits-ui'
  import AnnotationIndicator from '../shared/AnnotationIndicator.svelte'
  import ColorSwatches from '../shared/ColorSwatches.svelte'
  import ResponseAnnotationComment from '../chats/ResponseAnnotationComment.svelte'
  import {
    MARK_FRAME_TOLERANCE_SECONDS,
    MARK_MAX_STROKE_WIDTH,
    MARK_MIN_STROKE_WIDTH,
    MARK_TAP_SLOP_PX,
    clampMarkStrokeWidth,
    markBadgePoint,
    markColor,
    markPointsAttribute,
    normalizeMark,
    type MarkCapture,
    type MarkPoint
  } from '$lib/annotation-marks'
  import { annotationTool } from '$lib/stores/annotation-tool.svelte'
  import {
    responseReferencesState,
    type ResponseReferenceAnchor
  } from '$lib/stores/response-references.svelte'
  import { referenceLabelNumber } from '$lib/reference-labels'
  import { videoTimecode } from '$shared/video/timeline'

  /**
   * The one surface a user draws marks on.
   *
   * A picture the app published is the artifact a user most often wants to answer
   * by pointing at it, and text alone cannot say where. This draws freehand marks
   * over whatever picture its host put it on, keeps every mark as a composer
   * reference (so it is listed, commented, cleared and sent exactly like the
   * app's other annotations), and hands the numbered marks to the send path,
   * which rebuilds the picture with the marks drawn on it.
   *
   * It is deliberately blind to what it is drawing on. A still image and one frame
   * of a video differ in the picture behind the marks and in the reference the
   * host builds for a stroke, and in nothing else, so both surfaces are this
   * component placed over their own picture rather than two drawing tools that
   * drift apart. The host positions it exactly over the picture   inside the
   * letterboxed content box of a video, over the image itself   because a mark is
   * normalized to the box it is drawn in, and that box has to be the picture.
   */
  interface Props {
    projectId: string
    threadId: string
    /** Marks drawn on this host's picture, in composer order. */
    marks: ResponseReferenceAnchor[]
    /**
     * Store a stroke as a reference and answer its id, or null when the store
     * refused it. The host owns this because only the host knows what the mark is
     * on: the picture's URL, and the second a video frame belongs to.
     */
    createMark: (capture: MarkCapture) => string | null
    /** A mark the user asked to edit from elsewhere; a composer jump sets it. */
    editingId: string | null
    /** The comment editor closed, so the caller can clear its request. */
    onEditClosed: () => void
    /** Whether the picture is being drawn on. The host owns this, because a host
     *  has its own chrome to change with it: a video pauses and drops its native
     *  controls, and shows a frame strip, while the surface is armed. */
    armed?: boolean
    /** The surface was armed or disarmed, so the host can follow it. */
    onArmedChange?: (armed: boolean) => void
    /** Wording for the hint shown while the picture is being drawn on. */
    hint?: string
    /**
     * The second whose frame the picture is showing, for a video.
     *
     * A video's marks belong to moments, not to the file: a stroke drawn at 0:05
     * is a note about 0:05, and painting it over the 0:10 frame would show the
     * user, and the agent looking at a screenshot of it, a mark on the wrong
     * picture. Unset for a still, where every mark belongs to the one picture.
     */
    activeSeconds?: number | null
    /**
     * Called before a mark's editor opens, so a host can put that mark's own
     * picture on screen first. A video seeks to the mark's second: the editor is
     * about a moment, and a moment the user cannot see is not editable.
     */
    onFocusMark?: (mark: ResponseReferenceAnchor) => void
  }

  let {
    projectId,
    threadId,
    marks,
    createMark,
    editingId,
    onEditClosed,
    armed = false,
    onArmedChange = () => {},
    hint = 'Draw on the picture · Esc to finish',
    activeSeconds = null,
    onFocusMark
  }: Props = $props()

  const toolbarHost = hasAnnotationToolbarHost() ? getAnnotationToolbarHost() : undefined
  const toolbarAttachment: Attachment<HTMLDivElement> = (node) => {
    const target = toolbarHost?.target()
    if (!target) return
    target.appendChild(node)
    return () => node.remove()
  }

  /** The stroke being drawn, in normalized coordinates. */
  let draftPoints = $state<MarkPoint[]>([])
  /** The mark whose editor this surface opened by itself. */
  let localEditingId = $state<string | null>(null)
  /** Bumped whenever the open editor must re-measure against the layout. */
  let measureToken = $state(0)
  /** Whether the pen panel is open. */
  let penOpen = $state(false)

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
  function normalizedPoint(event: PointerEvent, layer: HTMLElement): MarkPoint | null {
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
    draftPoints = normalizeMark([point])
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
    draftPoints = normalizeMark([...draftPoints, point])
  }

  function endStroke(event: PointerEvent & { currentTarget: HTMLDivElement }): void {
    if (!drawing) return
    event.stopPropagation()
    drawing = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const drawn = normalizeMark(draftPoints)
    draftPoints = []
    if (drawn.length === 0) return
    // A tap is a comment on a place, not a mark around an area: the whole
    // gesture below the slop collapses to the single point it started at.
    const points =
      strokeTravel <= MARK_TAP_SLOP_PX
        ? normalizeMark([{ x: drawn[0]?.x ?? 0, y: drawn[0]?.y ?? 0 }])
        : drawn
    // Measured from the surface the stroke was drawn on rather than from the
    // picture alone, because the send composes a picture of another size and needs
    // the ratio between the two to keep the line as heavy as the user drew it.
    const box = event.currentTarget.getBoundingClientRect()
    void addMark(points, Math.min(box.width, box.height))
  }

  /** Attach a new mark and open its comment editor, the way a new selection does. */
  async function addMark(points: MarkPoint[], surfaceEdge: number): Promise<void> {
    const id = createMark({
      points,
      surfaceEdge,
      style: { color: annotationTool.color, strokeWidth: annotationTool.strokeWidth }
    })
    if (!id) return
    localEditingId = id
    await tick()
    measureToken += 1
  }

  function requestEdit(id: string): void {
    const mark = marks.find((entry) => entry.id === id)
    if (mark) onFocusMark?.(mark)
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
    const next = !armed
    if (!next) {
      drawing = false
      draftPoints = []
    }
    onArmedChange(next)
  }

  function remeasure(): void {
    if (!activeEditingId) return
    measureToken += 1
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    // The comment field owns Escape while it is open, so disarming here would
    // fight the editor for the same key. The pen dropdown owns its
    // own Escape for the same reason.
    if (activeEditingId || penOpen) return
    drawing = false
    draftPoints = []
    onArmedChange(false)
  }

  /** Badge wording names a frame's moment, which a still mark has none of. */
  function markMoment(mark: ResponseReferenceAnchor): string {
    return mark.markSeconds === undefined ? '' : ` at ${videoTimecode(mark.markSeconds)}`
  }

  /** Whether a mark's stroke belongs on the picture the surface is showing. */
  function marksThisPicture(mark: ResponseReferenceAnchor): boolean {
    if (activeSeconds === null || activeSeconds === undefined) return true
    if (mark.markSeconds === undefined) return true
    return Math.abs(mark.markSeconds - activeSeconds) <= MARK_FRAME_TOLERANCE_SECONDS
  }

  /**
   * The marks that belong on the picture right now, in composer order.
   *
   * Their strokes and their badges are the same list: a badge is where a note is,
   * so a badge floating on a frame the note is not about is as wrong as a stroke
   * drawn there. Moving to another annotated frame is the frame strip's job, and
   * the composer lists every mark with its own jump.
   */
  const visibleMarks = $derived(marks.filter(marksThisPicture))

  /**
   * The badge of every mark on the picture.
   *
   * Shown whenever a mark belongs to the picture in front of the reader, because
   * the badge is the only way back to that mark's comment: the reader updates a
   * comment by pressing the badge, with the pen armed or not.
   */
  const showBadges = $derived(visibleMarks.length > 0)

  /** The badge's wording, naming a frame's moment when it has one. */
  function badgeHint(mark: ResponseReferenceAnchor, number: number): string {
    const at = markMoment(mark)
    return mark.comment
      ? `Edit mark ${number}${at}: ${mark.comment}`
      : `Comment on mark ${number}${at}`
  }
</script>

<svelte:window onkeydown={handleKeydown} onscrollcapture={remeasure} onresize={remeasure} />

<svg
  class="pointer-events-none absolute inset-0 h-full w-full"
  viewBox="0 0 1 1"
  preserveAspectRatio="none"
  aria-hidden="true"
>
  {#each visibleMarks as mark (mark.id)}
    {@const points = mark.points ?? []}
    {#if points.length > 1}
      <polyline
        points={markPointsAttribute(points)}
        fill="none"
        stroke={markColor(mark.markColor)}
        stroke-width={clampMarkStrokeWidth(mark.markStrokeWidth)}
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    {/if}
  {/each}
  {#if draftPoints.length > 1}
    <polyline
      class="opacity-70"
      points={markPointsAttribute(draftPoints)}
      fill="none"
      stroke={annotationTool.color}
      stroke-width={annotationTool.strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />
  {/if}
</svg>

{#if showBadges}
  {#each visibleMarks as mark, index (mark.id)}
    {@const badge = markBadgePoint(mark.points ?? [])}
    {@const number = referenceLabelNumber(mark.label, index)}
    <AnnotationIndicator
      id={mark.id}
      surface={`mark:${threadId}`}
      left={`${badge.x * 100}%`}
      top={`${badge.y * 100}%`}
      centre
      {number}
      hasComment={Boolean(mark.comment)}
      title={badgeHint(mark, number)}
      class="z-40"
      attach={badgeAttachment(mark.id)}
      onOpen={() => requestEdit(mark.id)}
    />
  {/each}
{/if}

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

<div
  class={['flex items-center gap-1', toolbarHost ? 'relative' : 'absolute top-1.5 right-1.5 z-40']}
  {@attach toolbarAttachment}
>
  {#if armed}
    <span
      class="hidden bg-black/60 px-1.5 py-0.5 text-[0.625rem] font-medium text-white sm:inline"
      aria-live="polite"
    >
      {hint}
    </span>
  {/if}
  <Popover.Root bind:open={penOpen}>
    <Popover.Trigger
      class="relative flex h-7 w-7 items-center justify-center border border-black/10 bg-white/85 text-black shadow-sm transition-all hover:bg-white"
      title="Annotation pen: colour and stroke width"
      aria-label="Annotation pen: colour and stroke width"
    >
      <CioPalette size={13} />
      <span
        class="absolute -right-0.5 -bottom-0.5 h-3 w-3 border border-white"
        style:background-color={annotationTool.color}
        aria-hidden="true"
      ></span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        side="bottom"
        align="end"
        sideOffset={6}
        collisionPadding={12}
        class="z-70 w-72 max-w-[calc(100vw-1.5rem)] space-y-4 border bg-surface p-4 text-foreground shadow-xl"
        aria-label="Annotation pen"
      >
        <div>
          <span class="mb-2 block text-xs font-medium text-muted">Colour</span>
          <ColorSwatches
            size="sm"
            allowNone={false}
            value={annotationTool.color}
            oncolorchange={(color) => {
              if (color) annotationTool.setColor(color)
            }}
          />
        </div>
        <div>
          <label
            class="mb-2 flex items-center justify-between text-xs font-medium text-muted"
            for={`annotation-stroke-${threadId}`}
          >
            <span>Stroke width</span>
            <span class="font-mono text-foreground">{annotationTool.strokeWidth}px</span>
          </label>
          <input
            id={`annotation-stroke-${threadId}`}
            type="range"
            min={MARK_MIN_STROKE_WIDTH}
            max={MARK_MAX_STROKE_WIDTH}
            step={1}
            class="w-full"
            bind:value={annotationTool.strokeWidth}
          />
          <div class="mt-3 flex h-10 items-center border bg-elevated px-2">
            <svg
              viewBox="0 0 120 40"
              class="h-full w-full"
              aria-hidden="true"
              preserveAspectRatio="none"
            >
              <line
                x1="6"
                y1="20"
                x2="114"
                y2="20"
                stroke={annotationTool.color}
                stroke-width={annotationTool.strokeWidth}
                stroke-linecap="round"
              />
            </svg>
          </div>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
  <button
    type="button"
    class={[
      'flex h-7 w-7 items-center justify-center border border-black/10 bg-white/85 text-black shadow-sm transition-all hover:bg-white',
      armed ? 'opacity-100' : 'opacity-60 hover:opacity-100'
    ]}
    aria-pressed={armed}
    title={armed ? 'Finish annotating' : 'Annotate: draw a mark on this picture'}
    aria-label={armed ? 'Finish annotating' : 'Annotate this picture'}
    onclick={toggleArmed}
  >
    {#if armed}
      <CioCheck size={13} />
    {:else}
      <CioPencil size={13} />
    {/if}
  </button>
</div>

{#if editingMark && editorAnchor}
  <ResponseAnnotationComment
    x={editorAnchor.x}
    y={editorAnchor.y}
    title="Comment on mark"
    dragHandleTitle="Move mark comment"
    closeLabel="Close mark comment"
    removeTitle="Remove this mark and its comment"
    initialComment={editingMark.comment ?? ''}
    targetId={`mark-comment-${threadId}-${editingMark.id}`}
    scope={{ kind: 'project', projectId }}
    onDraftChange={(comment) => draftComment(editingMark.id, comment)}
    onDone={(comment) => saveComment(editingMark.id, comment)}
    onRemove={() => removeMark(editingMark.id)}
    onClose={closeEditor}
  />
{/if}
