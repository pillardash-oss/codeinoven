import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../src/lib/types'
import { latestAgentTodo } from '../../../src/renderer/lib/agent-todos'

describe('latestAgentTodo', () => {
  it('tracks Codex plan status changes in the latest snapshot', () => {
    const messages: AgentMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', id: 'user-text', messageID: 'user-1', text: 'Implement it' }],
        createdAt: 1
      },
      {
        id: 'turn-1:plan',
        role: 'assistant',
        parts: [
          {
            type: 'tool',
            id: 'turn-1:plan:tool',
            messageID: 'turn-1:plan',
            callID: 'turn-1:plan',
            tool: 'plan_update',
            state: {
              status: 'completed',
              input: {
                plan: [
                  { step: 'Inspect the driver', status: 'completed' },
                  { step: 'Apply the fix', status: 'inProgress' },
                  { step: 'Run checks', status: 'pending' }
                ]
              }
            }
          }
        ],
        createdAt: 2
      }
    ]

    expect(latestAgentTodo(messages)?.items).toEqual([
      { id: 'todo-0-Inspect the driver', label: 'Inspect the driver', status: 'completed' },
      { id: 'todo-1-Apply the fix', label: 'Apply the fix', status: 'in_progress' },
      { id: 'todo-2-Run checks', label: 'Run checks', status: 'pending' }
    ])
  })
})
