import { describe, expect, it } from 'vitest'
import {
  TOOL_OUTPUT_PERSIST_CAP,
  capPersistedPart,
  capPersistedParts
} from '../../src/main/chat/bounded-tool-output'
import type { AgentPart } from '../../src/lib/types'

function toolPart(output: string, metadata?: Record<string, unknown>): AgentPart {
  return {
    type: 'tool',
    id: 't1',
    messageID: 'm1',
    callID: 'c1',
    tool: 'read',
    state: { status: 'completed', input: {}, output, ...(metadata ? { metadata } : {}) }
  }
}

describe('bounded tool output policy', () => {
  it('passes sub-cap outputs through by reference', () => {
    const part = toolPart('ok')
    expect(capPersistedPart(part)).toBe(part)
  })

  it('caps an oversized tool output to head + tail + byte count', () => {
    const big = 'x'.repeat(TOOL_OUTPUT_PERSIST_CAP * 4)
    const capped = capPersistedPart(toolPart(big))
    expect(capped.type).toBe('tool')
    if (capped.type !== 'tool') return
    expect(capped.state.output!.length).toBeLessThan(TOOL_OUTPUT_PERSIST_CAP)
    expect(capped.state.output).toContain(`${big.length} bytes total`)
    expect(capped.state.output.startsWith('x')).toBe(true)
  })

  it('caps oversized metadata strings', () => {
    const big = 'y'.repeat(TOOL_OUTPUT_PERSIST_CAP * 2)
    const capped = capPersistedPart(toolPart('ok', { payload: big }))
    expect(capped.type).toBe('tool')
    if (capped.type !== 'tool') return
    const payload = capped.state.metadata?.payload
    expect(typeof payload).toBe('string')
    expect((payload as string).length).toBeLessThan(TOOL_OUTPUT_PERSIST_CAP)
  })

  it('leaves non-tool parts untouched', () => {
    const part: AgentPart = { type: 'text', id: 'a', messageID: 'm', text: 'z'.repeat(500_000) }
    expect(capPersistedPart(part)).toBe(part)
  })

  it('capPersistedParts maps every part', () => {
    const parts = [toolPart('q'.repeat(TOOL_OUTPUT_PERSIST_CAP + 1)), toolPart('small')]
    const capped = capPersistedParts(parts)
    expect(capped).toHaveLength(2)
    if (capped[0].type !== 'tool' || capped[1].type !== 'tool') return
    expect(capped[0].state.output!.length).toBeLessThan(TOOL_OUTPUT_PERSIST_CAP)
    expect(capped[1].state.output).toBe('small')
  })
})
