import { describe, expect, it } from 'vitest'
import {
  findHarness,
  harnessSupportsManualCompaction,
  harnessSupportsMultipleAccounts,
  listHarnesses
} from '../../src/main/agents/harness-registry'
import { OPENCODE_COMMAND_ALIASES } from '../../src/lib/opencode-version'

describe('harness registry opencode entry', () => {
  it('registers ONE opencode harness carrying its v2 alias, not two entries', () => {
    const opencode = findHarness('opencode')
    expect(opencode).toBeDefined()
    expect(opencode?.name).toBe('OpenCode')
    expect(opencode?.command).toBe('opencode')
    // A package-managed V2 install also drops `opencode2` on PATH; it is an
    // alternate name for the same harness, so the app probes both and keeps the
    // newest version instead of asking the user to choose.
    expect(opencode?.commandAliases).toEqual(OPENCODE_COMMAND_ALIASES)
    expect(opencode?.versionArgs).toEqual(['--version'])
    expect(opencode?.integration).toBe('ready')
    // One entry drives both lines, so custom base-URL providers are claimed for
    // whichever version is installed.
    expect(opencode?.supportsCustomProviders).toBe(true)
    // The v2 line is a version of the same harness, never a separate entry.
    expect(findHarness('opencode2')).toBeUndefined()
  })

  it('declares AGENTS.md loading and manual compaction the drivers implement', () => {
    expect(findHarness('opencode')?.manifest.behaviors['loadsAgentsMd']).toBe(true)
    // V1 drives its session command; V2 `POST /api/session/{id}/compact`.
    expect(harnessSupportsManualCompaction('opencode')).toBe(true)
  })

  it('declares native multi-account only where the harness store supports it', () => {
    // V2 keeps several credentials per integration and switches the active one
    // (`opencode auth switch`); every other harness gets its multiple accounts
    // from CodeInOven's per-account containers instead.
    expect(harnessSupportsMultipleAccounts('opencode')).toBe(true)
    expect(findHarness('opencode')?.manifest.behaviors['multipleAccounts']).toBe(true)
    for (const harness of listHarnesses()) {
      if (harness.id === 'opencode') continue
      expect(harness.manifest.behaviors['multipleAccounts']).toBe(false)
    }
    expect(harnessSupportsMultipleAccounts('not-a-harness')).toBe(false)
  })

  it('keeps every harness id unique', () => {
    const ids = listHarnesses().map((harness) => harness.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
