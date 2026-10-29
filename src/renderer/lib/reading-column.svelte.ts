import type { Attachment } from 'svelte/attachments'

import { layoutPanelState } from '$lib/stores/layout-panel.svelte'

/**
 * The narrowest the reader's column may be squeezed to before the offset starts
 * giving way to the panel. The pane itself never goes below 360px, so this is
 * the point where holding the column's place would cost more than it is worth.
 */
const MIN_COLUMN_WIDTH = 320

/**
 * Where the reader's column starts, measured from its pane's left edge.
 *
 * The column keeps this offset whatever a tool panel does to the right of it. A
 * temporary chat, a browser, a diff, any panel docked on the right narrows the
 * pane, and a column centred inside the narrowed pane would slide left with it,
 * taking the thread's name in the header along for the ride: two surfaces that
 * are meant to read as one container moving for something unrelated to the
 * thread. Holding the offset instead means the panel takes room from the right
 * edge, the column gives up width rather than position, and the title stays
 * exactly where the messages start.
 *
 * The offset is the column's centred position in the room the workspace grid
 * holds, which is the room it has when no panel is docked. That makes the value
 * identical to plain centring in the everyday case and keeps it fixed through
 * every panel, drag and slide.
 *
 * `surface` is the conversation's scroll box. Its own right padding is the base
 * gutter   the class's responsive value, which is the only part of the pair the
 * layout still owns   and the left side of the column comes from here.
 */
function columnOffset(surface: HTMLElement): number {
  const box = surface.getBoundingClientRect()
  const gutter = Number.parseFloat(getComputedStyle(surface).paddingRight) || 0
  /* The grid, not the pane, is the room the column was laid out for: the pane's
     own width changes with every frame of a panel's slide. */
  const grid = surface.closest('[data-region="workspace-grid"]')
  const room = (grid ? grid.getBoundingClientRect().width : box.width) - gutter * 2
  const column = surface.firstElementChild
  /* The column's own maximum width in pixels, so a scaled root font size is
     read as the browser laid it out instead of being assumed to be 48rem. */
  const maxWidth = column ? Number.parseFloat(getComputedStyle(column).maxWidth) : Number.NaN
  const columnWidth = Number.isFinite(maxWidth) ? Math.min(room, maxWidth) : room
  const centred = gutter + Math.max(0, (room - columnWidth) / 2)
  const paneRoom = box.width - gutter * 2
  return Math.round(Math.max(gutter, Math.min(centred, paneRoom - MIN_COLUMN_WIDTH)))
}

/**
 * Report where the column a reader is reading starts.
 *
 * The app header puts the thread's name on that column's left edge instead of on
 * the sidebar's, because the page is the thing the reader is looking at and the
 * name and the messages are one surface. The conversation's scroll box owns that
 * edge, and this reports it: the box's left edge plus the column offset, which is
 * also the padding the layout puts on its own gutters, so the name lands on the
 * line the messages start on.
 *
 * A surface the reader cannot see keeps the last coordinate it reported instead
 * of resetting it. Hiding the conversation (a studio taking the pane) is not the
 * same as taking it off screen: resetting there is what dropped the thread's name
 * back to the end of the header's chrome the moment a studio opened, so the name
 * jumped left while everything below it changed. The last real edge is the honest
 * answer until another reading surface claims the column.
 */
export function createReadingColumn(): {
  /** Put on the conversation's scroll box, whose content starts on the column. */
  attachment: Attachment<HTMLElement>
  /** Re-measure now, for a host that knows the layout moved without a resize. */
  report: () => void
} {
  /** The surface's identity in the store's ownership check. */
  const owner = {}
  let element: HTMLElement | null = null

  function report(): void {
    const target = element
    if (!target || !layoutPanelState.contentVisible) return
    const onScreen =
      target.getClientRects().length > 0 && getComputedStyle(target).visibility !== 'hidden'
    if (!onScreen) return
    const offset = columnOffset(target)
    layoutPanelState.setReadingColumn(
      owner,
      Math.round(target.getBoundingClientRect().left + offset),
      offset
    )
  }

  /* A surface that comes back on screen has not necessarily resized (the shell
     keeps its width across views), so nothing the observer watches would tell it
     to measure again. Reading the flag is what re-runs this. */
  $effect(() => {
    void layoutPanelState.contentVisible
    report()
  })

  const attachment: Attachment<HTMLElement> = (node) => {
    element = node
    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    /* The gutter class is responsive and the pane is what it responds to, so the
       pane is observed as well. The grid above it is observed because a panel
       reserving its track changes the grid the offset is measured against. */
    const pane = node.parentElement
    if (pane) observer.observe(pane)
    const grid = node.closest('[data-region="workspace-grid"]')
    if (grid) observer.observe(grid)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      if (element === node) element = null
      layoutPanelState.clearReadingColumn(owner)
    }
  }

  return { attachment, report }
}
