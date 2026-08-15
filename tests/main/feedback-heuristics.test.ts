import { describe, expect, it } from 'vitest'
import {
  looksCorrective,
  restoreMirrorThinkingLevel,
  stampHarnessId
} from '../../src/main/chat/chat-engine'
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

describe('looksCorrective', () => {
  it('flags unambiguous corrections of the previous answer', () => {
    expect(looksCorrective("that's wrong, do it again properly")).toBe(true)
    expect(looksCorrective('this still does not work')).toBe(true)
    expect(looksCorrective('you broke the build')).toBe(true)
    expect(looksCorrective('there is a regression now')).toBe(true)
    expect(looksCorrective('incorrect, the output is wrong')).toBe(true)
  })

  it('does not flag ambiguous tasking or neutral continuations', () => {
    // Audit regression: bare "wrong"/"fix this"/"try again" must not score a
    // legitimate answer as a miss.
    expect(looksCorrective('now fix this other part too')).toBe(false)
    expect(looksCorrective('try again with the deployment script instead')).toBe(false)
    expect(looksCorrective('check the wrong branch name for me')).toBe(false)
    expect(looksCorrective('perfect, keep going')).toBe(false)
    expect(looksCorrective('thanks, that worked')).toBe(false)
    expect(looksCorrective('do you still think it is the right approach?')).toBe(false)
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
