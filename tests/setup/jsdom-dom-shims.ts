/**
 * Browser APIs jsdom does not implement, installed for every test file.
 *
 * `matchMedia` is the one that bites hardest: jsdom ships no implementation, and
 * Svelte's `prefersReducedMotion` (`svelte/motion`, itself a `MediaQuery`) calls
 * it the moment a component that uses it is imported. Without this shim, every
 * jsdom test whose module graph reaches `Modal.svelte`, `NativeStripSurface.svelte`
 * or the compact-viewport flag dies at import time with
 * `TypeError: window.matchMedia is not a function` rather than exercising the
 * behaviour it was written for.
 *
 * The shim answers width/height queries from jsdom's real viewport (1024x768 by
 * default) so a layout test still sees the desktop answer, and reports `false`
 * for preference queries such as `prefers-reduced-motion` and
 * `prefers-color-scheme`, which is jsdom's own default posture.
 */

/** One axis of a media query value: a length in px, resolved against the viewport. */
function resolveLength(value: string): number | null {
  const match = /^(-?\d*\.?\d+)(px)?$/.exec(value.trim())
  if (!match) return null
  return Number(match[1])
}

function matchesQuery(query: string): boolean {
  const features = query.toLowerCase().match(/\(([^)]+)\)/g)
  if (!features) return false

  const viewport: Record<string, number> = {
    width: globalThis.window.innerWidth,
    height: globalThis.window.innerHeight
  }

  return features.every((feature) => {
    const body = feature.slice(1, -1).trim()
    const [rawProperty, rawValue] = body.split(':')
    if (rawValue === undefined) return false

    const property = rawProperty.trim()
    const value = resolveLength(rawValue)
    if (value === null) return false

    const axis = property.endsWith('width')
      ? viewport.width
      : property.endsWith('height')
        ? viewport.height
        : null
    if (axis === null) return false

    if (property.startsWith('min-')) return axis >= value
    if (property.startsWith('max-')) return axis <= value
    return Math.abs(axis - value) < 0.001
  })
}

if (
  typeof globalThis.window !== 'undefined' &&
  typeof globalThis.window.matchMedia !== 'function'
) {
  Object.defineProperty(globalThis.window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => {
      // A jsdom run has no viewport to resize, so the query never flips while a
      // test is mounted: subscription is accepted and deliberately never fires.
      const list: MediaQueryList = {
        media: query,
        get matches() {
          return matchesQuery(query)
        },
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true
      }
      return list
    }
  })
}
