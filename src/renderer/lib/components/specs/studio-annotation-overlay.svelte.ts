import { tick } from 'svelte'
import { rangeForAnnotation, waitForScrollSettle, type TextAnchor } from './studio-annotation-anchors'

/** Anchor fields shared by every studio annotation document type. */
export interface OverlayAnnotation extends TextAnchor {
  id: string
  body: string
  status: string
  section: string
}

/** A not-yet-submitted annotation captured from the document. */
export interface PendingOverlayAnchor {
  section: string
  quote: string
  startLine?: number
  endLine?: number
  startOffset: number
  endOffset: number
  x: number
  y: number
  sectionLevel: boolean
}

export interface OverlayMarker<A> {
  annotation: A
  x: number
  y: number
}

const PENDING_WIDTH = 396
const PENDING_HEIGHT_MARGIN = 272
const DETAIL_WIDTH = 320
const DETAIL_HEIGHT_MARGIN = 288

export function clampPendingPosition(rect: {
  left: number
  bottom: number
}): { x: number; y: number } {
  return {
    x: Math.max(12, Math.min(rect.left, window.innerWidth - PENDING_WIDTH)),
    y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - PENDING_HEIGHT_MARGIN))
  }
}

export function clampDetailPosition(rect: {
  right: number
  left: number
  top: number
}): { x: number; y: number } {
  const preferredX = rect.right + 8
  const x =
    preferredX + DETAIL_WIDTH <= window.innerWidth - 12
      ? preferredX
      : rect.left - DETAIL_WIDTH - 8
  return {
    x: Math.max(12, Math.min(x, window.innerWidth - DETAIL_WIDTH - 12)),
    y: Math.max(12, Math.min(rect.top, window.innerHeight - DETAIL_HEIGHT_MARGIN))
  }
}

/**
 * Shared reactive state + DOM behavior for the studio annotation overlay:
 * pending annotation capture, the editing/detail popover, and in-document
 * markers with a CSS CustomHighlight. Each studio owns its persistence
 * callbacks; this class owns the presentation lifecycle.
 */
export class StudioAnnotationOverlay<A extends OverlayAnnotation> {
  pending = $state<PendingOverlayAnchor | null>(null)
  editing = $state<A | null>(null)
  editingBody = $state('')
  editingPosition = $state<{ x: number; y: number } | null>(null)
  editMode = $state(false)
  markers = $state<OverlayMarker<A>[]>([])

  private readonly highlightName: string

  constructor(highlightName: string) {
    this.highlightName = highlightName
  }

  clearHighlight(): void {
    CSS.highlights?.delete(this.highlightName)
  }

  beginPending(anchor: PendingOverlayAnchor): void {
    this.pending = anchor
  }

  closePending(): void {
    this.pending = null
  }

  startEdit(): void {
    this.editMode = true
  }

  cancelEdit(): void {
    this.editMode = false
  }

  closeEditing(): void {
    this.clearHighlight()
    this.editing = null
    this.editingBody = ''
    this.editingPosition = null
    this.editMode = false
  }

  /**
   * Scroll the annotation's quote into view, highlight it, and position the
   * detail popover next to its marker. `resolveSection` maps an annotation to
   * its containing section element (or null when the section is gone).
   */
  async openAnnotation(
    annotation: A,
    options: {
      scroller: HTMLElement | null
      sectionElement: HTMLElement | null
      markerAttribute: string
      annotations: A[]
      sectionFor: (annotation: A) => HTMLElement | null
    }
  ): Promise<void> {
    window.getSelection()?.removeAllRanges()
    this.clearHighlight()
    this.closePending()
    await tick()
    const { scroller, sectionElement, markerAttribute } = options
    const range = sectionElement ? rangeForAnnotation(sectionElement, annotation) : null
    const initialRect = range?.getBoundingClientRect() ?? sectionElement?.getBoundingClientRect()
    if (scroller && initialRect) {
      const scrollerRect = scroller.getBoundingClientRect()
      const centeredTop =
        scroller.scrollTop +
        initialRect.top -
        scrollerRect.top -
        (scroller.clientHeight - initialRect.height) / 2
      scroller.scrollTo({ top: Math.max(0, centeredTop), behavior: 'smooth' })
      await waitForScrollSettle(scroller)
    }
    await this.refreshMarkers(options.annotations, {
      scroller,
      sectionFor: options.sectionFor
    })
    await tick()
    const marker = document.querySelector<HTMLElement>(
      `[${markerAttribute}="${CSS.escape(annotation.id)}"]`
    )
    const rect = marker?.getBoundingClientRect() ?? range?.getBoundingClientRect() ?? initialRect
    if (range && typeof Highlight !== 'undefined' && CSS.highlights) {
      CSS.highlights.set(this.highlightName, new Highlight(range))
    }
    this.editing = annotation
    this.editingBody = annotation.body
    this.editMode = false
    this.editingPosition = rect ? clampDetailPosition(rect) : { x: 12, y: 12 }
  }

  /**
   * Recompute marker positions for every open annotation. Passing the full
   * annotation list rebuilds the set; the same list refreshes positions.
   */
  async refreshMarkers(
    annotations: A[],
    options: {
      scroller: HTMLElement | null
      sectionFor: (annotation: A) => HTMLElement | null
    }
  ): Promise<void> {
    await tick()
    const scroller = options.scroller
    if (!scroller) return
    const scrollerRect = scroller.getBoundingClientRect()
    this.markers = annotations.flatMap((annotation) => {
      if (annotation.status !== 'open') return []
      const section = options.sectionFor(annotation)
      const range = section ? rangeForAnnotation(section, annotation) : null
      const rect = range?.getBoundingClientRect() ?? section?.getBoundingClientRect()
      if (!rect) return []
      return [
        {
          annotation,
          x: Math.max(4, rect.right - scrollerRect.left + scroller.scrollLeft + 6),
          y: Math.max(4, rect.top - scrollerRect.top + scroller.scrollTop)
        }
      ]
    })
  }
}
