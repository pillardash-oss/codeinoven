/** A panel rectangle in CSS pixels relative to the parent renderer viewport. */
export interface NativeFloatingPanelBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * How a floating panel's host window behaves while it is on screen.
 *
 * A panel that carries a field, an editor or a terminal takes focus when it
 * expands: typing in it is the point, and the tree it adopts was already live in
 * this window. A passive panel is the opposite case: a dropdown anchored to a
 * field the user is typing in. Activating its window would take the caret out of
 * that field, so a passive host is created non-focusable, is never focused, and is
 * only ever clicked.
 */
export interface NativeFloatingPanelOptions {
  /**
   * Whether the host may take window focus when it appears. Defaults to true;
   * a dropdown over a live page sets it to false.
   */
  takesFocus?: boolean
}
