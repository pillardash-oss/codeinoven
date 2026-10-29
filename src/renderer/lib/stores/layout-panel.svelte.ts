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
   * Where the surface the reader is reading begins, in window pixels.
   *
   * The header's thread block aligns to that surface's own text edge rather than
   * to the panel: the page is the thing the reader is looking at, and the panel is
   * only how much room it has. The surface on screen owns it, and a surface that
   * is hidden rather than gone (a studio taking the pane) keeps the last edge it
   * measured, so the thread's name stays put through the toggle instead of jumping
   * back to the end of the header's chrome. Zero until a reading surface has
   * reported.
   *
   * It is the surface's gutter, never the centred page column's position: that
   * column re-centres whenever a panel narrows the surface from the right, and a
   * temporary chat opening beside the conversation must not move the name of the
   * thread it is not part of.
   */
  private readingColumn = $state<{ owner: object; left: number } | null>(null)
  /**
   * The same ownership kept where no effect can see it.
   *
   * A reporter runs inside an effect, so the comparison that decides whether a
   * report is news must not read the state it is about to write: an effect that
   * reads and writes one piece of state is an infinite update loop. These plain
   * fields are that comparison.
   */
  private readingOwner: object | null = null
  private readingLeft = 0
  /**
   * Whether the workspace shell is the page on screen. The shell stays mounted
   * across views so returning to a thread never reloads it, which means a
   * conversation that is not being looked at still has a position: the header
   * has to know to ignore it.
   */
  contentVisible = $state(true)

  get readingColumnLeft(): number {
    return this.readingColumn?.left ?? 0
  }

  /**
   * Where the pane a studio owns sits, in window pixels, or null when no studio is
   * on screen.
   *
   * The studio replaces the conversation, so the header has no reading column to
   * put the thread's name on. Its name belongs in the middle of that pane instead,
   * and the pane is not the window: a context panel beside the studio narrows it,
   * which is exactly what the name has to follow.
   */
  private studioPane = $state<{ left: number; width: number } | null>(null)
  /** The same box kept where no effect can see it, so a reporting effect never
   *  reads the state it writes. */
  private studioPaneReported = false
  private studioPaneLeft = 0
  private studioPaneWidth = 0

  get studioPaneBox(): { left: number; width: number } | null {
    return this.studioPane
  }

  /** Claim the studio pane's box for the surface that owns it. */
  setStudioPane(left: number, width: number): void {
    if (this.studioPaneReported && this.studioPaneLeft === left && this.studioPaneWidth === width)
      return
    this.studioPaneReported = true
    this.studioPaneLeft = left
    this.studioPaneWidth = width
    this.studioPane = { left, width }
  }

  /** Give the studio pane up, which is what closing the studio does. */
  clearStudioPane(): void {
    if (!this.studioPaneReported) return
    this.studioPaneReported = false
    this.studioPaneLeft = 0
    this.studioPaneWidth = 0
    this.studioPane = null
  }

  /**
   * Claim the reading column for one surface.
   *
   * Ownership rather than a last-write-wins number: two reading surfaces can be
   * mounted at once (a studio over the conversation it was opened from), and the
   * hidden one's own resize reports arrive in either order. Whoever is on screen
   * reports, and the surface that is not on screen never overwrites it.
   */
  setReadingColumn(owner: object, left: number): void {
    if (this.readingOwner === owner && this.readingLeft === left) return
    this.readingOwner = owner
    this.readingLeft = left
    this.readingColumn = { owner, left }
  }

  /** Give the reading column up, but only if this surface still holds it. */
  clearReadingColumn(owner: object): void {
    if (this.readingOwner !== owner) return
    this.readingOwner = null
    this.readingLeft = 0
    this.readingColumn = null
  }

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
    this.panels = this.panels.map((panel) => (panel.token === token ? { token, width } : panel))
  }

  release(token: number): void {
    if (!this.panels.some((panel) => panel.token === token)) return
    this.panels = this.panels.filter((panel) => panel.token !== token)
  }
}

export const layoutPanelState = new LayoutPanelState()
