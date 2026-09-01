import { describe, expect, it } from 'vitest'
import { mapMuseRecord } from '../../../src/main/drivers/muse-driver'
import type { CliLineParseContext } from '../../../src/main/drivers/persistent-cli-driver'
import type { MuseTurnState } from '../../../src/main/drivers/muse-driver'

function makeState(): MuseTurnState {
  return {
    turnIndex: 0,
    parts: [],
    tools: new Map(),
    toolByCall: new Map(),
    promotedInteractions: new Set(),
    emittedPermissionTasks: new Set(),
    gatedTaskIds: new Set(),
    expectsProcessStop: false,
    messageId: 'muse:test:1',
    createdAt: 0,
    started: false,
    reasoning: '',
    text: ''
  } as unknown as MuseTurnState
}

const ctx: CliLineParseContext = {
  session: {},
  sessionId: 's1',
  projectPath: '/tmp'
} as unknown as CliLineParseContext

function lifecycle(taskId: string, kind: string, extra: Record<string, unknown> = {}) {
  return {
    payload_type: `task.lifecycle.${kind}`,
    payload: { task_id: taskId, event: { kind, task_id: taskId, ...extra } }
  }
}

function toolPart(state: MuseTurnState) {
  const part = state.parts.find((candidate) => candidate.type === 'tool')
  return part?.type === 'tool' ? part : undefined
}

describe('muse driver tool-card lifecycle', () => {
  it('completes a bash tool card with command and output from the wire stream', () => {
    const state = makeState()
    // Exact record sequence observed from `muse exec --json` (Muse 1.0.1).
    const records = [
      lifecycle('t1', 'proposed', { task_kind: 'tool.bash' }),
      lifecycle('t1', 'accepted'),
      lifecycle('t1', 'scheduled', { idempotency_key: 'tool:call_1' }),
      lifecycle('t1', 'side_effect_intent', {
        idempotency_key: 'tool:call_1',
        policy_decision: 'allow:policy'
      }),
      lifecycle('t1', 'started'),
      lifecycle('t1', 'output', {
        chunk: JSON.stringify({ command: 'echo hi', description: 'Run echo hi', output: 'hi\n' })
      }),
      lifecycle('t1', 'completed'),
      {
        payload_type: 'tool.result',
        payload: {
          call_id: 'call_1',
          text: JSON.stringify({ command: 'echo hi', exit_code: 0, output: 'hi\n' }),
          correlation_facts: { tool_name: 'bash', outcome: 'success' }
        }
      }
    ]
    for (const rec of records) mapMuseRecord(rec, ctx, state)
    const part = toolPart(state)
    expect(part).toBeDefined()
    if (!part) return
    expect(part.state.status).toBe('completed')
    expect(part.state.input).toEqual({ command: 'echo hi' })
    // The JSON result envelope must be unwrapped to the plain command output.
    expect(part.state.output).toBe('hi\n')
    expect(part.state.time?.end).toBeGreaterThan(0)
    // The part id must be anchored to the per-turn message id so cards do not
    // collide across turns (the CLI restarts its task-id counter per run).
    expect(part.id).toContain('muse:test:1')
  })

  it('completes the card on task.lifecycle.completed when tool.result never arrives', () => {
    const state = makeState()
    const records = [
      lifecycle('t2', 'proposed', { task_kind: 'tool.read_skill' }),
      lifecycle('t2', 'output', { chunk: 'skill body' }),
      lifecycle('t2', 'completed')
    ]
    for (const rec of records) mapMuseRecord(rec, ctx, state)
    const part = toolPart(state)
    expect(part).toBeDefined()
    if (!part) return
    expect(part.state.status).toBe('completed')
    expect(part.state.output).toBe('skill body')
  })

  it('does not regress a completed card when a later completed record arrives', () => {
    const state = makeState()
    mapMuseRecord(lifecycle('t3', 'proposed', { task_kind: 'tool.bash' }), ctx, state)
    mapMuseRecord(lifecycle('t3', 'scheduled', { idempotency_key: 'tool:call_3' }), ctx, state)
    mapMuseRecord(
      {
        payload_type: 'tool.result',
        payload: {
          call_id: 'call_3',
          text: 'done',
          correlation_facts: { tool_name: 'bash', outcome: 'success' }
        }
      },
      ctx,
      state
    )
    const before = toolPart(state)
    mapMuseRecord(lifecycle('t3', 'completed'), ctx, state)
    const after = toolPart(state)
    expect(before).toBe(after)
  })

  it('marks failed tools as error from the tool.result outcome', () => {
    const state = makeState()
    mapMuseRecord(lifecycle('t4', 'proposed', { task_kind: 'tool.bash' }), ctx, state)
    mapMuseRecord(lifecycle('t4', 'scheduled', { idempotency_key: 'tool:call_4' }), ctx, state)
    mapMuseRecord(
      {
        payload_type: 'tool.result',
        payload: {
          call_id: 'call_4',
          text: 'boom',
          correlation_facts: { tool_name: 'bash', outcome: 'failure' }
        }
      },
      ctx,
      state
    )
    const part = toolPart(state)
    expect(part?.state.status).toBe('error')
    expect(part?.state.output).toBe('boom')
  })
})

