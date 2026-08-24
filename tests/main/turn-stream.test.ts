import { describe, expect, it } from 'vitest'
import { foldTurnStreamEvents, type TurnStreamEvent } from '../../src/main/chat/turn-stream'
import type { AgentPart } from '../../src/lib/types'

function reasoning(id: string, text: string): AgentPart {
  return { type: 'reasoning', id, messageID: `m-${id}`, text }
}

function tool(id: string): AgentPart {
  return {
    type: 'tool',
    id,
    messageID: `m-${id}`,
    tool: 'read',
    state: { status: 'completed', input: {}, output: 'ok' }
  }
}

function ev(partial: Partial<TurnStreamEvent> & { kind: 'part.updated' | 'part.delta' }): TurnStreamEvent {
  return {
    sessionId: 's',
    messageId: 'm',
    turnId: 'turn-1',
    ts: 1,
    ...(partial.kind === 'part.updated'
      ? { kind: 'part.updated', part: partial.part! }
      : { kind: 'part.delta', partId: partial.partId!, field: partial.field ?? 'text', delta: partial.delta ?? '' })
  } as TurnStreamEvent
}

describe('foldTurnStreamEvents', () => {
  it('reassembles ordered latest-state parts from snapshots', () => {
    const events: TurnStreamEvent[] = [
      ev({ kind: 'part.updated', part: reasoning('a', 'hello') }),
      ev({ kind: 'part.updated', part: tool('b') }),
      ev({ kind: 'part.updated', part: reasoning('a', 'hello world') })
    ]
    const folded = foldTurnStreamEvents(events)
    expect(folded.map((p) => p.id)).toEqual(['a', 'b'])
    expect(folded[0].type === 'reasoning' && folded[0].text).toBe('hello world')
  })

  it('appends deltas onto the established text baseline', () => {
    const events: TurnStreamEvent[] = [
      ev({ kind: 'part.updated', part: reasoning('a', 'hello') }),
      ev({ kind: 'part.delta', partId: 'a', delta: ' world' }),
      ev({ kind: 'part.delta', partId: 'a', delta: '!' })
    ]
    const folded = foldTurnStreamEvents(events)
    expect(folded[0].type === 'reasoning' && folded[0].text).toBe('hello world!')
  })

  it('does not double-append text after a fuller snapshot replaces it', () => {
    const events: TurnStreamEvent[] = [
      ev({ kind: 'part.updated', part: reasoning('a', 'hello') }),
      ev({ kind: 'part.delta', partId: 'a', delta: ' world' }),
      ev({ kind: 'part.updated', part: reasoning('a', 'hello world') }),
      ev({ kind: 'part.delta', partId: 'a', delta: '!' })
    ]
    const folded = foldTurnStreamEvents(events)
    expect(folded[0].type === 'reasoning' && folded[0].text).toBe('hello world!')
  })

  it('keeps the first-seen order when a part is updated in place', () => {
    const events: TurnStreamEvent[] = [
      ev({ kind: 'part.updated', part: tool('x') }),
      ev({ kind: 'part.updated', part: reasoning('y', 'r') }),
      ev({ kind: 'part.updated', part: tool('x') })
    ]
    expect(foldTurnStreamEvents(events).map((p) => p.id)).toEqual(['x', 'y'])
  })

  it('folds only the requested logical turn when turnId is provided', () => {
    const events: TurnStreamEvent[] = [
      ev({ kind: 'part.updated', part: reasoning('old', 'stale') }),
      { ...ev({ kind: 'part.updated', part: reasoning('new', 'fresh') }), turnId: 'turn-2' }
    ]
    const folded = foldTurnStreamEvents(events, 'turn-2')
    expect(folded.map((p) => p.id)).toEqual(['new'])
    expect(folded[0].type === 'reasoning' && folded[0].text).toBe('fresh')
  })
})
