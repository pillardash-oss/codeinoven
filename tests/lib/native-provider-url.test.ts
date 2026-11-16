import { describe, expect, it } from 'vitest'
import { harnessBaseUrl } from '$shared/native-provider-url'

/**
 * The paths below were measured against the bundled Pi harness pointed at a
 * logging server, which is what turned the Anthropic 404 into a one-line cause:
 * `anthropic-messages` posts `/v1/messages` relative to its base URL.
 */
describe('harnessBaseUrl', () => {
  it('keeps the stored /v1 URL for the OpenAI-compatible SDK', () => {
    expect(harnessBaseUrl('http://127.0.0.1:9009/v1', '@ai-sdk/openai-compatible')).toBe(
      'http://127.0.0.1:9009/v1'
    )
  })

  it('keeps the stored /v1 URL for the Responses SDK', () => {
    expect(harnessBaseUrl('http://127.0.0.1:9009/v1', '@ai-sdk/openai')).toBe(
      'http://127.0.0.1:9009/v1'
    )
  })

  it('drops the version segment for the Anthropic SDK, which adds its own', () => {
    expect(harnessBaseUrl('http://127.0.0.1:9009/v1', '@ai-sdk/anthropic')).toBe(
      'http://127.0.0.1:9009'
    )
    expect(harnessBaseUrl('https://api.example.com/v1/', '@ai-sdk/anthropic')).toBe(
      'https://api.example.com'
    )
  })

  it('leaves an Anthropic base URL that already has no version segment alone', () => {
    expect(harnessBaseUrl('https://api.anthropic.com', '@ai-sdk/anthropic')).toBe(
      'https://api.anthropic.com'
    )
  })

  it('strips trailing slashes so a joined path never doubles a separator', () => {
    expect(harnessBaseUrl('http://127.0.0.1:9009/v1//', '@ai-sdk/openai-compatible')).toBe(
      'http://127.0.0.1:9009/v1'
    )
  })
})
