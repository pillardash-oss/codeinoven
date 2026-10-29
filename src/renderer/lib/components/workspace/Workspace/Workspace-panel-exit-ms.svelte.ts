import { guideState } from '$lib/guide/guide-state.svelte'
import { motionDuration } from '$lib/motion'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'

import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspacePanelExitMs {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root) throw new Error('WorkspacePanelExitMs read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  sidebarVisible = $derived(contextSidebarState.sidebarVisible)

  // The grid column/row that hosts each panel collapses the instant
  // `sidebarVisible`/`terminalDockVisible` flips, but the panel itself keeps
  // playing its out:fly for PANEL_EXIT_MS. Without this, the closing panel is
  // orphaned outside the (now single-track) grid for that whole window
  // a stray gap opens up where its column used to be. Reserving the track
  // until the outro actually finishes keeps the panel inside its cell for
  // the whole animation.
  //
  // The panel must leave the moment its region goes away, not when the
  // reservation ends: the outro is what the reservation is for. Gating the
  // panel on the reservation instead held it in its cell, squeezed it to
  // nothing as the animated rail track collapsed, and only *then* let it fly
  // out. With the column gone by that point the flying panel fell into an
  // implicit auto track, so the thread narrowed again by the panel's own width
  // for the whole outro and snapped back when the node was finally removed.
  // The region's panel and its track are two clocks, and the panel's starts
  // first.
  //
  // A region can also have to stay mounted because a panel inside it owns a
  // surface that covers the whole window: the full screen file editor renders
  // its modal from the files panel. Hiding the sidebar, or any other reason
  // `sidebarVisible` goes false while the files panel is still the region's
  // active panel, used to unmount that panel and take the editor with it. The
  // workspace showed behind the surface for a moment and the surface came
  // straight back, because the request that had opened it was never cleared, so
  // remounting the panel re-opened a window the user never closed. The pin is
  // scoped to the panel that actually hosts the surface, so a region with no
  // files panel (a thread that was left, a panel that was closed outright)
  // still goes away exactly as it did before.
  PANEL_EXIT_MS = 160

  /**
   * The rail's animated track width, in the registered property the column
   * above reads. It is a length at every moment, so the track grows and shrinks
   * frame by frame and the thread beside it follows, the same motion the left
   * sidebar gets from `slideWidth`.
   */
  /**
   * While a guide runs, its dock is a column at the right edge, so the tool
   * panel gets out of the way rather than letting the thread take the squeeze.
   *
   * It is hidden, never closed: the track collapses to nothing and the panel
   * stops painting, while its tabs, width, scroll and open terminal all stay
   * exactly as they were. Tearing it down would be a different thing entirely
   * (a coordinator or editor inside it is not always safe to unmount), and the
   * user asked for a guide, not for their panel to be closed.
   */
  guideHidesToolPanel = $derived(guideState.visible)

  railTrackWidth = $derived(
    this.sidebarVisible && !this.guideHidesToolPanel
      ? `${Math.round(contextSidebarState.width)}px`
      : '0px'
  )

  /**
   * True while the user drags the rail's edge. A drag has to track the pointer
   * exactly, so the track's transition is switched off for its duration instead
   * of easing behind every pointer move.
   */
  railDragging = $state(false)

  railDragTimer = $state<ReturnType<typeof setTimeout> | undefined>()

  railTrackDuration = $derived(
    this.railDragging
      ? '0ms'
      : `${motionDuration(this.sidebarVisible ? 200 : this.PANEL_EXIT_MS)}ms`
  )

  /** Move the rail: a drag writes the width straight through, everything else
   *  is the open/close transition above. */
  handleRailWidthChange(width: number): void {
    this.railDragging = true
    clearTimeout(this.railDragTimer)
    this.railDragTimer = setTimeout(() => (this.railDragging = false), motionDuration(160))
    contextSidebarState.setWidth(width)
  }
}
