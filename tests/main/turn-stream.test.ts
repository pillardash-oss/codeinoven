import { describe, expect, it } from 'vitest'
import { foldTurnStreamEvents, type TurnStreamEvent } from '../../src/main/chat/turn-stream'
import { pageTurnStreamParts } from '../../src/main/chat/turn-stream-page'
import {
  readTurnStreamLog,
  readTurnStreamTail,
  type TurnStreamChunkSource
} from '../../src/main/chat/turn-stream-log'
import type { AgentPart } from '../../src/lib/types'

function reasoning(id: string, text: string): AgentPart {
  return { type: 'reasoning', id, messageID: `m-${id}`, text }
}

function tool(id: string): AgentPart {
  return {
    type: 'tool',
    id,
    messageID: `m-${id}`,
    callID: `c-${id}`,
    tool: 'read',
    state: { status: 'completed', input: {}, output: 'ok' }
  }
}

function ev(
  partial: Partial<TurnStreamEvent> & { kind: 'part.updated' | 'part.delta' }
): TurnStreamEvent {
  return {
    sessionId: 's',
    messageId: 'm',
    turnId: 'turn-1',
    ts: 1,
    ...(partial.kind === 'part.updated'
      ? { kind: 'part.updated', part: partial.part! }
      : {
          kind: 'part.delta',
          partId: partial.partId!,
          field: partial.field ?? 'text',
          delta: partial.delta ?? ''
        })
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

describe('pageTurnStreamParts', () => {
  function todoPart(id: string): AgentPart {
    return {
      type: 'tool',
      id,
      messageID: `m-${id}`,
      callID: `c-${id}`,
      tool: 'cio_todo_write',
      state: { status: 'completed', input: { todos: [{ content: 'Task', status: 'pending' }] } }
    }
  }

  const events: TurnStreamEvent[] = [
    ev({ kind: 'part.updated', part: reasoning('a', 'work') }),
    ev({ kind: 'part.updated', part: todoPart('todo') })
  ]

  it('carries the fold boundary so the card can reject a stale snapshot', () => {
    const folded = foldTurnStreamEvents(events)

    const windowPage = pageTurnStreamParts(folded, events, { limit: 10 }, 1790)
    expect(windowPage.kind === 'window' && windowPage.turnStartTs).toBe(1790)

    const changePage = pageTurnStreamParts(folded, events, { changedSince: 0 }, 1790)
    expect(changePage.kind === 'change' && changePage.turnStartTs).toBe(1790)
  })

  it('reports no boundary on a thread with no prompt yet', () => {
    const page = pageTurnStreamParts([], [], { limit: 10 })
    expect(page.kind === 'window' && page.turnStartTs).toBeNull()
  })
})

describe('durable log readers', () => {
  function at(ts: number, turnId: string, part: AgentPart): TurnStreamEvent {
    return { kind: 'part.updated', sessionId: 's', messageId: `m-${part.id}`, turnId, ts, part }
  }

  function delta(ts: number, turnId: string, partId: string, text: string): TurnStreamEvent {
    return {
      kind: 'part.delta',
      sessionId: 's',
      messageId: `m-${partId}`,
      partId,
      field: 'text',
      delta: text,
      turnId,
      ts
    }
  }

  function logSource(lines: readonly string[]): {
    source: TurnStreamChunkSource
    bytesRead: () => number
    size: number
  } {
    const bytes = Buffer.from(lines.join(''), 'utf8')
    let read = 0
    return {
      size: bytes.length,
      bytesRead: () => read,
      source: {
        async readChunk(fromByte: number, length: number) {
          const slice = bytes.subarray(fromByte, Math.min(bytes.length, fromByte + length))
          read += slice.length
          return { buffer: slice, nextByte: fromByte + slice.length }
        }
      }
    }
  }

  function serialize(events: readonly TurnStreamEvent[]): string[] {
    return events.map((event) => `${JSON.stringify(event)}\n`)
  }

  it('rebuilds the newest turn backwards with the same events the forward walk keeps', async () => {
    const preTurn = [
      at(10, 'turn-1', reasoning('a', 'seed')),
      at(11, 'turn-1', reasoning('untouched', 'older'))
    ]
    const turn = [
      at(105, 'turn-2', tool('b')),
      delta(106, 'turn-2', 'b', ''),
      delta(110, 'turn-2', 'a', ' continued')
    ]
    const forward = logSource(serialize([...preTurn, ...turn]))
    const backwards = logSource(serialize([...preTurn, ...turn]))

    const expected = await readTurnStreamLog(forward.source, 0, forward.size, 100)
    const actual = await readTurnStreamTail(backwards.source, backwards.size, 100)

    expect(actual.events).toEqual(expected.events)
    expect(actual.latestTurnId).toBe(expected.latestTurnId)
    expect(actual.nextByte).toBe(backwards.size)
  })

  it('reads only the newest turn instead of the whole log', async () => {
    const bulk: string[] = []
    for (let index = 0; index < 6000; index += 1) {
      bulk.push(
        ...serialize([at(10 + index, 'turn-1', reasoning(`old-${index}`, 'x'.repeat(300)))])
      )
    }
    const turn = serialize([at(900_000, 'turn-2', reasoning('live', 'working'))])
    const log = logSource([...bulk, ...turn])

    const read = await readTurnStreamTail(log.source, log.size, 800_000)
    const newest = read.events[0]

    expect(read.events).toHaveLength(1)
    expect(
      newest?.kind === 'part.updated' && newest.part.type === 'reasoning' && newest.part.text
    ).toBe('working')
    expect(log.size).toBeGreaterThan(2_000_000)
    expect(log.bytesRead()).toBeLessThan(700_000)
  })

  it('finds the baseline a continued part needs before the boundary', async () => {
    const log = logSource(
      serialize([
        at(10, 'turn-2', reasoning('a', 'accumulated')),
        at(105, 'turn-2', tool('b')),
        delta(110, 'turn-2', 'a', ' text')
      ])
    )

    const read = await readTurnStreamTail(log.source, log.size, 100)
    const folded = foldTurnStreamEvents(read.events, read.latestTurnId, 100)

    // The fold seeds a continued part before the window's own entries, exactly
    // as the forward walk does; what matters is that its text is complete.
    expect(folded.map((part) => part.id).sort()).toEqual(['a', 'b'])
    const continued = folded.find((part) => part.id === 'a')
    expect(continued?.type === 'reasoning' && continued.text).toBe('accumulated text')
  })

  it('returns nothing for an empty log', async () => {
    const log = logSource([])
    const read = await readTurnStreamTail(log.source, log.size, 100)
    expect(read.events).toEqual([])
    expect(read.nextByte).toBe(0)
  })
})
