import { describe, expect, it } from 'vitest'
import {
  SITE_PERMISSION_DESCRIPTORS,
  permissionKey,
  sitePermissionState
} from '../../../src/main/browser/browser-service/browser-permissions'
import { validateSiteMenuOrigin } from '../../../src/main/browser/browser-service/browser-validation'

const ORIGIN = 'https://meet.google.com'

function keysFor(id: string): string[] {
  const descriptor = SITE_PERMISSION_DESCRIPTORS.find((entry) => entry.id === id)
  if (!descriptor) throw new Error(`Unknown site permission: ${id}`)
  return descriptor.keysFor(ORIGIN)
}

describe('manual site permissions', () => {
  it('maps camera and microphone onto the media ledger keys the prompt uses', () => {
    expect(keysFor('camera')).toEqual([permissionKey(ORIGIN, 'media', 'video')])
    expect(keysFor('microphone')).toEqual([permissionKey(ORIGIN, 'media', 'audio')])
  })

  it('offers location and notifications as their own permission keys', () => {
    expect(keysFor('location')).toEqual([permissionKey(ORIGIN, 'geolocation', '')])
    expect(keysFor('notifications')).toEqual([permissionKey(ORIGIN, 'notifications', '')])
  })

  it('reads ask when nothing was decided, allowed after a grant, blocked after a refusal', () => {
    const keys = keysFor('camera')
    expect(sitePermissionState(keys, new Set(), new Set())).toBe('ask')
    expect(sitePermissionState(keys, new Set(keys), new Set())).toBe('allowed')
    expect(sitePermissionState(keys, new Set(), new Set(keys))).toBe('blocked')
  })

  it('lets a remembered refusal win over a grant, as the request handler does', () => {
    const keys = keysFor('microphone')
    expect(sitePermissionState(keys, new Set(keys), new Set(keys))).toBe('blocked')
  })

  it('keeps one origin distinct from another', () => {
    const keys = keysFor('camera')
    const other = SITE_PERMISSION_DESCRIPTORS[0]?.keysFor('https://example.com') ?? []
    expect(sitePermissionState(keys, new Set(other), new Set())).toBe('ask')
  })
})

describe('validateSiteMenuOrigin', () => {
  it('accepts an https origin as-is', () => {
    expect(validateSiteMenuOrigin('https://meet.google.com')).toBe('https://meet.google.com')
  })

  it('normalizes a URL to its origin', () => {
    expect(validateSiteMenuOrigin('https://meet.google.com/abc?x=1')).toBe(
      'https://meet.google.com'
    )
  })

  it('accepts http loopback origins for local development', () => {
    expect(validateSiteMenuOrigin('http://127.0.0.1:51234/')).toBe('http://127.0.0.1:51234')
  })

  it('returns null when the address is not a site', () => {
    expect(validateSiteMenuOrigin('')).toBeNull()
    expect(validateSiteMenuOrigin('about:blank')).toBeNull()
    expect(validateSiteMenuOrigin('not a url')).toBeNull()
    expect(validateSiteMenuOrigin('file:///etc/hosts')).toBeNull()
  })

  it('rejects non-string and unbounded input', () => {
    expect(() => validateSiteMenuOrigin(null)).toThrow(TypeError)
    expect(() => validateSiteMenuOrigin(42)).toThrow(TypeError)
    expect(() => validateSiteMenuOrigin(`https://${'h'.repeat(2_000)}`)).toThrow(TypeError)
    expect(() => validateSiteMenuOrigin('https://example.com\0')).toThrow(TypeError)
  })
})
