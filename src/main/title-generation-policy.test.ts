import { describe, expect, it } from 'vitest'
import { shouldDeferAutoTitleUntilIdle } from './title-generation-policy'

describe('thread title generation scheduling', () => {
  it('defers only Claude Code to avoid its shared OAuth refresh race', () => {
    expect(shouldDeferAutoTitleUntilIdle('claude-code')).toBe(true)
  })

  it.each(['opencode', 'codex', 'cline', 'antigravity', 'pi'])(
    'keeps %s title generation independent from main-turn completion',
    (driverId) => {
      expect(shouldDeferAutoTitleUntilIdle(driverId)).toBe(false)
    }
  )
})
