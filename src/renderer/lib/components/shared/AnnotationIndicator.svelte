<script lang="ts">
  import type { Attachment } from 'svelte/attachments'
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import {
    annotationIndicatorOffset,
    setAnnotationIndicatorOffset
  } from '$lib/annotation-indicator.svelte'

  /**
   * The one annotation indicator the app draws.
   *
   * Every place a reader can comment on something shows the same thing about it:
   * a comment icon, the number the comment is referred to by, and a place the
   * reader can put it. A conversation passage, a note in the file viewer, a mark
   * on a picture, a passage of a specification and a shared comment card are all
   * the same affordance, so they are one component and a change to any of them
   * lands on all of them at once.
   *
   * The surface owns the place the comment belongs to and hands it over as CSS
   * values, because places are pixels in one surface and percentages in another.
   * The reader owns the drag, so it is reported to the shared offset store and
   * outlives re-renders. A press that does not travel is the click that opens the
   * comment, which is the same gesture with a different ending.
   */
  interface Props {
    /** Stable identity of the comment, so a moved indicator stays moved. */
    id: string
    /** The surface drawing it: two surfaces never share a dragged place. */
    surface: string
    /** The place the surface chose, as CSS values (`12px`, `40%`, `auto`). */
    left: string
    top: string
    /** Centred on that place instead of anchored by its own top-left corner. */
    centre?: boolean
    /** Hold the place against the window rather than against the surface's box. */
    fixed?: boolean
    /** One-based number the comment is referred to by, when it has one. */
    number?: number | null
    /** Whether a comment has been written on it. */
    hasComment?: boolean
    /** Whether the comment this belongs to is the one on display. */
    active?: boolean
    /** Full action name: the tooltip and the accessible name. */
    title: string
    /** Extra layout classes a surface needs to place it in its own layer. */
    class?: string
    /** Work the surface has to do with the button itself, such as tracking it. */
    attach?: Attachment<HTMLButtonElement>
    onOpen: () => void
  }

  let {
    id,
    surface,
    left,
    top,
    centre = false,
    fixed = false,
    number = null,
    hasComment = false,
    active = false,
    title,
    class: extraClass = '',
    attach,
    onOpen
  }: Props = $props()

  const key = $derived(`${surface}:${id}`)
  const offset = $derived(annotationIndicatorOffset(key))

  /** How far a press must travel before it is a drag instead of a click. */
  const DRAG_THRESHOLD = 3

  let drag = $state<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  let dragged = false

  const transform = $derived(
    `${centre ? 'translate(-50%, -50%) ' : ''}translate(${offset.x}px, ${offset.y}px)`
  )

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary) return
    const element = event.currentTarget
    if (!(element instanceof HTMLElement)) return
    // The next press starts its own gesture, so a click that opens a comment is
    // never swallowed because a previous drag ended without one.
    dragged = false
    drag = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      originX: offset.x,
      originY: offset.y
    }
    element.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return
    const movedX = event.screenX - drag.startX
    const movedY = event.screenY - drag.startY
    if (!dragged && Math.abs(movedX) < DRAG_THRESHOLD && Math.abs(movedY) < DRAG_THRESHOLD) return
    dragged = true
    setAnnotationIndicatorOffset(key, drag.originX + movedX, drag.originY + movedY)
    event.preventDefault()
  }

  function endDrag(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return
    const element = event.currentTarget
    drag = null
    if (element instanceof HTMLElement && element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId)
    }
  }

  function onClick(event: MouseEvent): void {
    event.stopPropagation()
    if (dragged) {
      dragged = false
      return
    }
    onOpen()
  }

  // One stable attachment, so a surface's own work is bound once and not rebuilt
  // on every update of this component.
  const indicatorAttachment: Attachment<HTMLButtonElement> = (node) => attach?.(node)
</script>

<button
  type="button"
  class={[
    fixed ? 'fixed' : 'absolute',
    'flex h-6 items-center justify-center gap-1 border bg-surface text-foreground shadow-md transition-colors',
    number === null ? 'w-6' : 'w-auto px-1.5',
    hasComment ? 'border-accent text-accent' : 'border-border',
    active ? 'ring-2 ring-accent/40' : '',
    drag ? 'cursor-grabbing' : 'cursor-grab',
    extraClass
  ]}
  style:left
  style:top
  style:transform
  data-dragging={drag ? '1' : '0'}
  {title}
  aria-label={title}
  aria-pressed={active}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={endDrag}
  onpointercancel={endDrag}
  onlostpointercapture={endDrag}
  onclick={onClick}
  {@attach indicatorAttachment}
>
  <CioMessage size={ICON_SIZE.inline} class="shrink-0" />
  {#if number !== null}
    <span class="text-[0.6875rem] leading-none font-semibold tabular-nums">{number}</span>
  {/if}
</button>
