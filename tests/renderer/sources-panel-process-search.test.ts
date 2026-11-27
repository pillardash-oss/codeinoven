import { describe, expect, it } from 'vitest'
import {
  processMatchesSearch,
  processSearchTokens
} from '../../src/renderer/lib/components/threads/sources-panel-helpers'
import type { AgentRunningProcess } from '../../src/lib/types/agent-parts'

/**
 * The processes tab can be searched by executable, pid, port, command line and
 * working directory, and every query token has to match somewhere in the row.
 */

function runningProcess(overrides: Partial<AgentRunningProcess> = {}): AgentRunningProcess {
  return {
    pid: 4821,
    parentPid: 1,
    command: '/Users/me/project/node_modules/.bin/vite --port 5173',
    startedAt: 1_700_000_000_000,
    scope: 'thread',
    cwd: '/Users/me/project/apps/website',
    ports: [5173],
    ...overrides
  }
}

function matches(process: AgentRunningProcess, query: string): boolean {
  return processMatchesSearch(process, processSearchTokens(query))
}

describe('running process search', () => {
  it('finds a row by executable name', () => {
    expect(matches(runningProcess(), 'vite')).toBe(true)
  })

  it('finds a row by pid', () => {
    expect(matches(runningProcess(), '4821')).toBe(true)
    expect(matches(runningProcess(), '9999')).toBe(false)
  })

  it('finds a row by listening port', () => {
    expect(matches(runningProcess(), '5173')).toBe(true)
    expect(matches(runningProcess({ ports: [] }), '5173')).toBe(true)
    expect(matches(runningProcess({ ports: [] }), '8080')).toBe(false)
  })

  it('finds a row by working directory', () => {
    expect(matches(runningProcess(), 'apps/website')).toBe(true)
  })

  it('requires every token to match, in any order', () => {
    expect(matches(runningProcess(), 'vite 5173')).toBe(true)
    expect(matches(runningProcess(), '5173 vite')).toBe(true)
    expect(matches(runningProcess(), 'vite 8080')).toBe(false)
  })

  it('keeps every row when the query is blank', () => {
    expect(matches(runningProcess(), '')).toBe(true)
    expect(processSearchTokens('   ')).toEqual([])
  })

  it('is case and whitespace insensitive', () => {
    expect(matches(runningProcess(), '  VITE   Website  ')).toBe(true)
  })

  it('tolerates a row the tracker has no ports or cwd for', () => {
    const process = runningProcess({ ports: undefined, cwd: null })
    expect(matches(process, 'vite')).toBe(true)
    expect(matches(process, '5173')).toBe(true)
  })
})
