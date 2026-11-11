import { describe, expect, it } from 'vitest'
import { previewScope } from '../../src/lib/preview-scope'

const PROJECT = 'f68bd7a8ef37b378d7da04b0'

describe('previewScope', () => {
  it('reads the scope a preview URL was built for', () => {
    const url = new URL(`appfile://project/${PROJECT}/logo.svg?scope=scope-mw1wu97a-nwlhjb`)
    expect(previewScope(url)).toBe('scope-mw1wu97a-nwlhjb')
  })

  it('answers undefined for a URL that names no scope', () => {
    expect(previewScope(new URL(`appfile://project/${PROJECT}/logo.svg`))).toBeUndefined()
    expect(previewScope(new URL(`appfile://project/${PROJECT}/logo.svg?scope=`))).toBeUndefined()
  })

  it('refuses a scope that is not an app-issued slug', () => {
    for (const bad of ['../../etc', 'scope/one', 'scope one', 'scope%2Fone', 'a?b']) {
      const url = new URL(`appfile://project/${PROJECT}/logo.svg?scope=${encodeURIComponent(bad)}`)
      expect(previewScope(url), bad).toBeNull()
    }
  })
})
