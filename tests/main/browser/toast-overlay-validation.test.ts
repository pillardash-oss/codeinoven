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
})
