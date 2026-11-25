/**
 * Pointer-driven reordering for the queued-message list.
 *
 * The rows keep their original DOM order while the pointer holds one of them:
 * the held row follows the pointer and every row it passes slides out of the
 * way, so the reader sees where the message will land before releasing it. The
 * queue itself is written once, on release. That matters more here than in a
 * plain list, because the queue is what the dispatcher sends from its head:
 * reordering it mid-drag would change which message the next idle turn delivers.
 */

/** One row of the queue list, as the controller measures it at drag start. */
export interface QueuedDragRow {
  id: string
  element: HTMLElement
}

/** What a released drag hands back to the card. */
export interface QueuedDragDrop {
  id: string
  targetIndex: number
}

export class QueuedDragReorder {
  /** The row the pointer is holding, or null while the list is at rest. */
  draggingId = $state<string | null>(null)

  /** The slot the held row would take if the pointer were released now. */
  targetIndex = $state(0)

  /** How far the held row has travelled from its own slot, in pixels. */
  travel = $state(0)

  #originIndex = 0
  #tops: number[] = []
  #heights: number[] = []
  /** Where inside the held row the pointer took hold, so it never jumps. */
  #grabOffset = 0
  #startY = 0
  #listTop = 0
  #pointerId = -1
  #drop: ((drop: QueuedDragDrop) => void) | null = null

  /** True while a row is being held. */
  get dragging(): boolean {
    return this.draggingId !== null
  }

  /**
   * The transform the row at `index` draws right now.
   *
   * The held row follows the pointer; the rows between its old and its new slot
   * step aside by exactly the held row's height, which is what makes the list
   * open a place for it. Rows are keyed by id in DOM order, so the transform is
   * the only thing that moves them until the drop is committed.
   */
  transformFor(index: number): string {
    if (this.draggingId === null) return 'none'
    if (index === this.#originIndex) return `translateY(${this.travel}px)`
    const lift = this.#heights[this.#originIndex] ?? 0
    if (
      this.#originIndex < this.targetIndex &&
      index > this.#originIndex &&
      index <= this.targetIndex
    )
      return `translateY(${-lift}px)`
    if (
      this.targetIndex < this.#originIndex &&
      index >= this.targetIndex &&
      index < this.#originIndex
    )
      return `translateY(${lift}px)`
    return 'none'
  }

  /**
   * Take hold of one row. `rows` must be in queue order, because the drop is
   * reported as an index into that same order.
   */
  start(
    event: PointerEvent,
    rows: readonly QueuedDragRow[],
    id: string,
    drop: (result: QueuedDragDrop) => void
  ): void {
    if (event.button !== 0 || this.draggingId !== null) return
    const origin = rows.findIndex((row) => row.id === id)
    if (origin < 0 || rows.length < 2) return
    const list = rows[0].element.parentElement
    if (!list) return
    event.preventDefault()
    const listRect = list.getBoundingClientRect()
    const rects = rows.map((row) => row.element.getBoundingClientRect())
    this.#listTop = listRect.top
    this.#tops = rects.map((rect) => rect.top - listRect.top)
    this.#heights = rects.map((rect) => rect.height)
    this.#originIndex = origin
    this.#grabOffset = Math.max(
      0,
      Math.min(rects[origin].height, event.clientY - rects[origin].top)
    )
    this.#startY = event.clientY
    this.#pointerId = event.pointerId
    this.#drop = drop
    this.draggingId = id
    this.targetIndex = origin
    this.travel = 0
    window.addEventListener('pointermove', this.#onMove)
    window.addEventListener('pointerup', this.#onUp)
    window.addEventListener('pointercancel', this.#onCancel)
    window.addEventListener('keydown', this.#onKeyDown)
  }

  /** Abandon the drag: the queue keeps the order it had before it started. */
  cancel(): void {
    this.#release()
  }

  #onMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId || this.draggingId === null) return
    this.travel = event.clientY - this.#startY
    // The held row's centre, in the list's own coordinates. Counting the rows
    // whose untouched centre sits above it gives the slot it should take, since
    // every row it passes keeps its place in the queue's own order.
    const height = this.#heights[this.#originIndex] ?? 0
    const centre = event.clientY - this.#grabOffset + height / 2 - this.#listTop
    let target = 0
    for (let index = 0; index < this.#tops.length; index += 1) {
      if (index === this.#originIndex) continue
      if (this.#tops[index] + this.#heights[index] / 2 < centre) target += 1
    }
    this.targetIndex = target
  }

  #onUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) return
    const drop =
      this.draggingId !== null ? { id: this.draggingId, targetIndex: this.targetIndex } : null
    const commit = this.#drop
    this.#release()
    if (drop && commit) commit(drop)
  }

  #onCancel = (): void => {
    this.cancel()
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.cancel()
  }

  #release(): void {
    window.removeEventListener('pointermove', this.#onMove)
    window.removeEventListener('pointerup', this.#onUp)
    window.removeEventListener('pointercancel', this.#onCancel)
    window.removeEventListener('keydown', this.#onKeyDown)
    this.draggingId = null
    this.travel = 0
    this.#drop = null
    this.#pointerId = -1
  }
}
