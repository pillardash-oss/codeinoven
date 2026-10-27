/**
 * The docked width of the sidebar that is actually on screen.
 *
 * The app header is one row above the whole shell, so the only way it can put
 * its chrome/title boundary on the sidebar's right edge is if the sidebar says
 * where that edge is. Each mounted sidebar registers itself here and reports its
 * docked width, so a view without a sidebar reports nothing at all and the
 * header keeps its chrome at its own width instead of reserving a column that is
 * not there.
 *
 * Only one sidebar is docked at a time; the widest registration wins so a
 * sidebar mid-transition can never shrink the header's column to zero.
 */

interface PanelRegistration {
  token: number
  width: number
}

let nextToken = 1

class LayoutPanelState {
  /** Registered sidebars with their current docked width, zero when undocked. */
  private panels = $state<PanelRegistration[]>([])
  /** The view rail the sidebar sits after, measured from the window edge. */
  readonly railWidth = 40
  /**
   * The narrowest the panel may get before the header's own chrome stops fitting
   * inside it. The header owns this number because it is the one that knows how
   * wide its mark, navigation and actions are; the sidebar reads it so a drag can
   * never pull the bar's controls out of their column.
   */
  minimumWidth = $state(0)
  /**
   * Where the conversation's own page column starts, in window pixels.
   *
   * The header's thread block aligns to that column rather than to the panel: the
   * page is the thing the reader is looking at, and the panel is only how much
   * room it has. Zero when no conversation is on screen, which leaves the block at
   * the end of the header's chrome.
   */
  conversationLeft = $state(0)

  /** Docked width of the sidebar on screen, zero when none is docked. */
  get dockedWidth(): number {
    let widest = 0
    for (const panel of this.panels) {
      if (panel.width > widest) widest = panel.width
    }
    return widest
  }

  register(width: number): number {
    const token = nextToken++
    this.panels = [...this.panels, { token, width }]
    return token
  }

  report(token: number, width: number): void {
    const current = this.panels.find((panel) => panel.token === token)
    if (!current || current.width === width) return
    this.panels = this.panels.map((panel) =>
      panel.token === token ? { token, width } : panel
    )
  }

  release(token: number): void {
    if (!this.panels.some((panel) => panel.token === token)) return
    this.panels = this.panels.filter((panel) => panel.token !== token)
  }
}

export const layoutPanelState = new LayoutPanelState()
