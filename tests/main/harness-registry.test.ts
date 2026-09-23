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
    // `OpenCodeV2Driver` speaks the v2 `/api/*` surface, so the harness is
    // selectable for chat like every other integrated harness.
    expect(v2?.integration).toBe('ready')
    // Custom base-URL providers are not claimed for the v2 entry: the app has no
    // v2 provider writer, and v2 normalizes the entries the v1 entry manages in
    // the same config file, so nothing a user configured is hidden.
    expect(v2?.supportsCustomProviders).toBe(false)
    expect(findHarness('opencode')?.command).toBe('opencode')
    expect(findHarness('opencode')?.integration).toBe('ready')
  })

  it('declares AGENTS.md loading and manual compaction the driver implements', () => {
    expect(findHarness('opencode2')?.manifest.behaviors['loadsAgentsMd']).toBe(true)
    // `OpenCodeV2Driver.compactSession` drives `POST /api/session/{id}/compact`.
    expect(harnessSupportsManualCompaction('opencode2')).toBe(true)
  })

  it('keeps every harness id unique', () => {
    const ids = listHarnesses().map((harness) => harness.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
