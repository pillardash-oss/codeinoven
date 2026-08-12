import { describe, expect, it, vi } from 'vitest'
import {
  mapOpenCodeEvent,
  mapOpenCodePart,
  opencodePermissionTools,
  parseOpenCodeModels
} from './opencode-driver'

vi.mock('child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }))

describe('parseOpenCodeModels', () => {
  it('parses verbose CLI output without starting a server', () => {
    expect(
      parseOpenCodeModels(`opencode/model-one
{
  "id": "model-one",
  "providerID": "opencode",
  "name": "Model One",
  "limit": { "context": 200000 }
}
anthropic/model-two
{
  "id": "model-two",
  "providerID": "anthropic",
  "name": "Model Two"
}`)
    ).toEqual([
      expect.objectContaining({ id: 'model-one', providerID: 'opencode' }),
      expect.objectContaining({ id: 'model-two', providerID: 'anthropic' })
    ])
  })
})

describe('mapOpenCodePart', () => {
  it.each([
    ['text', { type: 'text', id: 'part-text', messageID: 'message-1', text: 'Hi' }],
    [
      'reasoning',
      {
        type: 'reasoning',
        id: 'part-reasoning',
        messageID: 'message-1',
        text: 'Think'
      }
    ],
    [
      'file',
      {
        type: 'file',
        id: 'part-file',
        messageID: 'message-1',
        mime: 'text/plain',
        url: 'file:///tmp/example.txt',
        filename: 'example.txt'
      }
    ],
    [
      'step-start',
      {
        type: 'step-start',
        id: 'part-start',
        messageID: 'message-1'
      }
    ],
    [
      'step-finish',
      {
        type: 'step-finish',
        id: 'part-finish',
        messageID: 'message-1',
        reason: 'stop',
        cost: 0.25
      }
    ]
  ])('maps a %s part without changing its IDs', (_name, part) => {
    expect(mapOpenCodePart(part)).toEqual(part)
  })

  it('maps tool state details and IDs', () => {
    expect(
      mapOpenCodePart({
        type: 'tool',
        id: 'part-tool',
        messageID: 'message-2',
        callID: 'call-1',
        tool: 'read',
        state: {
          status: 'completed',
          input: { path: 'README.md' },
          title: 'Read README',
          output: 'contents',
          metadata: { bytes: 8 },
          time: { start: 10, end: 20 }
        }
      })
    ).toEqual({
      type: 'tool',
      id: 'part-tool',
      messageID: 'message-2',
      callID: 'call-1',
      tool: 'read',
      state: {
        status: 'completed',
        input: { path: 'README.md' },
        title: 'Read README',
        output: 'contents',
        error: undefined,
        metadata: { bytes: 8 },
        time: { start: 10, end: 20 }
      }
    })
  })

  it('maps a question tool from the prompt field', () => {
    const input = {
      prompt: 'What is your favorite color?',
      description: 'Choose wisely.',
      options: ['Red', 'Green', 'Blue'],
      multiple: false
    }
    expect(
      mapOpenCodePart({
        type: 'tool',
        id: 'part-question',
        messageID: 'message-3',
        callID: 'call-2',
        tool: 'question',
        state: {
          status: 'running',
          input
        }
      })
    ).toEqual({
      type: 'question',
      id: 'part-question',
      messageID: 'message-3',
      callID: 'call-2',
      question: {
        prompt: 'What is your favorite color?',
        description: 'Choose wisely.',
        options: ['Red', 'Green', 'Blue'],
        richOptions: undefined,
        multiple: false,
        custom: true,
        answer: undefined,
        rawInput: JSON.stringify(input)
      }
    })
  })

  it('maps a question tool from stringified JSON input', () => {
    const rawInput = JSON.stringify({
      prompt: 'Stringified prompt',
      options: ['A', 'B']
    })
    expect(
      mapOpenCodePart({
        type: 'tool',
        id: 'part-question',
        messageID: 'message-3',
        callID: 'call-2',
        tool: 'question',
        state: {
          status: 'running',
          input: rawInput
        }
      })
    ).toEqual({
      type: 'question',
      id: 'part-question',
      messageID: 'message-3',
      callID: 'call-2',
      question: {
        prompt: 'Stringified prompt',
        description: undefined,
        options: ['A', 'B'],
        richOptions: undefined,
        multiple: false,
        custom: true,
        answer: undefined,
        rawInput
      }
    })
  })

  it('falls back through alternative question text fields', () => {
    expect(
      mapOpenCodePart({
        type: 'tool',
        id: 'part-question',
        messageID: 'message-3',
        callID: 'call-2',
        tool: 'ask',
        state: {
          status: 'running',
          input: {
            question: 'Asked via question field',
            text: 'Ignored text field'
          }
        }
      })
    ).toEqual(
      expect.objectContaining({
        type: 'question',
        question: expect.objectContaining({
          prompt: 'Asked via question field'
        })
      })
    )
  })

  it('extracts richOptions from the richOptions field', () => {
    const input = {
      prompt: 'Pick a flavor',
      richOptions: [
        { label: 'Vanilla', description: 'Classic' },
        { label: 'Chocolate', description: 'Rich' }
      ]
    }
    expect(
      mapOpenCodePart({
        type: 'tool',
        id: 'part-question',
        messageID: 'message-3',
        callID: 'call-2',
        tool: 'question',
        state: {
          status: 'running',
          input
        }
      })
    ).toEqual({
      type: 'question',
      id: 'part-question',
      messageID: 'message-3',
      callID: 'call-2',
      question: {
        prompt: 'Pick a flavor',
        description: undefined,
        options: ['Vanilla', 'Chocolate'],
        richOptions: [
          { label: 'Vanilla', description: 'Classic' },
          { label: 'Chocolate', description: 'Rich' }
        ],
        multiple: false,
        custom: true,
        answer: undefined,
        rawInput: JSON.stringify(input)
      }
    })
  })

  it('rejects unsupported parts', () => {
    expect(mapOpenCodePart({ type: 'unknown' })).toBeNull()
  })
})

describe('OpenCode token usage normalization', () => {
  it('maps reported categories into normalized usage and preserves the raw total', () => {
    expect(
      mapOpenCodePart({
        type: 'step-finish',
        id: 'part-finish',
        messageID: 'message-1',
        reason: 'stop',
        tokens: { input: 100, output: 30, reasoning: 10, total: 130, cache: { read: 40, write: 5 } }
      })
    ).toEqual({
      type: 'step-finish',
      id: 'part-finish',
      messageID: 'message-1',
      reason: 'stop',
      tokens: {
        input: 100,
        output: 30,
        reasoning: 10,
        cacheRead: 40,
        cacheWrite: 5,
        total: 130
      },
      normalizedUsage: {
        uncachedInput: 100,
        cachedInput: 40,
        cacheWrite: 5,
        output: 30,
        reasoning: 10,
        rawProviderUsage: {
          input: 100,
          output: 30,
          reasoning: 10,
          total: 130,
          cache: { read: 40, write: 5 }
        },
        rawTotal: 130,
        totalSemantics: 'provider_defined'
      }
    })
  })

  it('does not synthesize a comparable total when the provider reports none', () => {
    expect(
      mapOpenCodePart({
        type: 'step-finish',
        id: 'part-finish',
        messageID: 'message-1',
        reason: 'stop',
        tokens: { input: 100, output: 30, cache: { read: 40 } }
      })
    ).toEqual({
      type: 'step-finish',
      id: 'part-finish',
      messageID: 'message-1',
      reason: 'stop',
      normalizedUsage: {
        uncachedInput: 100,
        cachedInput: 40,
        cacheWrite: null,
        output: 30,
        reasoning: null,
        rawProviderUsage: { input: 100, output: 30, cache: { read: 40 } },
        rawTotal: null,
        totalSemantics: 'unavailable'
      }
    })
  })

  it('keeps unreported categories null while preserving a reported total', () => {
    expect(
      mapOpenCodePart({
        type: 'step-finish',
        id: 'part-finish',
        messageID: 'message-1',
        reason: 'stop',
        tokens: { input: 50, total: 50 }
      })
    ).toEqual({
      type: 'step-finish',
      id: 'part-finish',
      messageID: 'message-1',
      reason: 'stop',
      tokens: { input: 50, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 50 },
      normalizedUsage: {
        uncachedInput: 50,
        cachedInput: null,
        cacheWrite: null,
        output: null,
        reasoning: null,
        rawProviderUsage: { input: 50, total: 50 },
        rawTotal: 50,
        totalSemantics: 'provider_defined'
      }
    })
  })

  it('keeps uncached input separate when cache reads and writes exceed it', () => {
    expect(
      mapOpenCodePart({
        type: 'step-finish',
        id: 'part-finish',
        messageID: 'message-1',
        reason: 'stop',
        tokens: { input: 10, output: 5, total: 15, cache: { read: 8, write: 9 } }
      })
    ).toEqual({
      type: 'step-finish',
      id: 'part-finish',
      messageID: 'message-1',
      reason: 'stop',
      tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 8, cacheWrite: 9, total: 15 },
      normalizedUsage: {
        uncachedInput: 10,
        cachedInput: 8,
        cacheWrite: 9,
        output: 5,
        reasoning: null,
        rawProviderUsage: { input: 10, output: 5, total: 15, cache: { read: 8, write: 9 } },
        rawTotal: 15,
        totalSemantics: 'provider_defined'
      }
    })
  })

  it('attaches no usage metadata when the provider reports no tokens', () => {
    expect(
      mapOpenCodePart({
        type: 'step-finish',
        id: 'part-finish',
        messageID: 'message-1',
        reason: 'stop',
        tokens: {}
      })
    ).toEqual({
      type: 'step-finish',
      id: 'part-finish',
      messageID: 'message-1',
      reason: 'stop'
    })
  })
})

