import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_MAX_SOURCE_CHARS,
  artifactKindForLang,
  artifactNeedsCodeFallback
} from '../../../src/renderer/lib/components/markdown/artifact'

describe('artifactKindForLang', () => {
  it('recognizes the artifact fence languages', () => {
    expect(artifactKindForLang('artifact-html')).toBe('html')
    expect(artifactKindForLang('artifact-svg')).toBe('svg')
  })

  it('leaves plain html, svg and mermaid fences as code', () => {
    expect(artifactKindForLang('html')).toBeNull()
    expect(artifactKindForLang('svg')).toBeNull()
    expect(artifactKindForLang('mermaid')).toBeNull()
    expect(artifactKindForLang(undefined)).toBeNull()
    expect(artifactKindForLang('')).toBeNull()
  })
})

describe('artifactNeedsCodeFallback', () => {
  it('falls back on empty sources and oversized sources', () => {
    expect(artifactNeedsCodeFallback('')).toBe(true)
    expect(artifactNeedsCodeFallback('   \n  ')).toBe(true)
    expect(artifactNeedsCodeFallback('x'.repeat(ARTIFACT_MAX_SOURCE_CHARS + 1))).toBe(true)
  })

  it('previews normal sources', () => {
    expect(artifactNeedsCodeFallback('<p>hello</p>')).toBe(false)
    expect(artifactNeedsCodeFallback('x'.repeat(ARTIFACT_MAX_SOURCE_CHARS))).toBe(false)
  })
})
