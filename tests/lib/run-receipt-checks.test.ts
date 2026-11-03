import { describe, expect, it } from 'vitest'
import {
  readRunChecks,
  toolCallsFromParts,
  type RunChecksReader
} from '../../src/main/chat/run-receipt/run-receipt-checks'
import type { AgentPart } from '../../src/lib/types'

/**
 * Checks come from the run's own tool calls and nowhere else.
 *
 * These cases drive the real reader over persisted-shape parts JSON: a passing
 * command, a failing one, one with more output than the tail keeps, and one that
 * never reached a terminal state. A run whose turns were prose produces nothing,
 * which is the property that stops the receipt from reporting tests that never
 * ran.
 */

function toolPart(overrides: {
  tool?: string
  status?: 'pending' | 'running' | 'completed' | 'error' | 'aborted'
  input?: Record<string, unknown>
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}): AgentPart {
  return {
    type: 'tool',
    id: 'part1',
    messageID: 'message1',
    callID: 'call1',
    tool: overrides.tool ?? 'bash',
    state: {
      status: overrides.status ?? 'completed',
      input: overrides.input ?? { command: 'bun run test' },
      ...(overrides.output === undefined ? {} : { output: overrides.output }),
      ...(overrides.error === undefined ? {} : { error: overrides.error }),
      ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata })
    }
  }
}

function partsJson(parts: AgentPart[]): string {
  return JSON.stringify(parts)
}

function reader(rows: string[]): RunChecksReader {
  return { listToolMessageParts: async () => rows }
}

describe('toolCallsFromParts', () => {
  it('finds the tool parts in a message and ignores the rest', () => {
    const calls = toolCallsFromParts(
      partsJson([{ type: 'text', id: 't', messageID: 'm', text: 'I ran the tests.' }, toolPart({})])
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.tool).toBe('bash')
  })

  it('returns nothing for a row it cannot parse instead of guessing', () => {
    expect(toolCallsFromParts('not json')).toEqual([])
    expect(toolCallsFromParts('{"type":"tool"}')).toEqual([])
  })
})

describe('readRunChecks', () => {
  it('carries the real status of a passing and a failing command', async () => {
    const rows = [
      partsJson([toolPart({ input: { command: 'bun run lint' }, output: 'clean' })]),
      partsJson([
        toolPart({
          input: { command: 'bun run test' },
          status: 'error',
          error: '1 failing test',
          metadata: { exitCode: 1 }
        })
      ])
    ]
    const { checks, truncated } = await readRunChecks(reader(rows), 'thread1')
    expect(truncated).toBe(false)
    expect(checks).toHaveLength(2)
    expect(checks[0]).toMatchObject({ command: 'bun run lint', outcome: 'passed', tail: 'clean' })
    expect(checks[1]).toMatchObject({
      command: 'bun run test',
      outcome: 'failed',
      exitCode: 1,
      tail: '1 failing test'
    })
  })

  it('bounds a long output to a tail that names its cut', async () => {
    const long = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')
    const { checks } = await readRunChecks(
      reader([partsJson([toolPart({ output: long })])]),
      'thread1',
      { commits: 1, files: 1, checks: 5, checkTail: 40 }
    )
    const tail = checks[0]?.tail ?? ''
    expect(tail.startsWith('… ')).toBe(true)
    expect(tail.length).toBeLessThan(60)
    expect(tail).toContain('line 199')
  })

  it('yields no checks at all for a prose-only run', async () => {
    const { checks } = await readRunChecks(
      reader([partsJson([{ type: 'text', id: 't', messageID: 'm', text: 'I fixed it.' }])]),
      'thread1'
    )
    expect(checks).toEqual([])
  })

  it('skips a command that is still running', async () => {
    const { checks } = await readRunChecks(
      reader([partsJson([toolPart({ status: 'running' })])]),
      'thread1'
    )
    expect(checks).toEqual([])
  })
})
