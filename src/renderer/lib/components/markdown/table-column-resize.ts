/**
 * Column resizing for one rendered markdown table.
 *
 * The table markup is DOMPurify-sanitized HTML the renderer inserts with
 * `{@html}`, so this module treats it as opaque and never rewrites a cell. It
 * adds the widths (a `<colgroup>` of `<col>` elements) and one drag handle per
 * header cell, and `destroy()` takes every bit of it back off. Nothing is
 * persisted: resizing is a decision the reader makes about the table in front of
 * them, and a fresh launch renders plain tables again.
 */

/** Narrowest a column can be dragged to. */
export const MIN_COLUMN_WIDTH = 15

/** Nudge applied by the arrow keys on a focused handle. */
const KEYBOARD_STEP = 16

/** Class of an injected drag handle; styled in `app.css` (global, like the rest
 *  of the rendered-markdown rules, because this element is not Svelte markup). */
const RESIZER_CLASS = 'md-col-resizer'

/** Set on the scroll wrapper for the duration of a drag. */
const RESIZING_CLASS = 'md-table-resizing'

export interface TableColumnResizeOptions {
  /** The scroll wrapper the table sits in; the fit-to-width floor comes from it. */
  container: HTMLElement
  /** Wrap mode: keep the table at least as wide as the panel. */
  fitToWidth: boolean
  /**
   * Widths carried over from a previous session on the same table, in column
   * order. Re-measured instead when the table no longer has that many columns.
   */
  widths?: readonly number[]
  /** Latest applied widths, so the owner can carry them across a re-render. */
  onWidthsChange?: (widths: readonly number[]) => void
}

export interface TableColumnResizeSession {
  /** Removes the widths and every handle this session added. */
  destroy(): void
}

function columnWidth(width: number): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.round(width))
}

/**
 * Make every column of `table` draggable and return the session that undoes it.
 *
 * Returns `null` for a table that has no header row to hang the handles on, in
 * which case nothing was added to the DOM.
 */
export function attachTableColumnResize(
  table: HTMLTableElement,
  options: TableColumnResizeOptions
): TableColumnResizeSession | null {
  const headerRow = table.rows[0]
  if (!headerRow || headerRow.cells.length === 0) return null

  const headerCells = Array.from(headerRow.cells)
  // Unlocking must not move anything: the session starts from the widths the
  // table already has, so the only widths the reader ever sees are their own.
  const measured = headerCells.map((cell) => columnWidth(cell.getBoundingClientRect().width))
  const widths =
    options.widths && options.widths.length === headerCells.length ? [...options.widths] : measured

  const colgroup = document.createElement('colgroup')
  const columns = widths.map((width) => {
    const column = document.createElement('col')
    column.style.width = `${width}px`
    colgroup.append(column)
    return column
  })
  table.prepend(colgroup)

  const handles = headerCells.map((cell, column) => {
    // A separator rather than a button: this is the window-splitter pattern, and
    // Chrome enforces a native minimum inline size on buttons that would render
    // this 8px grab bar as a 16px one.
    const handle = document.createElement('div')
    handle.className = RESIZER_CLASS
    handle.tabIndex = 0
    handle.setAttribute('role', 'separator')
    handle.setAttribute('aria-orientation', 'vertical')
    handle.setAttribute('aria-valuemin', String(MIN_COLUMN_WIDTH))
    const label = `Resize column ${column + 1}`
    handle.title = label
    handle.setAttribute('aria-label', label)
    handle.addEventListener('pointerdown', (event) => startDrag(event, column))
    handle.addEventListener('keydown', (event) => nudge(event, column))
    cell.append(handle)
    return handle
  })

  let frame = 0
  let pending: readonly number[] | null = null
  let drag: {
    pointerId: number
    column: number
    startX: number
    startWidths: number[]
  } | null = null

  /**
   * Wrap mode keeps the table filling the panel, so dragging one column narrower
   * hands the freed space to its siblings instead of shrinking the table. Without
   * wrap the table is exactly as wide as its columns, so a drag is never silently
   * re-distributed.
   */
  function totalWidth(): number {
    const total = widths.reduce((sum, width) => sum + width, 0)
    return options.fitToWidth ? Math.max(total, options.container.clientWidth) : total
  }

  function applyWidths(next: readonly number[]): void {
    for (const [index, width] of next.entries()) {
      widths[index] = width
      columns[index].style.width = `${width}px`
      handles[index].setAttribute('aria-valuenow', String(width))
    }
    table.style.width = `${totalWidth()}px`
    options.onWidthsChange?.([...widths])
  }

  function flush(): void {
    frame = 0
    if (pending) applyWidths(pending)
    pending = null
  }

  /** One layout write per frame: a pointer reports far more moves than the
   *  compositor can paint, and a table relayout is not free. */
  function schedule(next: readonly number[]): void {
    pending = next
    if (frame) return
    frame = requestAnimationFrame(flush)
  }

  function stopListening(): void {
    window.removeEventListener('pointermove', moveDrag)
    window.removeEventListener('pointerup', finishDrag)
    window.removeEventListener('pointercancel', finishDrag)
  }

  function moveDrag(event: PointerEvent): void {
    const active = drag
    if (!active || event.pointerId !== active.pointerId) return
    const delta = event.clientX - active.startX
    schedule(
      active.startWidths.map((width, index) =>
        index === active.column ? columnWidth(width + delta) : width
      )
    )
  }

  function finishDrag(event: PointerEvent): void {
    const active = drag
    if (!active || event.pointerId !== active.pointerId) return
    drag = null
    stopListening()
    options.container.classList.remove(RESIZING_CLASS)
  }

  /**
   * The listeners live on `window` rather than on the handle: the handle is
   * re-created whenever the rendered table is replaced, and a pointer capture on
   * an element that leaves the DOM would drop the drag with it.
   */
  function startDrag(event: PointerEvent, column: number): void {
    if (event.button !== 0) return
    event.preventDefault()
    drag = {
      pointerId: event.pointerId,
      column,
      startX: event.clientX,
      startWidths: [...widths]
    }
    options.container.classList.add(RESIZING_CLASS)
    window.addEventListener('pointermove', moveDrag)
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
  }

  function nudge(event: KeyboardEvent, column: number): void {
    const step =
      event.key === 'ArrowLeft' ? -KEYBOARD_STEP : event.key === 'ArrowRight' ? KEYBOARD_STEP : 0
    if (step === 0) return
    event.preventDefault()
    const next = [...widths]
    next[column] = columnWidth(next[column] + step)
    applyWidths(next)
  }

  applyWidths(widths)

  return {
    destroy(): void {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      pending = null
      drag = null
      stopListening()
      options.container.classList.remove(RESIZING_CLASS)
      for (const handle of handles) handle.remove()
      colgroup.remove()
      table.style.width = ''
    }
  }
}
