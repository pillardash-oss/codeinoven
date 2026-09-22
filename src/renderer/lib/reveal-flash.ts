/**
 * Draw the eye to whatever a jump landed on.
 *
 * A jump into a long surface (a settings section, a pull request conversation)
 * drops the reader among rows that all look alike, with nothing to say which one
 * was asked for. The target's border flashes three times instead, which is the
 * only part of the answer a scroll position cannot give on its own.
 *
 * Shared by both surfaces that jump this way, so they cannot drift into two
 * different animations for the same idea. The class and its keyframes live in
 * `app.css` (`.reveal-flash`).
 */
export function flashElement(element: HTMLElement): void {
  element.classList.remove('reveal-flash')
  // Read the layout back so the animation restarts cleanly when the same target
  // is asked for twice in a row, instead of being ignored as already running.
  void element.offsetWidth
  element.classList.add('reveal-flash')
  element.addEventListener('animationend', () => element.classList.remove('reveal-flash'), {
    once: true
  })
}
