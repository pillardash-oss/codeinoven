import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentPart } from '../../../src/lib/types'
import { mapOpenCodeV2Event } from '../../../src/main/drivers/opencode-v2/v2-events'
import {
  isOpenCodeV2SubagentTool,
  mapOpenCodeV2AssistantContent,
  toolPartId
} from '../../../src/main/drivers/opencode-v2/v2-messages'

/** Wrap one V2 event payload in the live SSE envelope shape. */
function sseEvent(type: string, data: Record<string, unknown>) {
  return { type, data, envelope: { id: 'evt_1', type, data } }
}

function partsOf(events: AgentEvent[]): AgentPart[] {
  return events.flatMap((event) => (event.type === 'message.part.updated' ? [event.part] : []))
}

describe('opencode v2 subagent mapping', () => {
  it('recognizes the delegated subagent tool name', () => {
    expect(isOpenCodeV2SubagentTool('subagent')).toBe(true)
    expect(isOpenCodeV2SubagentTool('SUBAGENT')).toBe(true)
    expect(isOpenCodeV2SubagentTool('read')).toBe(false)
  })

  it('maps a live subagent call to a sub-agent part, not a generic tool card', () => {
    const events = mapOpenCodeV2Event(
      sseEvent('session.tool.input.started', {
        sessionID: 'ses_parent',
        assistantMessageID: 'msg_1',
        id: 'call_1',
        name: 'subagent'
      }),
      { assistantMessageId: 'msg_1' }
    )

    const part = partsOf(events)[0]
    expect(part?.type).toBe('subagent')
    expect(part?.id).toBe(toolPartId('msg_1', 'call_1'))
  })

  it('carries the child session id and output onto the activity', () => {
    const events = mapOpenCodeV2Event(
      sseEvent('session.tool.success', {
        sessionID: 'ses_parent',
        assistantMessageID: 'msg_1',
        id: 'call_1',
        metadata: { sessionID: 'ses_child', status: 'completed' },
        content: [{ type: 'text', text: 'done' }]
      }),
      { assistantMessageId: 'msg_1', toolNames: new Map([['call_1', 'subagent']]) }
    )

    const part = partsOf(events)[0]
    if (part?.type !== 'subagent') throw new Error('expected a sub-agent part')
    expect(part.activity.status).toBe('completed')
    expect(part.activity.childSessionId).toBe('ses_child')
    expect(part.activity.output).toBe('done')
  })

  it('keeps an ordinary tool call as a tool part', () => {
    const events = mapOpenCodeV2Event(
      sseEvent('session.tool.called', {
        sessionID: 'ses_parent',
        assistantMessageID: 'msg_1',
        id: 'call_2',
        input: { path: 'src/index.ts' }
      }),
      { assistantMessageId: 'msg_1', toolNames: new Map([['call_2', 'read']]) }
    )

    expect(partsOf(events)[0]?.type).toBe('tool')
  })

  it('maps a persisted subagent call the same way as the live stream', () => {
    const parts = mapOpenCodeV2AssistantContent('msg_1', [
      {
        type: 'tool',
        id: 'call_1',
        name: 'subagent',
        state: {
          status: 'running',
          input: { agent: 'explore', description: 'read hello.txt', prompt: 'read it' },
          metadata: { sessionID: 'ses_child' }
        }
      }
    ])

    const part = parts[0]
    if (part?.type !== 'subagent') throw new Error('expected a sub-agent part')
    expect(part.activity.agent).toBe('explore')
    expect(part.activity.description).toBe('read hello.txt')
    expect(part.activity.prompt).toBe('read it')
    expect(part.activity.childSessionId).toBe('ses_child')
    expect(part.activity.status).toBe('running')
  })
})
