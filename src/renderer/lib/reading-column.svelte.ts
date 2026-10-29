import type { Attachment } from 'svelte/attachments'

import { layoutPanelState } from '$lib/stores/layout-panel.svelte'

/**
 * Where the reader's column starts, measured against the room the workspace
 * grid holds rather than the room a tool panel leaves the conversation.
 *
 * `surface` is the conversation's scroll box, whose own left padding is the
 * gutter the column starts after, and `column` is the page column inside it.
 *
 * The column's left edge is what the header's thread block aligns to, and the
 * edge it uses is the column's laid-out position: the gutter, plus half of
 * whatever the pane leaves after the column's own maximum width. The width of
 * the pane is *not* what that half is computed from. A temporary chat, a
 * browser, a diff, any panel docked on the right takes a track out of the grid
 * and re-centres the column inside what is left, so measuring the pane drags
 * the thread's name sideways for a surface the thread is not part of. The grid
 * keeps its width while its panel comes and goes, so the name stays exactly
 * where the layout put it, and still follows the sidebar, the window and the
 * column the messages start on.
 */
function columnLeftInGrid(surface: HTMLElement, gutter: number): number {
  const box = surface.getBoundingClientRect()
  const grid = surface.closest('[data-region="workspace-grid"]')
  const unobstructed = grid ? grid.getBoundingClientRect().width : box.width
  const room = unobstructed - gutter * 2
  const column = surface.firstElementChild
  /* The column's own maximum width, in pixels, so a scaled root font size is
     read as the browser laid it out instead of being assumed to be 48rem. */
  const maxWidth = column ? Number.parseFloat(getComputedStyle(column).maxWidth) : 0
  const columnWidth = Number.isFinite(maxWidth) ? Math.min(room, maxWidth) : room
  const centred = Math.max(0, (room - columnWidth) / 2)
  return box.left + gutter + centred
}

/**
 * Report where the surface a reader is reading starts.
 *
 * The app header puts the thread's name on that surface's column instead of on
 * the sidebar's, because the page is the thing the reader is looking at. The
 * conversation's scroll surface is that page, and measuring it is the whole job:
 * the box's left edge plus its own left padding, plus the room the column is
 * centred in.
 *
 * A surface the reader cannot see keeps the last coordinate it reported instead
 * of resetting it. Hiding the conversation (a studio taking the pane) is not the
 * same as taking it off screen: resetting there is what dropped the thread's name
 * back to the end of the header's chrome the moment a studio opened, so the name
 * jumped left while everything below it changed. The last real edge is the honest
 * answer until another reading surface claims the column.
 */
export function createReadingColumn(): {
  /** Put on the element whose text the header should align to. */
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
    const gutter = Number.parseFloat(getComputedStyle(target).paddingLeft) || 0
    layoutPanelState.setReadingColumn(owner, Math.round(columnLeftInGrid(target, gutter)))
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
    /* The page column keeps its width while the pane around it narrows, so the
       pane the column is centred in is observed as well: every panel, drag and
       window resize shows up there. The grid above it is what the centring is
       measured against, and a panel reserving its track changes the grid before
       it changes anything the column can see. */
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