describe('mapOpenCodeEvent', () => {
  it('maps updated parts and derives the session ID from the part', () => {
    expect(
      mapOpenCodeEvent('message.part.updated', {
        part: {
          type: 'text',
          id: 'part-1',
          messageID: 'message-1',
          sessionID: 'session-from-part',
          text: 'hello'
        }
      })
    ).toEqual([
      {
        type: 'message.part.updated',
        sessionId: 'session-from-part',
        part: {
          type: 'text',
          id: 'part-1',
          messageID: 'message-1',
          text: 'hello'
        }
      }
    ])
  })

  it('maps deltas without changing session, message, or part IDs', () => {
    expect(
      mapOpenCodeEvent('message.part.delta', {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        field: 'text',
        delta: 'token'
      })
    ).toEqual([
      {
        type: 'message.part.delta',
        sessionId: 'session-1',
        messageId: 'message-1',
        partId: 'part-1',
        field: 'text',
        delta: 'token'
      }
    ])
  })

  it('emits completion only for terminal message updates', () => {
    expect(
      mapOpenCodeEvent('message.updated', {
        info: {
          id: 'message-1',
          sessionID: 'session-1',
          time: { created: 10 }
        }
      })
    ).toEqual([])

    expect(
      mapOpenCodeEvent('message.updated', {
        info: {
          id: 'message-1',
          sessionID: 'session-1',
          time: { created: 10, completed: 20 }
        }
      })
    ).toEqual([
      {
        type: 'message.completed',
        sessionId: 'session-1',
        messageId: 'message-1',
        error: undefined
      }
    ])
  })

  it('maps message failures as completed messages with their IDs', () => {
    expect(
      mapOpenCodeEvent('message.updated', {
        info: {
          id: 'message-failed',
          sessionID: 'session-failed',
          error: { message: 'model unavailable' }
        }
      })
    ).toEqual([
      {
        type: 'message.completed',
        sessionId: 'session-failed',
        messageId: 'message-failed',
        error: 'model unavailable',
        issue: {
          kind: 'provider_unavailable',
          message: 'model unavailable',
          harnessId: 'opencode',
          retryable: false
        }
      }
    ])
  })

  it('maps session idle and structured or string errors', () => {
    expect(mapOpenCodeEvent('session.idle', { sessionID: 'session-idle' })).toEqual([
      { type: 'session.idle', sessionId: 'session-idle' }
    ])
    expect(
      mapOpenCodeEvent('session.error', {
        sessionID: 'session-error',
        error: { message: 'stream failed' }
      })
    ).toEqual([
      {
        type: 'session.error',
        sessionId: 'session-error',
        error: 'stream failed',
        issue: {
          kind: 'unknown',
          message: 'stream failed',
          harnessId: 'opencode',
          retryable: false
        }
      }
    ])
    expect(
      mapOpenCodeEvent('session.error', {
        sessionID: 'session-error',
        error: 'connection lost'
      })
    ).toEqual([
      {
        type: 'session.error',
        sessionId: 'session-error',
        error: 'connection lost',
        issue: {
          kind: 'network',
          message: 'connection lost',
          harnessId: 'opencode',
          retryable: false
        }
      }
    ])
  })

  it('drops abort errors from session.error so aborted turns never error the session', () => {
    expect(
      mapOpenCodeEvent('session.error', {
        sessionID: 'session-error',
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } }
      })
    ).toEqual([])
    expect(
      mapOpenCodeEvent('session.error', {
        sessionID: 'session-error',
        error: { name: 'DOMException', message: 'The operation was aborted.' }
      })
    ).toEqual([])
  })

  it('maps permission requests without changing session or request IDs', () => {
    expect(
      mapOpenCodeEvent('permission.asked', {
        id: 'request-1',
        sessionID: 'session-1',
        permission: 'edit',
        patterns: ['src/**', 42],
        metadata: { path: 'src/main.ts' }
      })
    ).toEqual([
      {
        type: 'permission.asked',
        sessionId: 'session-1',
        permission: {
          id: 'request-1',
          sessionId: 'session-1',
          permission: 'edit',
          patterns: ['src/**'],
          metadata: { path: 'src/main.ts' }
        }
      }
    ])
  })

  it('maps permission replies without changing the request ID', () => {
    expect(
      mapOpenCodeEvent('permission.replied', {
        sessionID: 'session-1',
        requestID: 'request-1',
        reply: 'reject'
      })
    ).toEqual([
      {
        type: 'permission.replied',
        sessionId: 'session-1',
        requestId: 'request-1',
        reply: 'reject'
      }
    ])
  })
})

