/**
 * Reactive "are we on a phone-sized viewport" flag.
 *
 * Tailwind's `max-md:` variants cover everything the stylesheet can express,
 * but a few places position elements with inline `style:` directives — and an
 * inline style always beats a class. Those call sites need the breakpoint as a
 * value, not as CSS, so they can skip the desktop positioning entirely.
 *
 * The desktop window has a 1024px minimum width, so this is only ever true on
 * the remote PWA.
 */

/** Matches Tailwind's `md` breakpoint (48rem). */
const COMPACT_QUERY = '(max-width: 47.999rem)'

class CompactViewport {
  #matches = $state(false)
  #query: MediaQueryList | null = null

  constructor() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    this.#query = window.matchMedia(COMPACT_QUERY)
    this.#matches = this.#query.matches
    this.#query.addEventListener('change', (event) => {
      this.#matches = event.matches
    })
  }

  /** True while the viewport is narrower than Tailwind's `md` breakpoint. */
  get matches(): boolean {
    return this.#matches
  }
}

export const compactViewport = new CompactViewport()
