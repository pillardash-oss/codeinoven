import { describe, expect, it } from 'vitest'
import {
  failedAnswerError,
  isStaleServiceFault,
  normalizeServiceBundle,
  serviceBundleRevision
} from '../../../src/main/ovens/oven-service-bundle'

describe('oven service bundle identity', () => {
  it('hashes one bundle to one revision whatever its trailing newlines', () => {
    const source = 'export const value = 1\n'
    expect(serviceBundleRevision(source)).toBe(serviceBundleRevision(`${source}\n\n`))
    expect(normalizeServiceBundle(`${source}\n\n`)).toBe(source)
  })

  it('treats the Windows shim failure as an outdated service, not a request failure', () => {
    // An older bundle could not start npm's `.cmd` shim, so every request it
    // answered failed this way while the Oven itself was healthy.
    expect(isStaleServiceFault('spawn EINVAL')).toBe(true)
  })

  it('treats the old generic reinstall text as an outdated service', () => {
    expect(
      isStaleServiceFault(
        'The Oven service is unavailable. Check its Node runtime and install the service again.'
      )
    ).toBe(true)
  })

  it('treats a protocol mismatch as an outdated service', () => {
    expect(isStaleServiceFault('Oven protocol version mismatch.')).toBe(true)
  })

  it('leaves a current service explaining its own request failure alone', () => {
    // Reinstalling cannot repair a reason the running code already named.
    expect(
      isStaleServiceFault(
        'The Oven service could not handle this request: EACCES: permission denied, open runs'
      )
    ).toBe(false)
    expect(isStaleServiceFault('The Oven did not answer in time.')).toBe(false)
    expect(isStaleServiceFault('SSH connection failed (255).')).toBe(false)
  })
})

describe('oven service answers', () => {
  it('reads the error a failed service answer carries', () => {
    expect(failedAnswerError('{"ok":false,"error":"spawn EINVAL"}')).toBe('spawn EINVAL')
    expect(failedAnswerError('\uFEFF{"ok":false,"error":"spawn EINVAL"}\n')).toBe('spawn EINVAL')
  })

  it('reports no error for a healthy or unreadable answer', () => {
    expect(failedAnswerError('{"ok":true,"value":{"serviceRevision":"a"}}')).toBeNull()
    expect(failedAnswerError('{"ok":false,"error":{"nested":true}}')).toBeNull()
    expect(failedAnswerError('not json')).toBeNull()
  })
})