describe('muse driver session-log backfill (Muse 1.x headless)', () => {
  it('fills the reasoning summary from runtime.session reasoning summary records', () => {
    const state = makeState()
    const summaryRecords = [
      {
        record_type: 'event',
        payload_type: 'runtime.session',
        payload: { kind: 'run', event: { kind: 'reasoning_summary_delta', text: 'Analyzing the ' } }
      },
      {
        record_type: 'event',
        payload_type: 'runtime.session',
        payload: {
          kind: 'run',
          event: { kind: 'reasoning_summary_delta', text: 'working trace fix.' }
        }
      },
      {
        record_type: 'event',
        payload_type: 'runtime.session',
        payload: {
          kind: 'run',
          event: {
            kind: 'reasoning_summary_committed',
            text: 'Analyzing the working trace fix.'
          }
        }
      }
    ]
    let reasoningEvents = 0
    for (const rec of summaryRecords) {
      const result = mapMuseRecord(rec, ctx, state)
      if (result?.events?.some((event) => event.type === 'message.part.updated')) reasoningEvents++
    }
    const part = state.parts.find((candidate) => candidate.type === 'reasoning')
    expect(part?.type === 'reasoning' ? part.summary : undefined).toBe(
      'Analyzing the working trace fix.'
    )
    expect(reasoningEvents).toBe(3)
  })

  it('backfills tool input and output from the session-log output mirror', () => {
    const state = makeState()
    // The live stream proposed + started the call but never streamed the chunk.
    mapMuseRecord(lifecycle('t5', 'proposed', { task_kind: 'tool.bash' }), ctx, state)
    mapMuseRecord(
      lifecycle('t5', 'side_effect_intent', { idempotency_key: 'tool:call_5' }),
      ctx,
      state
    )
    // The durable session log mirrors the output chunk under runtime.session.
    mapMuseRecord(
      {
        record_type: 'event',
        payload_type: 'runtime.session',
        payload: {
          kind: 'run',
          event: {
            kind: 'output',
            task_id: 't5',
            chunk: JSON.stringify({
              command: 'grep -rn fix src | head',
              description: 'Search for fix',
              exit_code: 0,
              output: 'src/app.ts:1: fix\n'
            })
          }
        }
      },
      ctx,
      state
    )
    const part = toolPart(state)
    expect(part?.state.input).toEqual({ command: 'grep -rn fix src | head' })
    expect(part?.state.title).toBe('Search for fix')
    expect(part?.state.output).toBe('src/app.ts:1: fix\n')
    expect(part?.state.status).toBe('running')
  })

  it('settles an in-flight tool from the session-log result batch', () => {
    const state = makeState()
    mapMuseRecord(lifecycle('t6', 'proposed', { task_kind: 'tool.bash' }), ctx, state)
    mapMuseRecord(
      lifecycle('t6', 'side_effect_intent', { idempotency_key: 'tool:call_6' }),
      ctx,
      state
    )
    mapMuseRecord(
      {
        record_type: 'event',
        payload_type: 'runtime.session',
        payload: {
          kind: 'run',
          event: {
            kind: 'tool_result_batch_committed',
            batch_id: 'b1',
            results: [{ tool_call_index: 0, tool_call_id: 'call_6', text: 'all good' }]
          }
        }
      },
      ctx,
      state
    )
    const part = toolPart(state)
    expect(part?.state.status).toBe('completed')
    expect(part?.state.output).toBe('all good')
  })

  it('finalizes tools still in flight when the run terminates', () => {
    const state = makeState()
    mapMuseRecord(lifecycle('t7', 'proposed', { task_kind: 'tool.bash' }), ctx, state)
    mapMuseRecord(
      lifecycle('t7', 'side_effect_intent', { idempotency_key: 'tool:call_7' }),
      ctx,
      state
    )
    const result = mapMuseRecord(
      {
        payload_type: 'run.terminal.completed',
        payload: { terminal: 'completed', text: 'done' }
      },
      ctx,
      state
    )
    const part = toolPart(state)
    expect(part?.state.status).toBe('error')
    expect(part?.state.error).toContain('Interrupted')
    expect(result?.events?.some((event) => event.type === 'message.completed')).toBe(true)
  })

  it('marks a tool task rejected by Muse policy as an error card', () => {
    const state = makeState()
    mapMuseRecord(lifecycle('t8', 'proposed', { task_kind: 'tool.bash' }), ctx, state)
    mapMuseRecord(lifecycle('t8', 'rejected', { reason: 'denied_by_policy' }), ctx, state)
    const part = toolPart(state)
    expect(part?.state.status).toBe('error')
    expect(part?.state.error).toContain('denied_by_policy')
  })

  it('does not emit a duplicate compaction checkpoint for the session-log mirror', () => {
    const state = makeState()
    const compactionRecord = (text: string): unknown => ({
      record_type: 'event',
      payload_type: 'runtime.session',
      payload: { kind: 'run', event: { kind: 'compaction_installed', summary: text } }
    })
    const first = mapMuseRecord(compactionRecord('summary text'), ctx, state)
    const second = mapMuseRecord(compactionRecord('summary text'), ctx, state)
    expect(first?.messages?.length).toBe(1)
    expect(second?.messages?.length ?? 0).toBe(0)
  })
})
