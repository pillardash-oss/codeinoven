import { describe, expect, it } from 'vitest'
import {
  OPENCODE_COMMAND_CANDIDATES,
  isOpenCodeV2Version,
  parseOpenCodeMajor
} from '../../src/lib/opencode-version'
import {
  compareVersions,
  parseMajorVersion,
  selectNewestCandidate
} from '../../src/lib/version-compare'

describe('opencode version identity', () => {
  it('parses a major out of either version line shape', () => {
    expect(parseOpenCodeMajor('1.18.32')).toBe(1)
    expect(parseOpenCodeMajor('opencode v2.0.14')).toBe(2)
    expect(parseOpenCodeMajor('')).toBeNaN()
  })

  it('treats major >= 2 as v2 and anything else as not-v2', () => {
    expect(isOpenCodeV2Version('2.0.14')).toBe(true)
    expect(isOpenCodeV2Version('v2.0.14')).toBe(true)
    expect(isOpenCodeV2Version('1.18.32')).toBe(false)
    expect(isOpenCodeV2Version('unknown')).toBe(false)
  })

  it('probes the canonical command before its v2 alias', () => {
    expect(OPENCODE_COMMAND_CANDIDATES).toEqual(['opencode', 'opencode2'])
  })
})

describe('version comparison', () => {
  it('compares three-part versions numerically', () => {
    expect(compareVersions('2.0.14', '1.18.32')).toBeGreaterThan(0)
    expect(compareVersions('1.18.32', '1.18.4')).toBeGreaterThan(0)
    expect(compareVersions('1.18.32', '1.18.32')).toBe(0)
  })

  it('selects the newest candidate and keeps the earliest on a tie', () => {
    expect(
      selectNewestCandidate([
        { version: '1.18.32', value: 'opencode' },
        { version: '2.0.14', value: 'opencode2' }
      ])?.value
    ).toBe('opencode2')
    // A tie must keep the canonical command, which callers order first.
    expect(
      selectNewestCandidate([
        { version: '2.0.14', value: 'opencode' },
        { version: '2.0.14', value: 'opencode2' }
      ])?.value
    ).toBe('opencode')
    expect(selectNewestCandidate([])).toBeNull()
  })

  it('parses a major out of a version-ish string', () => {
    expect(parseMajorVersion('v2.0.14')).toBe(2)
    expect(parseMajorVersion('1.18.32')).toBe(1)
  })
})
