import { describe, expect, it } from 'vitest'
import {
  restoreMirrorThinkingLevel,
  stampHarnessId
} from '../../src/main/chat/chat-engine'
import { buildTurnGradePrompt, parseTurnGrade } from '../../src/main/chat/turn-grader-prompt'
import type { AgentMessage } from '../../src/lib/types'

function message(id: string, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', id: `${id}-p`, messageID: id, text: 'ok' }],
    createdAt: 1,
    ...overrides
  }
}

describe('parseTurnGrade', () => {
  it('accepts a JSON grade object or a bare integer', () => {
    expect(parseTurnGrade('{"grade": 4}')).toBe(4)
    expect(parseTurnGrade('Sure!\n\n{"grade": 5}')).toBe(5)
    expect(parseTurnGrade('3')).toBe(3)
  })

  it('rejects unusable responses and out-of-range grades', () => {
    expect(parseTurnGrade('I would say it went pretty well')).toBeNull()
    expect(parseTurnGrade('')).toBeNull()
    expect(parseTurnGrade('{"grade": 0}')).toBeNull()
    expect(parseTurnGrade('{"grade": 6}')).toBeNull()
  })
})

describe('buildTurnGradePrompt', () => {
  it('wraps each payload field in explicit delimiters', () => {
    const prompt = buildTurnGradePrompt({
      userMessage: 'fix the bug',
      assistantOutput: 'done',
      followUp: 'still broken'
    })
    expect(prompt).toContain('<USER_MESSAGE>fix the bug</USER_MESSAGE>')
    expect(prompt).toContain('<AGENT_OUTPUT>done</AGENT_OUTPUT>')
    expect(prompt).toContain('<USER_FOLLOW_UP>still broken</USER_FOLLOW_UP>')
  })

  it('omits the follow-up section when there is none', () => {
    const prompt = buildTurnGradePrompt({ userMessage: 'hi', assistantOutput: 'hello' })
    expect(prompt).not.toContain('USER_FOLLOW_UP')
  })
})

describe('restoreMirrorThinkingLevel', () => {
  it('preserves persisted levels when the driver transcript omits them', () => {
    const mirror = [message('m1', { thinkingLevel: 'high' }), message('m2')]
    const incoming = [message('m1'), message('m2'), message('m3', { thinkingLevel: 'low' })]

    const restored = restoreMirrorThinkingLevel(incoming, mirror)
    expect(restored.find((m) => m.id === 'm1')?.thinkingLevel).toBe('high')
    expect(restored.find((m) => m.id === 'm2')?.thinkingLevel).toBeUndefined()
    // A driver-provided level is never overwritten by the mirror.
    expect(restored.find((m) => m.id === 'm3')?.thinkingLevel).toBe('low')
  })

  it('clears a driver-stamped level on messages the mirror never recorded one for', () => {
    // After a restart the driver can re-stamp the whole session with the live
    // turn's provenance; a message the mirror knows only as "unknown" must not
    // inherit that level.
    const mirror = [message('m1')]
    const incoming = [message('m1', { thinkingLevel: 'high' })]
    const restored = restoreMirrorThinkingLevel(incoming, mirror)
    expect(restored[0]?.thinkingLevel).toBeUndefined()
  })

  it('never invents levels for brand-new messages', () => {
    const incoming = [message('fresh')]
    const restored = restoreMirrorThinkingLevel(incoming, [])
    expect(restored[0]?.thinkingLevel).toBeUndefined()
  })

  it('preserves a driver level on messages not yet in the mirror', () => {
    const mirror = [message('m1')]
    const incoming = [
      message('m1', { thinkingLevel: 'high' }),
      message('new-turn', { thinkingLevel: 'low' })
    ]
    const restored = restoreMirrorThinkingLevel(incoming, mirror)
    expect(restored.find((m) => m.id === 'm1')?.thinkingLevel).toBeUndefined()
    expect(restored.find((m) => m.id === 'new-turn')?.thinkingLevel).toBe('low')
  })
})

describe('stampHarnessId', () => {
  it('stamps the harness id only, never a thinking level', () => {
    const stamped = stampHarnessId([message('m1')], 'codex')
    expect(stamped[0]?.harnessId).toBe('codex')
    expect(stamped[0]?.thinkingLevel).toBeUndefined()
  })
})
