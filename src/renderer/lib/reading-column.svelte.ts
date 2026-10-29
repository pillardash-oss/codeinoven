import type { Attachment } from 'svelte/attachments'

import { layoutPanelState } from '$lib/stores/layout-panel.svelte'

/**
 * Report where the surface a reader is reading starts.
 *
 * The app header puts the thread's name on that surface's own text edge instead
 * of on the sidebar's, because the page is the thing the reader is looking at.
 * The conversation's scroll surface is that page, and measuring it is the whole
 * job: the box's left edge plus its own left padding, which is the same gutter
 * the message column starts on whenever the page column is narrower than the
 * pane it sits in.
 *
 * What is deliberately NOT measured is the centred message column's own left
 * edge. That column re-centres inside the surface whenever the surface's width
 * changes, so a panel opening beside the conversation (a temporary chat, a
 * browser, a diff: anything the reader docks on the right) would drag the
 * thread's name sideways with it. A temp chat has nothing to do with the thread
 * the title names, so the title may not follow it. The surface's gutter only
 * moves when the surface itself moves, which is the sidebar the title belongs to.
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
    /* The surface keeps its left edge while a panel narrows it from the right,
       and moves without resizing when the sidebar beside it changes width, so
       the box next to it is observed too: between the two, every move and every
       resize of the surface that matters is caught. */
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
