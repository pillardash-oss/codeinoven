import { describe, expect, it } from 'vitest'
import {
  findHarness,
  harnessSupportsManualCompaction,
  listHarnesses
} from '../../src/main/agents/harness-registry'

describe('harness registry opencode v2 entry', () => {
  it('registers OpenCode V2 on its own binary, distinct from the v1 entry', () => {
    const v2 = findHarness('opencode2')
    expect(v2).toBeDefined()
    expect(v2?.name).toBe('OpenCode V2')
    expect(v2?.command).toBe('opencode2')
    expect(v2?.versionArgs).toEqual(['--version'])
    // No v2 chat driver exists yet, so the harness is detected and inspectable
    // but not selectable for chat.
    expect(v2?.integration).toBe('planned')
    expect(findHarness('opencode')?.command).toBe('opencode')
    expect(findHarness('opencode')?.integration).toBe('ready')
  })

  it('declares AGENTS.md loading but not manual compaction until a driver exists', () => {
    expect(findHarness('opencode2')?.manifest.behaviors['loadsAgentsMd']).toBe(true)
    expect(harnessSupportsManualCompaction('opencode2')).toBe(false)
  })

  it('keeps every harness id unique', () => {
    const ids = listHarnesses().map((harness) => harness.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
