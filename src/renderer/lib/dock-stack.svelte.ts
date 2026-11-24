/**
 * Stacking order for the app's floating dock surfaces.
 *
 * A docked chip row (the minimized row a dockable panel collapses into) and the
 * dockable panel itself float in the same band, and several of them can be on
 * screen at once: a pull request draft, a project's env secrets and an update
 * run may all be docked at the same time. Without an order the DOM decided which
 * one covered which, so the row mounted last sat on top and a chip dragged over
 * another dock slid behind it.
 *
 * Every dock surface joins this stack when it appears and promotes itself to the
 * top of its band the moment the user touches it: pressing a chip, dragging its
 * head, focusing into a panel. The surface being worked in is therefore always
 * the one in front, and it stays in front until another one is touched.
 *
 * The order is kept per band, because the bands are what the rest of the app
 * already leans on: a `surface` dock stays below the full screen surfaces
 * (terminal, browser, editors and the pull request reader, all at `z-60`), and a
 * `top` dock stays below the portaled menus inside it (`z-90`).
 */

/** The stacking band a dock surface lives in. */
export type DockLayer = 'surface' | 'top'

/** Where each band starts. */
const LAYER_BASE_Z: Record<DockLayer, number> = { surface: 50, top: 80 }

/**
 * How many steps a dock can climb inside its band.
 *
 * Nine keeps every raise under the next band (`60` above the full screen
 * surfaces, `90` above the menus). Past nine docks on screen the order ties,
 * which costs nothing visible: a dozen chips piled on one corner are never read
 * for their depth.
 */
const MAX_RAISE = 9

class DockStack {
  /**
   * The order itself is plain state, and `#revision` is the only signal.
   *
   * A dock promotes itself from an effect (it joins on mount and climbs again
   * whenever the user works in it), and an effect that read a reactive array and
   * then mutated it would keep invalidating itself. The plain array plus a
   * counter written on every change keeps that impossible: promoting reads no
   * reactive value, and a `z-index` derived from `#revision` still recomputes
   * whenever the order moves.
   */
  #order: Record<DockLayer, string[]> = { surface: [], top: [] }
  #revision = $state(0)
  /**
   * The number the next revision is set to, kept off the signal so promoting
   * never reads what it writes (`#revision++` would read the counter it bumps and
   * an effect that promoted on mount would invalidate itself forever).
   */
  #nextRevision = 0

  #touch(): void {
    this.#revision = ++this.#nextRevision
  }

  /**
   * Put a dock surface in front of its band.
   *
   * A surface that is not in the stack yet joins it on top, so mounting is
   * enough to bring a dock forward.
   */
  promote(layer: DockLayer, id: string): void {
    const order = this.#order[layer]
    const index = order.indexOf(id)
    if (index !== -1) {
      if (index === order.length - 1) return
      order.splice(index, 1)
    }
    order.push(id)
    this.#touch()
  }

  /** Drop a dock surface that is no longer on screen. */
  leave(layer: DockLayer, id: string): void {
    const order = this.#order[layer]
    const index = order.indexOf(id)
    if (index === -1) return
    order.splice(index, 1)
    this.#touch()
  }

  /**
   * The `z-index` a dock surface paints at: its band's base plus its depth.
   *
   * A surface that never joined the stack still gets its band's base, so a
   * missing registration can only cost it a place in the order, never its
   * layer.
   */
  zIndex(layer: DockLayer, id: string): number {
    // Reading the revision is what subscribes the caller to the whole order: a
    // `z-index` is a place in a list, so any move can change it.
    void this.#revision
    const index = this.#order[layer].indexOf(id)
    return LAYER_BASE_Z[layer] + (index === -1 ? 0 : Math.min(index, MAX_RAISE))
  }
}

export const dockStack = new DockStack()