describe('opencodePermissionTools', () => {
  const settings = (permissionLevel: 'auto_review' | 'full_access') =>
    ({
      harnessId: 'opencode',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      thinkingLevel: 'medium',
      permissionLevel,
      engineeringMode: false
    }) as const

  it('maps full_access to an allow-all bypass so nothing is asked or denied', () => {
    expect(
      opencodePermissionTools({ settings: settings('full_access'), allowedTools: undefined })
    ).toEqual({
      '*': true
    })
    expect(
      opencodePermissionTools({ settings: settings('full_access'), allowedTools: ['read', 'bash'] })
    ).toEqual({ '*': true })
  })

  it('auto-approves external directories while keeping the app allow-list restrictive', () => {
    expect(
      opencodePermissionTools({ settings: settings('auto_review'), allowedTools: ['read', 'glob'] })
    ).toEqual({
      '*': false,
      read: true,
      glob: true,
      external_directory: true
    })
  })

  it('auto-approves external directories when no tool allow-list is set', () => {
    expect(
      opencodePermissionTools({ settings: settings('auto_review'), allowedTools: undefined })
    ).toEqual({
      external_directory: true
    })
  })

  it('keeps an empty allow-list fully restrictive for auto_review', () => {
    expect(
      opencodePermissionTools({ settings: settings('auto_review'), allowedTools: [] })
    ).toEqual({
      '*': false,
      external_directory: true
    })
  })
})
