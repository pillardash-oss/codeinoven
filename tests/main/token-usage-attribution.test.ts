import { describe, expect, it } from 'vitest'
import {
  TokenUsageAttributionRecorder,
  attributionEnabled,
  attributionLayer,
  episodeFromPieces
} from '../../src/main/chat/token-usage-attribution'

/**
 * Dev-only attribution contract: episodes carry ONLY normalized hashes,
 * character counts, and heuristic token estimates — never prompt content.
 */
describe('token-usage attribution', () => {
  it('produces content-free layer reports (hashes/characters/estimates only)', () => {
    const layer = attributionLayer('Harness', 'This is a secret project plan body.')
    expect(layer.title).toBe('Harness')
    expect(layer.characters).toBeGreaterThan(0)
    expect(layer.estimatedTokens).toBe(Math.ceil(layer.characters / 4))
    expect(layer.devHash).toMatch(/^[0-9a-f]{64}$/u)
    // Content must never leak into the episode.
    const serialized = JSON.stringify(layer)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('project plan')
  })

  it('builds episodes from named pieces and omits empty pieces', () => {
    const episode = episodeFromPieces({
      key: 'turn-1',
      mode: 'inbox-chat',
      driverId: 'opencode',
      pieces: [
        { title: 'System', content: 'You are a web chat assistant.' },
        { title: 'Empty', content: '   ' },
        { title: 'User', content: 'hello' }
      ]
    })
    expect(episode.mode).toBe('inbox-chat')
    expect(episode.driverId).toBe('opencode')
    expect(episode.layers.map((layer) => layer.title)).toEqual(['System', 'User'])
    expect(episode.totalCharacters).toBeGreaterThan(0)
    expect(episode.totalEstimatedTokens).toBe(
      episode.layers.reduce((sum, layer) => sum + layer.estimatedTokens, 0)
    )
    // No full-content string escapes the episode.
    expect(JSON.stringify(episode)).not.toContain('web chat assistant')
  })

  it('pairs a prompt episode with provider-reported totals and removes it from pending', () => {
    const recorder = new TokenUsageAttributionRecorder(true)
    recorder.recordPromptAttribution(
      episodeFromPieces({
        key: 'turn-1',
        mode: 'file-system-chat',
        driverId: 'opencode',
        pieces: [{ title: 'System', content: 'Read files and answer.' }]
      })
    )
    expect(recorder.pendingCount()).toBe(1)
    recorder.recordTurnTotals({
      key: 'turn-1',
      agent: null,
      driverId: 'opencode',
      harnessVersion: '1.18.15',
      providerId: 'opencode',
      modelId: 'deepseek-v4-flash',
      reportedInputTokens: 2_400,
      reportedTotalTokens: 2_500
    })
    expect(recorder.pendingCount()).toBe(0)
  })

  it('records totals even when no pending episode was captured (no throw)', () => {
    const recorder = new TokenUsageAttributionRecorder(true)
    expect(() =>
      recorder.recordTurnTotals({
        key: 'turn-missing',
        agent: null,
        driverId: 'opencode',
        harnessVersion: null,
        providerId: null,
        modelId: null,
        reportedInputTokens: 1_000,
        reportedTotalTokens: null
      })
    ).not.toThrow()
  })

  it('is inert when disabled', () => {
    const recorder = new TokenUsageAttributionRecorder(false)
    recorder.recordPromptAttribution(
      episodeFromPieces({
        key: 'turn-1',
        mode: 'inbox-chat',
        driverId: 'opencode',
        pieces: [{ title: 'System', content: 'Content.' }]
      })
    )
    recorder.recordTurnTotals({
      key: 'turn-1',
      agent: null,
      driverId: 'opencode',
      harnessVersion: null,
      providerId: null,
      modelId: null,
      reportedInputTokens: null,
      reportedTotalTokens: null
    })
    expect(recorder.pendingCount()).toBe(0)
  })

  it('is inert in production regardless of any override (no CIO_FORCE_ATTRIBUTION escape)', () => {
    const previous = process.env['NODE_ENV']
    const previousForce = process.env['CIO_FORCE_ATTRIBUTION']
    try {
      process.env['NODE_ENV'] = 'production'
      process.env['CIO_FORCE_ATTRIBUTION'] = '1'
      expect(attributionEnabled()).toBe(false)
      const recorder = new TokenUsageAttributionRecorder(attributionEnabled())
      recorder.recordPromptAttribution(
        episodeFromPieces({
          key: 'prod-turn',
          mode: 'inbox-chat',
          driverId: 'opencode',
          pieces: [{ title: 'System', content: 'Must never be recorded.' }]
        })
      )
      recorder.recordTurnTotals({
        key: 'prod-turn',
        agent: null,
        driverId: 'opencode',
        harnessVersion: null,
        providerId: null,
        modelId: null,
        reportedInputTokens: null,
        reportedTotalTokens: null
      })
      expect(recorder.pendingCount()).toBe(0)
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = previous
      if (previousForce === undefined) delete process.env['CIO_FORCE_ATTRIBUTION']
      else process.env['CIO_FORCE_ATTRIBUTION'] = previousForce
    }
  })
})
