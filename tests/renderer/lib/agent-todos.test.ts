import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentPart } from '../../../src/lib/types'
import {
  activeAgentTodoIndex,
  agentTodoProgressLabel,
  latestAgentTodo,
  todoSnapshotMatchesTurn
} from '../../../src/renderer/lib/agent-todos'

function todoWritePart(id: string, callID: string, labels: string[]): AgentPart {
  return {
    type: 'tool',
    id,
    messageID: 'turn',
    callID,
    tool: 'cio_todo_write',
    state: {
      status: 'completed',
      input: {
        todos: labels.map((content, index) => ({
          id: `todo-${index + 1}`,
          content,
          status: 'pending'
        }))
      }
    }
  }
}

describe('latestAgentTodo', () => {
  it('infers the first pending task as active only while the agent is working', () => {
    const items = [
      { id: 'first', label: 'Inspect the driver', status: 'pending' as const },
      { id: 'second', label: 'Apply the fix', status: 'pending' as const }
    ]

    expect(activeAgentTodoIndex(items, true)).toBe(0)
    expect(activeAgentTodoIndex(items, false)).toBe(-1)
  })

  it('prefers an explicit in-progress task over the pending fallback', () => {
    const items = [
      { id: 'first', label: 'Inspect the driver', status: 'pending' as const },
      { id: 'second', label: 'Apply the fix', status: 'in_progress' as const }
    ]

    expect(activeAgentTodoIndex(items, true)).toBe(1)
    expect(activeAgentTodoIndex(items, false)).toBe(1)
  })

  it('omits redundant completion copy while a task is active', () => {
    expect(agentTodoProgressLabel(6, 0, 0)).toBe('Working on 1 of 6')
    expect(agentTodoProgressLabel(6, 0, -1)).toBe('6 tasks')
    expect(agentTodoProgressLabel(6, 6, -1)).toBe('6/6 done')
  })

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

  it('drops the card when the harness publishes an explicitly empty list', () => {
    const messages: AgentMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', id: 'user-text', messageID: 'user-1', text: 'Implement it' }],
        createdAt: 1
      },
      {
        id: 'turn-1:todo-1',
        role: 'assistant',
        parts: [todoWritePart('turn-1:todo-1:tool', 'turn-1:todo-1', ['Inspect it', 'Fix it'])],
        createdAt: 2
      },
      {
        id: 'turn-1:todo-2',
        role: 'assistant',
        parts: [todoWritePart('turn-1:todo-2:tool', 'turn-1:todo-2', [])],
        createdAt: 3
      }
    ]

    expect(latestAgentTodo(messages)).toBeNull()
  })

  it('does not clear the list when a snapshot carries no task list at all', () => {
    const messages: AgentMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', id: 'user-text', messageID: 'user-1', text: 'Implement it' }],
        createdAt: 1
      },
      {
        id: 'turn-1:todo-1',
        role: 'assistant',
        parts: [todoWritePart('turn-1:todo-1:tool', 'turn-1:todo-1', ['Inspect it', 'Fix it'])],
        createdAt: 2
      },
      {
        id: 'turn-1:progress',
        role: 'assistant',
        parts: [
          {
            type: 'tool',
            id: 'turn-1:progress:tool',
            messageID: 'turn-1:progress',
            callID: 'turn-1:progress',
            tool: 'cio_todo_write',
            state: { status: 'pending', input: {} }
          }
        ],
        createdAt: 3
      }
    ]

    expect(latestAgentTodo(messages)?.items).toHaveLength(2)
  })

  it('lets a stale durable snapshot overrule the transcript, which is why it is gated by turn', () => {
    const previousTurnTodo = todoWritePart('turn-1:todo:tool', 'turn-1:todo', ['Old task'])
    const messages: AgentMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', id: 'user-text-1', messageID: 'user-1', text: 'First' }],
        createdAt: 1
      },
      { id: 'turn-1', role: 'assistant', parts: [previousTurnTodo], createdAt: 2 },
      {
        id: 'user-2',
        role: 'user',
        parts: [{ type: 'text', id: 'user-text-2', messageID: 'user-2', text: 'Second' }],
        createdAt: 3
      },
      {
        id: 'turn-2',
        role: 'assistant',
        parts: [{ type: 'text', id: 'turn-2:text', messageID: 'turn-2', text: 'Done' }],
        createdAt: 4
      }
    ]

    expect(latestAgentTodo(messages)).toBeNull()
    expect(
      latestAgentTodo([
        ...messages,
        {
          id: 'thread:todo-stream',
          role: 'assistant',
          parts: [previousTurnTodo],
          createdAt: Number.MAX_SAFE_INTEGER
        }
      ])?.items
    ).toEqual([{ id: 'todo-1', label: 'Old task', status: 'pending' }])
  })
})

describe('todoSnapshotMatchesTurn', () => {
  it('trusts the snapshot when either side has no turn anchor', () => {
    expect(todoSnapshotMatchesTurn(null, 10)).toBe(true)
    expect(todoSnapshotMatchesTurn(10, null)).toBe(true)
    expect(todoSnapshotMatchesTurn(null, null)).toBe(true)
  })

  it('accepts a snapshot for the same or a newer turn', () => {
    expect(todoSnapshotMatchesTurn(10, 10)).toBe(true)
    expect(todoSnapshotMatchesTurn(20, 10)).toBe(true)
  })

  it('rejects a snapshot once the transcript advanced to a newer prompt', () => {
    expect(todoSnapshotMatchesTurn(10, 11)).toBe(false)
  })
})
