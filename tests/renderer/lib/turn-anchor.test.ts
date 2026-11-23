import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentMessageOrigin, AgentPart } from '../../../src/lib/types'
import { newestTurnPromptCreatedAt } from '../../../src/renderer/lib/components/threads/thread-turn-parts'

function textPart(id: string): AgentPart {
  return { id: `${id}-text`, messageID: id, type: 'text', text: 'hi' }
}

function message(
  id: string,
  role: 'user' | 'assistant',
  createdAt: number,
  parts: AgentPart[] = [textPart(id)],
  origin?: AgentMessageOrigin
): AgentMessage {
  return { id, role, createdAt, parts, ...(origin === undefined ? {} : { origin }) }
}

function questionAnswer(id: string, createdAt: number): AgentMessage {
  return message(`question-answer-${id}`, 'user', createdAt)
}

function compactionNotice(id: string, createdAt: number): AgentMessage {
  return message(id, 'user', createdAt, [
    { id: `${id}-compaction`, messageID: id, type: 'compaction', auto: true, summary: 'trimmed' }
  ])
}

describe('newestTurnPromptCreatedAt', () => {
  it('measures from the prompt, not from a question the agent asked mid-turn', () => {
    const messages = [
      message('prompt', 'user', 1_000),
      message('answer', 'assistant', 1_100),
      questionAnswer('asked-mid-turn', 900_000),
      message('continues', 'assistant', 900_100)
    ]

    expect(newestTurnPromptCreatedAt(messages)).toBe(1_000)
  })

  it('skips activity-only notices and the app own continuation prompts', () => {
    const messages = [
      message('prompt', 'user', 5_000),
      compactionNotice('compaction', 6_000),
      message('continuation', 'user', 7_000, [textPart('continuation')], 'orchestrator')
    ]

    expect(newestTurnPromptCreatedAt(messages)).toBe(5_000)
  })

  it('honours the caller transparency rule for a held steer', () => {
    const held = message('held-steer', 'user', 9_000)
    const messages = [message('prompt', 'user', 8_000), held]

    expect(newestTurnPromptCreatedAt(messages, (candidate) => candidate.id === held.id)).toBe(8_000)
  })

  it('returns null when the transcript holds only mid-turn rows', () => {
    const messages = [compactionNotice('compaction', 1_000), questionAnswer('answer', 2_000)]

    expect(newestTurnPromptCreatedAt(messages)).toBeNull()
  })
})
