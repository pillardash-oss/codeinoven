import { describe, expect, it } from 'vitest'
import type { AgentPart } from '../../../src/lib/types'
import {
  latestWorkingTraceParts,
  mergeTurnSubagents,
  shouldMountWorkingTrace,
  type SubagentPart
} from '../../../src/renderer/lib/working-trace-parts'

function toolPart(id: string, status: 'pending' | 'running' | 'completed'): AgentPart {
  return {
    id,
    messageID: `message-${status}`,
    type: 'tool',
    callID: id.replace('claude-tool-', ''),
    tool: 'Read',
    state: { status, input: {} }
  }
}

describe('latestWorkingTraceParts', () => {
  it('collapses repeated Claude tool lifecycle IDs to their latest state', () => {
    const duplicateId = 'claude-tool-toolu_01PFSDDYvveNbbqpHaTWewav'
    const first = toolPart(duplicateId, 'running')
    const unrelated = toolPart('claude-tool-other', 'running')
    const latest = toolPart(duplicateId, 'completed')

    expect(latestWorkingTraceParts([first, unrelated, latest])).toEqual([latest, unrelated])
  })

  it('preserves distinct lifecycle parts in their original order', () => {
    const first = toolPart('claude-tool-first', 'running')
    const second = toolPart('claude-tool-second', 'pending')

    expect(latestWorkingTraceParts([first, second])).toEqual([first, second])
  })
})

describe('shouldMountWorkingTrace', () => {
  it('mounts a live turn even before its first part has streamed in', () => {
    // Regression: a busy thread with zero parts must still show the trace
    // shell (spinner + header), not collapse to a bare "Working..." line.
    expect(shouldMountWorkingTrace(0, true)).toBe(true)
  })

  it('keeps a finished turn with no parts collapsed', () => {
    expect(shouldMountWorkingTrace(0, false)).toBe(false)
  })

  it('keeps a restored turn with parts mounted even once no longer live', () => {
    expect(shouldMountWorkingTrace(3, false)).toBe(true)
  })

  it('keeps a live turn with parts mounted', () => {
    expect(shouldMountWorkingTrace(2, true)).toBe(true)
  })
})

describe('mergeTurnSubagents', () => {
  function subagent(id: string, status: 'pending' | 'running' | 'completed'): SubagentPart {
    return {
      type: 'subagent',
      id,
      messageID: `message-${id}`,
      activity: {
        status,
        agent: 'implementation',
        description: `task ${id}`,
        background: false
      }
    }
  }

  it('reports a delegated worker the mounted page never held', () => {
    // Regression: the header read sub-agents from the mounted window, so a long
    // turn whose delegation sat on an older page showed no sub-agent at all.
    const merged = mergeTurnSubagents([subagent('worker', 'running')], [])
    expect(merged.map((part) => part.id)).toEqual(['worker'])
  })

  it('keeps the fold order and appends workers only the stream has shown', () => {
    const merged = mergeTurnSubagents(
      [subagent('first', 'running'), subagent('second', 'running')],
      [subagent('third', 'pending')]
    )
    expect(merged.map((part) => part.id)).toEqual(['first', 'second', 'third'])
  })

  it('takes the mounted snapshot when the live stream has advanced it', () => {
    const merged = mergeTurnSubagents(
      [subagent('worker', 'running')],
      [subagent('worker', 'completed')]
    )
    expect(merged.map((part) => part.activity.status)).toEqual(['completed'])
  })

  it('never takes a stale running snapshot back over a settled worker', () => {
    const merged = mergeTurnSubagents(
      [subagent('worker', 'completed')],
      [subagent('worker', 'running')]
    )
    expect(merged.map((part) => part.activity.status)).toEqual(['completed'])
  })
})
