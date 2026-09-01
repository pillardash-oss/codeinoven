import { describe, expect, it } from 'vitest'
import {
  PPTX_JS_PREVIEW_ENABLED,
  pptxPreviewMode,
  type PptxPreviewPolicyInput
} from '$lib/chats/pptx-preview-policy'

function policy(overrides: Partial<PptxPreviewPolicyInput> = {}): PptxPreviewPolicyInput {
  return {
    echartsVersion: '6.1.0',
    uuidVersion: '11.1.1',
    rendererIsolated: false,
    ...overrides
  }
}

describe('pptxPreviewMode (SEC-01 presentation containment)', () => {
  it('never enables the interactive renderer without a sanitization boundary', () => {
    expect(pptxPreviewMode(policy())).toBe('disabled')
  })

  it('requires ECharts 6.1.0 or newer for the safe path', () => {
    expect(pptxPreviewMode(policy({ echartsVersion: '6.1.0', rendererIsolated: true }))).toBe(
      'safe'
    )
    expect(pptxPreviewMode(policy({ echartsVersion: '6.2.0', rendererIsolated: true }))).toBe(
      'safe'
    )
    expect(pptxPreviewMode(policy({ echartsVersion: '5.5.0', rendererIsolated: true }))).toBe(
      'disabled'
    )
  })

  it('requires UUID 11.1.1 or newer for the safe path', () => {
    expect(pptxPreviewMode(policy({ uuidVersion: '11.1.1', rendererIsolated: true }))).toBe('safe')
    expect(pptxPreviewMode(policy({ uuidVersion: '11.2.0', rendererIsolated: true }))).toBe('safe')
    expect(pptxPreviewMode(policy({ uuidVersion: '10.0.0', rendererIsolated: true }))).toBe(
      'disabled'
    )
  })

  it('stays disabled when safe versions resolve but the renderer is not isolated', () => {
    expect(pptxPreviewMode(policy({ rendererIsolated: false }))).toBe('disabled')
  })

  it('disables the interactive renderer in the trusted renderer regardless of versions', () => {
    expect(PPTX_JS_PREVIEW_ENABLED).toBe(false)
    expect(pptxPreviewMode(policy({ echartsVersion: '6.1.0', uuidVersion: '11.1.1' }))).toBe(
      'disabled'
    )
  })
})
