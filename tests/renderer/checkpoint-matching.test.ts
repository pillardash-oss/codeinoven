import { describe, expect, it } from 'vitest'
import { checkpointForTurn, isCheckpointTurnEnd } from '$lib/threads/checkpoint-matching'
import type { AgentMessage, TurnCheckpointSummary } from '$shared/types'

function msg(
  role: AgentMessage['role'],
  createdAt: number,
  id = `${role}-${createdAt}`
): AgentMessage {
  return {
    id,
    role,
    createdAt,
    parts: []
  } as AgentMessage
}

function checkpoint(
  id: string,
  createdAt: number,
  completedAt: number,
  options: { status?: TurnCheckpointSummary['status']; changes?: number } = {}
): TurnCheckpointSummary {
  return {
    id,
    projectId: 'p',
    threadId: 't',
    label: id,
    status: options.status ?? 'committed',
    createdAt,
    completedAt,
    changes: Array.from({ length: options.changes ?? 0 }, (_, i) => ({
      kind: 'modified' as const,
      path: `file-${i}.ts`
    }))
  } as TurnCheckpointSummary
}

describe('checkpointForTurn', () => {
  it('matches an assistant message that falls inside a committed checkpoint window', () => {
    const messages = [msg('user', 100), msg('assistant', 120)]
    const checkpoints = [checkpoint('cp-1', 110, 130, { changes: 1 })]
    expect(checkpointForTurn(messages, checkpoints, 1)?.id).toBe('cp-1')
  })

  it('ignores active checkpoints', () => {
    const messages = [msg('user', 100), msg('assistant', 120)]
    const checkpoints = [checkpoint('cp-1', 110, 130, { status: 'active', changes: 1 })]
    expect(checkpointForTurn(messages, checkpoints, 1)).toBeNull()
  })

  it('does not let the next turn steal the previous final assistant', () => {
    // Turn 1 checkpoint ends right after its assistant. Turn 2 begins well
    // after the start-edge tolerance so it cannot claim the previous assistant.
    const messages = [
      msg('user', 100),
      msg('assistant', 120),
      msg('user', 250),
      msg('assistant', 270)
    ]
    const checkpoints = [
      checkpoint('cp-1', 110, 125, { changes: 1 }),
      checkpoint('cp-2', 260, 280, { changes: 2 })
    ]
    expect(checkpointForTurn(messages, checkpoints, 1)?.id).toBe('cp-1')
    expect(checkpointForTurn(messages, checkpoints, 3)?.id).toBe('cp-2')
  })

  it('returns the most recent checkpoint when windows overlap', () => {
    // A resumed/retried turn creates a second checkpoint that starts later but
    // still contains the final assistant.
    const messages = [msg('user', 100), msg('assistant', 150)]
    const checkpoints = [
      checkpoint('cp-1', 110, 160, { changes: 1 }),
      checkpoint('cp-2', 130, 160, { changes: 2 })
    ]
    expect(checkpointForTurn(messages, checkpoints, 1)?.id).toBe('cp-2')
  })

  it('allows tiny clock skew at the start edge', () => {
    const messages = [msg('user', 100), msg('assistant', 109)]
    const checkpoints = [checkpoint('cp-1', 110, 130, { changes: 1 })]
    expect(checkpointForTurn(messages, checkpoints, 1)?.id).toBe('cp-1')
  })

  it('does not match an assistant before the checkpoint window', () => {
    const messages = [msg('assistant', 1), msg('assistant', 120)]
    const checkpoints = [checkpoint('cp-1', 110, 130)]
    expect(checkpointForTurn(messages, checkpoints, 0)).toBeNull()
  })
})

describe('isCheckpointTurnEnd', () => {
  it('is true for the last assistant inside the checkpoint window', () => {
    const messages = [
      msg('user', 100),
      msg('assistant', 110),
      msg('assistant', 120),
      msg('user', 130)
    ]
    const cp = checkpoint('cp-1', 105, 125)
    expect(isCheckpointTurnEnd(messages, cp, 1)).toBe(false)
    expect(isCheckpointTurnEnd(messages, cp, 2)).toBe(true)
  })

  it('ignores later assistants that fall outside the window', () => {
    const messages = [msg('assistant', 110), msg('user', 120), msg('assistant', 140)]
    const cp = checkpoint('cp-1', 105, 115)
    expect(isCheckpointTurnEnd(messages, cp, 0)).toBe(true)
  })
})
