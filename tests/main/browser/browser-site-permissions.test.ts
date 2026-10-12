import { describe, expect, it } from 'vitest'
import {
  SITE_PERMISSION_CATALOG,
  isScreenCaptureRequest,
  permissionKey,
  permissionKeysForRequest,
  screenCaptureDeniedInLedger,
  sitePermissionState
} from '../../../src/lib/browser/site-permissions'
import { validateSiteMenuOrigin } from '../../../src/main/browser/browser-service/browser-validation'

const ORIGIN = 'https://meet.google.com'

function keysFor(id: string): string[] {
  const descriptor = SITE_PERMISSION_CATALOG.find((entry) => entry.id === id)
  if (!descriptor) throw new Error(`Unknown site permission: ${id}`)
  return descriptor.keysFor(ORIGIN)
}

describe('site permission catalog', () => {
  it('maps camera and microphone onto the media ledger keys the prompt uses', () => {
    expect(keysFor('camera')).toEqual([permissionKey(ORIGIN, 'media', 'video')])
    expect(keysFor('microphone')).toEqual([permissionKey(ORIGIN, 'media', 'audio')])
  })

  it('maps screen sharing onto its own dedicated key, never the bare media key', () => {
    expect(keysFor('screen-share')).toEqual([permissionKey(ORIGIN, 'display-capture')])
    expect(keysFor('screen-share')).not.toContain(permissionKey(ORIGIN, 'media'))
  })

  it('offers location and notifications as their own permission keys', () => {
    expect(keysFor('location')).toEqual([permissionKey(ORIGIN, 'geolocation')])
    expect(keysFor('notifications')).toEqual([permissionKey(ORIGIN, 'notifications')])
  })

  it('has a unique id, a label and at least one ledger key for every entry', () => {
    const ids = new Set<string>()
    for (const descriptor of SITE_PERMISSION_CATALOG) {
      expect(descriptor.id, descriptor.id).not.toBe('')
      expect(ids.has(descriptor.id), `duplicate id ${descriptor.id}`).toBe(false)
      ids.add(descriptor.id)
      expect(descriptor.label, descriptor.id).not.toBe('')
      expect(descriptor.keysFor(ORIGIN).length, descriptor.id).toBeGreaterThan(0)
    }
  })

  it('reads ask when nothing was decided, allow after a grant, block after a refusal', () => {
    const keys = keysFor('camera')
    expect(sitePermissionState(keys, new Set(), new Set())).toBe('ask')
    expect(sitePermissionState(keys, new Set(keys), new Set())).toBe('allow')
    expect(sitePermissionState(keys, new Set(), new Set(keys))).toBe('block')
  })

  it('lets a remembered refusal win over a grant, as the request handler does', () => {
    const keys = keysFor('microphone')
    expect(sitePermissionState(keys, new Set(keys), new Set(keys))).toBe('block')
  })

  it('keeps one origin distinct from another', () => {
    const keys = keysFor('camera')
    const other = keysFor('camera')
    const otherOrigin = SITE_PERMISSION_CATALOG[0]?.keysFor('https://example.com') ?? []
    expect(other).toEqual(keys)
    expect(sitePermissionState(keys, new Set(otherOrigin), new Set())).toBe('ask')
  })
})

describe('permissionKeysForRequest', () => {
  it('maps a screen-share request (bare media) onto the display-capture key', () => {
    expect(
      permissionKeysForRequest({ origin: ORIGIN, permission: 'media', mediaTypes: [] })
    ).toEqual([permissionKey(ORIGIN, 'display-capture')])
    expect(isScreenCaptureRequest('media', [])).toBe(true)
  })

  it('keeps camera and microphone requests on their own media scope keys', () => {
    expect(
      permissionKeysForRequest({ origin: ORIGIN, permission: 'media', mediaTypes: ['audio'] })
    ).toEqual([permissionKey(ORIGIN, 'media', 'audio')])
    expect(
      permissionKeysForRequest({ origin: ORIGIN, permission: 'media', mediaTypes: ['video'] })
    ).toEqual([permissionKey(ORIGIN, 'media', 'video')])
    expect(isScreenCaptureRequest('media', ['video'])).toBe(false)
  })

  it('keeps a plain permission on its own key', () => {
    expect(
      permissionKeysForRequest({ origin: ORIGIN, permission: 'geolocation', mediaTypes: [] })
    ).toEqual([permissionKey(ORIGIN, 'geolocation')])
  })
})

describe('screenCaptureDeniedInLedger', () => {
  it('reports a refusal remembered for the screen-share key', () => {
    const denies = new Set([permissionKey(ORIGIN, 'display-capture')])
    expect(screenCaptureDeniedInLedger(denies, ORIGIN)).toBe(true)
    expect(screenCaptureDeniedInLedger(denies, 'https://example.com')).toBe(false)
  })

  it('never reads a camera or microphone refusal as a screen-share refusal', () => {
    const denies = new Set([
      permissionKey(ORIGIN, 'media', 'video'),
      permissionKey(ORIGIN, 'media', 'audio')
    ])
    expect(screenCaptureDeniedInLedger(denies, ORIGIN)).toBe(false)
    expect(screenCaptureDeniedInLedger(undefined, ORIGIN)).toBe(false)
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
