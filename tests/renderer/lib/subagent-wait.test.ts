import { describe, expect, it } from 'vitest'
import { CIO_AGENT_OUTPUT_TOOL_NAME, CIO_AGENT_STATUS_TOOL_NAME } from '$shared/core-tools'
import type { AgentMessage, AgentPart } from '$shared/types'
import { partWaitsOnSubagents, turnWaitsOnSubagents } from '$lib/subagent-wait'

function userMessage(parts: AgentPart[] = [], id = 'user-1'): AgentMessage {
  return { id, role: 'user', parts, createdAt: 0 }
}

function assistantMessage(parts: AgentPart[], id = 'assistant-1'): AgentMessage {
  return { id, role: 'assistant', parts, createdAt: 0 }
}

function toolPart(
  tool: string,
  status: 'pending' | 'running' | 'completed',
  input: Record<string, unknown> = {}
): AgentPart {
  return {
    type: 'tool',
    id: `${tool}-${status}-${JSON.stringify(input)}`,
    messageID: 'assistant-1',
    callID: `call-${tool}`,
    tool,
    state: { status, input }
  }
}

function subagentPart(status: 'pending' | 'running' | 'completed', background: boolean): AgentPart {
  return {
    type: 'subagent',
    id: `subagent-${status}-${background}`,
    messageID: 'assistant-1',
    activity: {
      status,
      agent: 'explore',
      description: 'Explore',
      background
    }
  }
}

describe('partWaitsOnSubagents', () => {
  it('counts an in-flight status wait', () => {
    expect(
      partWaitsOnSubagents(toolPart(CIO_AGENT_STATUS_TOOL_NAME, 'running', { wait: true }))
    ).toBe(true)
  })

  it('ignores a status poll that does not wait', () => {
    expect(
      partWaitsOnSubagents(toolPart(CIO_AGENT_STATUS_TOOL_NAME, 'running', { wait: false }))
    ).toBe(false)
    expect(partWaitsOnSubagents(toolPart(CIO_AGENT_STATUS_TOOL_NAME, 'running'))).toBe(false)
  })

  it('counts an in-flight output wait', () => {
    expect(
      partWaitsOnSubagents(
        toolPart(CIO_AGENT_OUTPUT_TOOL_NAME, 'running', { wait: true, agent_ids: ['a'] })
      )
    ).toBe(true)
  })

  it('stops waiting once the call settles', () => {
    expect(
      partWaitsOnSubagents(toolPart(CIO_AGENT_STATUS_TOOL_NAME, 'completed', { wait: true }))
    ).toBe(false)
  })

  it('counts an inline worker, not a background one', () => {
    expect(partWaitsOnSubagents(subagentPart('running', false))).toBe(true)
    expect(partWaitsOnSubagents(subagentPart('running', true))).toBe(false)
    expect(partWaitsOnSubagents(subagentPart('completed', false))).toBe(false)
  })

  it('ignores parts that are not sub-agent work', () => {
    expect(partWaitsOnSubagents(toolPart('bash', 'running', {}))).toBe(false)
    expect(
      partWaitsOnSubagents({ type: 'text', id: 't', messageID: 'assistant-1', text: 'hi' })
    ).toBe(false)
  })
})

describe('turnWaitsOnSubagents', () => {
  it('sees a wait in the running turn', () => {
    expect(
      turnWaitsOnSubagents([userMessage(), assistantMessage([subagentPart('running', false)])])
    ).toBe(true)
  })

  it('ignores a wait left behind an earlier user turn', () => {
    expect(
      turnWaitsOnSubagents([
        userMessage(),
        assistantMessage([subagentPart('running', false)]),
        userMessage([], 'user-2'),
        assistantMessage(
          [{ type: 'text', id: 't', messageID: 'assistant-2', text: 'done' }],
          'assistant-2'
        )
      ])
    ).toBe(false)
  })

  it('looks through a steer, which is a user row inside the same turn', () => {
    const steer = userMessage([], 'steer-1')
    steer.turnTransparent = true
    expect(
      turnWaitsOnSubagents([
        userMessage(),
        assistantMessage([subagentPart('running', false)]),
        steer,
        assistantMessage(
          [{ type: 'text', id: 't', messageID: 'assistant-2', text: 'noted' }],
          'assistant-2'
        )
      ])
    ).toBe(true)
  })

  it('answers false for an empty transcript', () => {
    expect(turnWaitsOnSubagents([])).toBe(false)
  })
})
