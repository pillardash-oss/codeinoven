import { describe, expect, it } from 'vitest'
import { resolvePrototypePreviewOrigin } from '../../src/main/prototypes/prototype-preview-origin'

describe('prototype preview origin', () => {
  it('accepts explicit production HTTPS without inventing a host', () => {
    expect(
      resolvePrototypePreviewOrigin(
        { CODEINOVEN_PUBLIC_PROTOTYPE_PREVIEW_ORIGIN: 'https://previews.acme.dev' },
        { development: false }
      )
    ).toEqual({
      ready: true,
      origin: 'https://previews.acme.dev',
      source: 'runtime'
    })
  })

  it('rejects non-loopback HTTP and missing production configuration', () => {
    expect(
      resolvePrototypePreviewOrigin(
        { CODEINOVEN_PUBLIC_PROTOTYPE_PREVIEW_ORIGIN: 'http://previews.acme.dev' },
        { development: false }
      )
    ).toMatchObject({ ready: false, origin: null, source: 'runtime' })
    expect(resolvePrototypePreviewOrigin({}, { development: false })).toMatchObject({
      ready: false,
      origin: null,
      source: 'missing'
    })
  })

  it('uses only an allocated loopback port as the development fallback', () => {
    expect(resolvePrototypePreviewOrigin({}, { development: true, allocatedPort: 43117 })).toEqual({
      ready: true,
      origin: 'http://127.0.0.1:43117',
      source: 'loopback'
    })
  })
})
