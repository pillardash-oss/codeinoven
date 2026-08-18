import { describe, expect, it } from 'vitest'
import type { AgentPart } from '../../../src/lib/types'
import { latestWorkingTraceParts } from '../../../src/renderer/lib/working-trace-parts'

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
