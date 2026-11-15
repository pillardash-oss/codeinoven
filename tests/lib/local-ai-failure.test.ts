import { describe, expect, it } from 'vitest'
import { describeGenerationFailure, generationFailureReason } from '$shared/local-ai-failure'

/**
 * The lines below are copied from the real engines, not invented.
 *
 * The mlx-lm line came from `mlx_lm.server --model LiquidAI/LFM3-Omni-2B-MLX-8bit`
 * on 2026-11-15, which is the case that used to leave the card saying "starting"
 * for hours while `/health` answered 503.
 */
describe('generationFailureReason', () => {
  it('reads the reason out of the engine line that says the model failed', () => {
    const line =
      '2026-11-15 19:00:26,598 - ERROR - mlx_lm.server generation thread died: Model type lfm3_omni not supported.'

    expect(generationFailureReason(line)).toBe('Model type lfm3_omni not supported.')
  })

  it('ignores the ordinary lines a healthy start prints', () => {
    expect(
      generationFailureReason(
        '2026-11-15 19:00:24,741 - INFO - Starting httpd at 127.0.0.1 on port 9123...'
      )
    ).toBeNull()
    expect(
      generationFailureReason('127.0.0.1 - - [15/Nov/2026 18:52:12] "GET /health HTTP/1.1" 503 -')
    ).toBeNull()
    expect(generationFailureReason('Fetching 24 files: 100%|##########| 24/24')).toBeNull()
  })

  it('keeps a failure it has no wording for, rather than dropping it', () => {
    const line = 'mlx_lm.server generation thread died: something the engine did not name'
    expect(generationFailureReason(line)).toBe('something the engine did not name')
  })
})

describe('describeGenerationFailure', () => {
  it('names the unsupported architecture as one this build cannot load', () => {
    const message = describeGenerationFailure('Model type lfm3_omni not supported.')

    expect(message).toContain('Model type lfm3_omni not supported.')
    expect(message).toContain('no architecture for that model')
    expect(message).toContain('llama.cpp')
  })

  it('passes any other failure through untouched', () => {
    expect(describeGenerationFailure('Out of memory.')).toBe('Out of memory.')
  })
})
