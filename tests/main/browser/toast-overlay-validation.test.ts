import { describe, expect, it } from 'vitest'
import { MAX_OVERLAY_TOASTS } from '../../../src/lib/browser-overlay'
import { validateToastOverlayRequest } from '../../../src/main/browser/browser-service/browser-validation'

/**
 * A stack the app renderer could really publish: sonner keeps its toasts newest
 * first, so `toast-0` is the card the user is looking at.
 */
function stackOf(count: number): unknown {
  return {
    revision: 7,
    theme: 'dark',
    toasts: Array.from({ length: count }, (_, index) => ({
      id: `toast-${index}`,
      kind: 'success',
      title: `Toast ${index}`
    }))
  }
}

describe('toast overlay request validation', () => {
  it('carries a stack within the ceiling whole', () => {
    const request = validateToastOverlayRequest(stackOf(MAX_OVERLAY_TOASTS))
    expect(request?.toasts).toHaveLength(MAX_OVERLAY_TOASTS)
    expect(request?.revision).toBe(7)
  })

  /**
   * The regression this guards: an over-long stack used to throw, so the app
   * renderer's only route to a visible notification over a browser page failed
   * for as long as sonner held more toasts than the ceiling. A session whose
   * toast timers were paused kept every notification and then showed none.
   */
  it('keeps the newest cards of an over-long stack instead of refusing the update', () => {
    const request = validateToastOverlayRequest(stackOf(MAX_OVERLAY_TOASTS + 9))
    expect(request?.toasts).toHaveLength(MAX_OVERLAY_TOASTS)
    expect(request?.toasts[0]?.id).toBe('toast-0')
    expect(request?.toasts.at(-1)?.id).toBe(`toast-${MAX_OVERLAY_TOASTS - 1}`)
  })

  it('still refuses a request that carries no toast list at all', () => {
    expect(() => validateToastOverlayRequest({ revision: 1, theme: 'dark' })).toThrow(TypeError)
    expect(validateToastOverlayRequest(null)).toBeNull()
  })

  /**
   * The regression this guards: this validator is a whitelist, so a field it does
   * not name is dropped in silence, and a dropped icon is a card built around a
   * chip that never paints. The memory proposal spent its life that way: it
   * crossed as a `memory` kind this file's kind set did not carry, was rewritten
   * to `default`, and every fix downstream went on fixing a card that had already
   * lost the thing the user was looking for.
   */
  it('keeps the icon token a card leads with', () => {
    const request = validateToastOverlayRequest({
      revision: 3,
      theme: 'dark',
      toasts: [
        { id: 0, kind: 'default', icon: 'memory', title: 'A preference worth remembering' },
        { id: 1, kind: 'default', icon: 'clipboard', title: 'Copied to clipboard' }
      ]
    })
    expect(request?.toasts.map((entry) => entry.icon)).toEqual(['memory', 'clipboard'])
  })

  it('drops an icon token the overlay cannot draw', () => {
    const request = validateToastOverlayRequest({
      revision: 4,
      theme: 'dark',
      toasts: [{ id: 0, kind: 'default', icon: 'not-an-icon', title: 'Copied to clipboard' }]
    })
    expect(request?.toasts[0]?.kind).toBe('default')
    expect(request?.toasts[0]?.icon).toBeUndefined()
  })
})
