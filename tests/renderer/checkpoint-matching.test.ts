import { describe, expect, it } from 'vitest'
import { checkpointForTurn } from '$lib/threads/checkpoint-matching'
import { buildTranscriptIndex } from '$lib/components/threads/thread-turn-parts'
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
  options: {
    status?: TurnCheckpointSummary['status']
    changes?: number
    sourceMessageId?: string
  } = {}
): TurnCheckpointSummary {
  return {
    id,
    projectId: 'p',
    threadId: 't',
    label: id,
    status: options.status ?? 'committed',
    ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
    createdAt,
    completedAt,
    changes: Array.from({ length: options.changes ?? 0 }, (_, i) => ({
      kind: 'modified' as const,
      path: `file-${i}.ts`
    }))
  } as TurnCheckpointSummary
}

/** Indices where the resolved index says the changes card renders. */
function cardIndices(messages: AgentMessage[], checkpoints: TurnCheckpointSummary[]): number[] {
  const index = buildTranscriptIndex(messages, checkpoints)
  return index.checkpointCard.flatMap((value, position) => (value ? [position] : []))
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

describe('checkpoint card placement', () => {
  it('renders at the last assistant inside the checkpoint window (fallback)', () => {
    const messages = [
      msg('user', 100),
      msg('assistant', 110),
      msg('assistant', 120),
      msg('user', 130)
    ]
    const cp = checkpoint('cp-1', 105, 125)
    expect(cardIndices(messages, [cp])).toEqual([2])
  })

  it('does not place a card for an assistant before the window', () => {
    const messages = [msg('assistant', 110), msg('user', 120), msg('assistant', 140)]
    const cp = checkpoint('cp-1', 105, 115)
    expect(cardIndices(messages, [cp])).toEqual([0])
  })

  // Regression: a harness can flush its final assistant message after the
  // checkpoint was completed, so the completedAt window cut the turn short and
  // the card had no turn end to attach to. Timestamps below are the real ones
  // from the reported thread (checkpoint completed 1792362116786, final
  // assistant created 1792362141730).
  it('anchors the card to the turn by sourceMessageId, past a late final assistant', () => {
    const promptId = 'msg_150f33b96001c1K0WBTsJAss9c'
    const messages = [
      msg('user', 1792359480260, promptId),
      msg('assistant', 1792359482541),
      msg('assistant', 1792362115784),
      msg('assistant', 1792362141730)
    ]
    const cp = checkpoint('cp-1', 1792359481953, 1792362116786, {
      changes: 2,
      sourceMessageId: promptId
    })
    const index = buildTranscriptIndex(messages, [cp])
    expect(index.checkpoint[1]?.id).toBe('cp-1')
    expect(index.checkpoint[3]?.id).toBe('cp-1')
    expect(cardIndices(messages, [cp])).toEqual([3])
  })

  it('keeps one card per turn across mid-turn question answers', () => {
    const promptId = 'prompt-1'
    const messages = [
      msg('user', 100, promptId),
      msg('assistant', 110),
      msg('user', 115, 'question-answer-1'),
      msg('assistant', 120),
      msg('assistant', 130)
    ]
    const cp = checkpoint('cp-1', 105, 118, { changes: 1, sourceMessageId: promptId })
    expect(cardIndices(messages, [cp])).toEqual([4])
  })

  it('lets the newest checkpoint own a retried turn', () => {
    const promptId = 'prompt-1'
    const messages = [msg('user', 100, promptId), msg('assistant', 150)]
    const checkpoints = [
      checkpoint('cp-1', 110, 160, { changes: 1, sourceMessageId: promptId }),
      checkpoint('cp-2', 130, 160, { changes: 2, sourceMessageId: promptId })
    ]
    const index = buildTranscriptIndex(messages, checkpoints)
    expect(index.checkpoint[1]?.id).toBe('cp-2')
    expect(cardIndices(messages, checkpoints)).toEqual([1])
  })

  it('ignores active checkpoints', () => {
    const messages = [msg('user', 100, 'prompt-1'), msg('assistant', 150)]
    const cp = checkpoint('cp-1', 110, 160, {
      status: 'active',
      changes: 1,
      sourceMessageId: 'prompt-1'
    })
    expect(cardIndices(messages, [cp])).toEqual([])
  })
})
