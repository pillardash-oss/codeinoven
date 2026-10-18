import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_MAX_SOURCE_CHARS,
  artifactKindForLang,
  artifactNeedsCodeFallback,
  artifactPictureFrameStyle,
  svgArtifactIntrinsicRatio
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

describe('svgArtifactIntrinsicRatio', () => {
  it('takes the shape the viewBox states, whatever the root is sized at', () => {
    expect(svgArtifactIntrinsicRatio('<svg viewBox="0 0 1600 900"></svg>')).toBeCloseTo(1.7778, 4)
    expect(svgArtifactIntrinsicRatio('<svg width="100%" viewBox="0 0 24 24"/>')).toBe(1)
    expect(svgArtifactIntrinsicRatio('<svg viewBox="0,0,100,50"/>')).toBe(2)
  })

  it('falls back to plain width and height attributes', () => {
    expect(svgArtifactIntrinsicRatio('<svg width="1200" height="600"></svg>')).toBe(2)
    expect(svgArtifactIntrinsicRatio("<svg width='1200px' height='600px'></svg>")).toBe(2)
  })

  it('answers nothing for a source that states no shape', () => {
    expect(svgArtifactIntrinsicRatio('<svg width="100%" height="100%"></svg>')).toBeNull()
    expect(svgArtifactIntrinsicRatio('<svg width="1200"></svg>')).toBeNull()
    expect(svgArtifactIntrinsicRatio('<svg viewBox="0 0 0 0"></svg>')).toBeNull()
    expect(svgArtifactIntrinsicRatio('<p>not an svg</p>')).toBeNull()
    expect(svgArtifactIntrinsicRatio('')).toBeNull()
  })

  it('reads the root element rather than a lookalike in front of it', () => {
    expect(
      svgArtifactIntrinsicRatio(
        '<!-- <svg viewBox="0 0 1 1"> --><svg stroke-width="4" viewBox="0 0 800 400"/>'
      )
    ).toBe(2)
    expect(svgArtifactIntrinsicRatio('<svg stroke-width="4"></svg>')).toBeNull()
  })
})

describe('artifactPictureFrameStyle', () => {
  it('boxes a picture in its own shape, within the column and the ceiling', () => {
    const style = artifactPictureFrameStyle(2)
    expect(style).toContain('aspect-ratio:2')
    expect(style).toContain('max-height:24rem')
    expect(style).toContain('max-width:min(100%,calc(24rem * 2))')
  })
})
