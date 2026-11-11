import { describe, expect, it } from 'vitest'
import { projectFilePreviewUrl } from '../../../src/renderer/lib/file-preview'

const PROJECT = 'f68bd7a8ef37b378d7da04b0'
const THREAD = 'ba990b81e769136d6505eab4'
const SCOPE = 'scope-mw1wu97a-nwlhjb'

describe('projectFilePreviewUrl', () => {
  it('builds a project URL with no query for a plain file', () => {
    expect(projectFilePreviewUrl(PROJECT, '.cio/designs/brand/logo/mark.svg')).toBe(
      `appfile://project/${PROJECT}/.cio/designs/brand/logo/mark.svg`
    )
  })

  it('builds a thread URL when the tree is mounted on a conversation workspace', () => {
    expect(projectFilePreviewUrl(PROJECT, 'artifacts/hero.png', THREAD)).toBe(
      `appfile://thread/${PROJECT}/${THREAD}/artifacts/hero.png`
    )
  })

  it('carries the scope bucket, which is the checkout the file actually lives in', () => {
    expect(
      projectFilePreviewUrl(
        PROJECT,
        '.cio/designs/brand/logo/mark.svg',
        undefined,
        undefined,
        SCOPE
      )
    ).toBe(`appfile://project/${PROJECT}/.cio/designs/brand/logo/mark.svg?scope=${SCOPE}`)
  })

  it('carries the scope and the reload version together', () => {
    expect(projectFilePreviewUrl(PROJECT, 'logo.svg', THREAD, 7, SCOPE)).toBe(
      `appfile://thread/${PROJECT}/${THREAD}/logo.svg?v=7&scope=${SCOPE}`
    )
  })

  it('keeps the version query byte-identical to the pre-scope shape', () => {
    expect(projectFilePreviewUrl(PROJECT, 'preview.png', undefined, 3)).toBe(
      `appfile://project/${PROJECT}/preview.png?v=3`
    )
  })

  it('encodes each path segment and the scope', () => {
    expect(
      projectFilePreviewUrl(PROJECT, 'a folder/logo #1.svg', undefined, undefined, SCOPE)
    ).toBe(`appfile://project/${PROJECT}/a%20folder/logo%20%231.svg?scope=${SCOPE}`)
  })
})
