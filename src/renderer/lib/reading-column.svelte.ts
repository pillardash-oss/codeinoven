import type { Attachment } from 'svelte/attachments'

import { layoutPanelState } from '$lib/stores/layout-panel.svelte'

/**
 * Report where the column a reader is reading starts.
 *
 * The app header puts the thread's name on that column's left edge instead of on
 * the sidebar's, because the page is the thing the reader is looking at: the name
 * and the messages read as one surface, so they move as one surface. The
 * conversation's page column is that surface, and measuring it is the whole job:
 * the box's left edge plus its own left padding, because the text starts after
 * that padding and aligning to the box leaves the name a few pixels off the line
 * the messages start on.
 *
 * It is measured live, not against the layout the workspace was built for. A
 * panel sliding in on the right narrows the pane, the centred column re-centres,
 * and the name travels with it frame by frame   the same slide the conversation
 * itself is making, never a snap at the end of it. That is why the pane around
 * the column is observed as well as the column: the column keeps its width while
 * the pane narrows, so only the pane reports the movement.
 *
 * A surface the reader cannot see keeps the last coordinate it reported instead
 * of resetting it. Hiding the conversation (a studio taking the pane) is not the
 * same as taking it off screen: resetting there is what dropped the thread's name
 * back to the end of the header's chrome the moment a studio opened, so the name
 * jumped left while everything below it changed. The last real text edge is the
 * honest answer until another reading surface claims the column.
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
    const padding = Number.parseFloat(getComputedStyle(target).paddingLeft) || 0
    layoutPanelState.setReadingColumn(
      owner,
      Math.round(target.getBoundingClientRect().left + padding)
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
    /* The page keeps its width while the pane around it shifts, so observing the
       column alone misses every panel that opens, closes or is dragged beside it:
       the column moves without resizing. The pane it sits in is what actually
       changes size, and observing that is what carries the name along with the
       slide instead of leaving it behind until the next report. */
    const pane = node.parentElement
    if (pane) observer.observe(pane)
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
