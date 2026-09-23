import { describe, expect, it } from 'vitest'
import {
  parseOpenCodeV2SseFrame,
  splitOpenCodeV2SseBuffer
} from '../../../src/main/opencode-v2/opencode-v2-client'
import { parseOpenCodeV2Handshake } from '../../../src/main/opencode-v2/opencode-v2-server'
import {
  mapOpenCodeV2Catalogs,
  openCodeV2ModelVariants
} from '../../../src/main/drivers/opencode-v2/v2-catalog'
import { mapOpenCodeV2Event } from '../../../src/main/drivers/opencode-v2/v2-events'
import {
  buildOpenCodeV2FormReply,
  mapOpenCodeV2FormToQuestionRequest,
  mapOpenCodeV2PendingForms
} from '../../../src/main/drivers/opencode-v2/v2-forms'
import {
  mapOpenCodeV2AssistantContent,
  mapOpenCodeV2Message,
  mapOpenCodeV2Messages,
  reasoningPartId,
  textPartId,
  toolPartId
} from '../../../src/main/drivers/opencode-v2/v2-messages'
import {
  buildOpenCodeV2PermissionRuleset,
  buildOpenCodeV2PromptBody
} from '../../../src/main/drivers/opencode-v2/v2-prompt'
import { mapOpenCodeV2Usage } from '../../../src/main/drivers/opencode-v2/v2-usage'
import { permissionMapToRuleset } from '../../../src/main/drivers/opencode-v2/v2-agents'

/** Wrap one V2 event payload in the live SSE envelope shape. */
function sseEvent(type: string, data: Record<string, unknown>) {
  return { type, data, envelope: { id: 'evt_1', type, data } }
}

describe('opencode v2 handshake', () => {
  it('accepts a server that only announces its endpoint when the password was supplied', () => {
    const announced = 'server listening on http://127.0.0.1:50725'
    expect(parseOpenCodeV2Handshake(announced)).toBeNull()
    expect(parseOpenCodeV2Handshake(announced, 'chosen-secret')).toEqual({
      baseUrl: 'http://127.0.0.1:50725',
      password: 'chosen-secret'
    })
  })
})

describe('opencode v2 SSE frames', () => {
  it('splits complete frames, keeps a partial tail, and ignores heartbeats', () => {
    const buffer =
      ': heartbeat\n\ndata: {"type":"session.text.delta","data":{"delta":"po"}}\n\ndata: {"type":"sess'
    const { frames, rest } = splitOpenCodeV2SseBuffer(buffer)
    expect(frames).toHaveLength(2)
    expect(rest).toBe('data: {"type":"sess')
    expect(parseOpenCodeV2SseFrame(frames[0] ?? '')).toBeNull()
    expect(parseOpenCodeV2SseFrame(frames[1] ?? '')).toEqual({
      type: 'session.text.delta',
      data: { delta: 'po' },
      envelope: { type: 'session.text.delta', data: { delta: 'po' } }
    })
  })

  it('rejects a frame whose payload is not a typed event', () => {
    expect(parseOpenCodeV2SseFrame('data: {"data":{}}')).toBeNull()
    expect(parseOpenCodeV2SseFrame('data: not-json')).toBeNull()
  })
})

describe('opencode v2 usage', () => {
  it('folds disjoint reasoning into output and stays honest about the missing total', () => {
    const { aggregateTokens, normalizedUsage } = mapOpenCodeV2Usage({
      input: 100,
      output: 20,
      reasoning: 5,
      cache: { read: 40, write: 2 }
    })
    expect(aggregateTokens).toEqual({
      input: 100,
      output: 25,
      reasoning: 5,
      cacheRead: 40,
      cacheWrite: 2,
      total: 167
    })
    // V2 reports no total of its own, so the canonical contract must not claim
    // a provider-defined one.
    expect(normalizedUsage?.rawTotal).toBeNull()
    expect(normalizedUsage?.totalSemantics).toBe('unavailable')
    expect(normalizedUsage?.uncachedInput).toBe(100)
  })

  it('reports nothing when the payload carries no token category', () => {
    expect(mapOpenCodeV2Usage({}).aggregateTokens).toBeUndefined()
    expect(mapOpenCodeV2Usage(undefined).normalizedUsage).toBeUndefined()
  })
})

describe('opencode v2 messages', () => {
  it('maps assistant content inline, with part ids that match the live stream', () => {
    const parts = mapOpenCodeV2AssistantContent('msg_1', [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
      {
        type: 'tool',
        id: 'call_1',
        name: 'shell',
        state: {
          status: 'completed',
          input: { command: 'echo hi' },
          content: [{ type: 'text', text: 'hi\n' }]
        }
      }
    ])
    expect(parts.map((part) => part.id)).toEqual([
      reasoningPartId('msg_1', 0),
      textPartId('msg_1', 0),
      toolPartId('msg_1', 'call_1')
    ])
    const tool = parts[2]
    expect(tool?.type).toBe('tool')
    if (tool?.type !== 'tool') throw new Error('expected a tool part')
    expect(tool.tool).toBe('shell')
    expect(tool.state.status).toBe('completed')
    expect(tool.state.output).toBe('hi\n')
  })

  it('carries cost, tokens, and a completed time onto the assistant message', () => {
    const message = mapOpenCodeV2Message({
      id: 'msg_2',
      type: 'assistant',
      time: { created: 10, completed: 20 },
      agent: 'build',
      model: { id: 'big-pickle', providerID: 'opencode' },
      cost: 0.5,
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 0 } },
      content: [{ type: 'text', text: 'done' }]
    })
    expect(message?.completedAt).toBe(20)
    expect(message?.cost).toBe(0.5)
    expect(message?.tokens?.total).toBe(10)
    expect(message?.modelId).toBe('big-pickle')
    expect(message?.error).toBeUndefined()
  })

  it('hides non-conversation context and drops message types that carry none', () => {
    const hidden = mapOpenCodeV2Message({
      id: 'msg_3',
      type: 'synthetic',
      time: { created: 5 },
      text: 'system context'
    })
    expect(hidden?.visibility).toBe('hidden')
    expect(hidden?.parts).toEqual([])
    expect(hidden?.transportParts?.[0]).toMatchObject({ type: 'text', text: 'system context' })
    expect(mapOpenCodeV2Message({ id: 'msg_4', type: 'idle', time: { created: 1 } })).toBeNull()
    expect(
      mapOpenCodeV2Message({
        id: 'msg_5',
        type: 'agent-switched',
        time: { created: 1 },
        agent: 'a'
      })
    ).toBeNull()
  })

  it('does not surface an interrupt as a message error', () => {
    const message = mapOpenCodeV2Message({
      id: 'msg_6',
      type: 'assistant',
      time: { created: 1, completed: 2 },
      agent: 'build',
      model: { id: 'm', providerID: 'p' },
      finish: 'error',
      error: { type: 'aborted', message: 'Step interrupted' },
      content: []
    })
    expect(message?.error).toBeUndefined()

    const failed = mapOpenCodeV2Message({
      id: 'msg_7',
      type: 'assistant',
      time: { created: 1 },
      agent: 'build',
      model: { id: 'm', providerID: 'p' },
      finish: 'error',
      error: { type: 'provider.no-route', message: 'Model unavailable' },
      content: []
    })
    expect(failed?.error).toBe('Model unavailable')
  })

  it('maps a message page envelope and ignores unmappable entries', () => {
    const messages = mapOpenCodeV2Messages({
      data: [
        { id: 'msg_8', type: 'user', time: { created: 1 }, text: 'hello' },
        { id: 'msg_9', type: 'idle', time: { created: 2 }, outcome: 'succeeded' }
      ],
      cursor: { previous: null, next: null }
    })
    expect(messages.map((message) => message.id)).toEqual(['msg_8'])
    expect(messages[0]?.parts[0]).toMatchObject({ type: 'text', text: 'hello' })
  })
})

describe('opencode v2 events', () => {
  it('maps text and reasoning deltas onto stable part ids', () => {
    const textDelta = mapOpenCodeV2Event(
      sseEvent('session.text.delta', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_1',
        ordinal: 0,
        delta: 'po'
      })
    )
    expect(textDelta).toEqual([
      {
        type: 'message.part.delta',
        sessionId: 'ses_1',
        messageId: 'msg_1',
        partId: textPartId('msg_1', 0),
        field: 'text',
        delta: 'po'
      }
    ])

    const reasoningEnd = mapOpenCodeV2Event(
      sseEvent('session.reasoning.ended', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_1',
        ordinal: 0,
        text: 'because'
      })
    )
    expect(reasoningEnd[0]).toMatchObject({
      type: 'message.part.updated',
      part: { type: 'reasoning', id: reasoningPartId('msg_1', 0), text: 'because' }
    })
  })

  it('uses the remembered tool name for results that do not carry one', () => {
    const events = mapOpenCodeV2Event(
      sseEvent('session.tool.success', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_1',
        id: 'call_1',
        content: [{ type: 'text', text: 'ok' }],
        executed: false
      }),
      { toolNames: new Map([['call_1', 'shell']]) }
    )
    expect(events[0]).toMatchObject({
      type: 'message.part.updated',
      part: {
        type: 'tool',
        id: toolPartId('msg_1', 'call_1'),
        tool: 'shell',
        state: { status: 'completed', output: 'ok' }
      }
    })
  })

  it('maps step ends into usage plus a step-finish part', () => {
    const events = mapOpenCodeV2Event(
      sseEvent('session.step.ended', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_1',
        finish: 'stop',
        cost: 0,
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 0, write: 0 } }
      })
    )
    expect(events[0]).toMatchObject({ type: 'usage.updated', sessionId: 'ses_1' })
    expect(events[1]).toMatchObject({
      type: 'message.part.updated',
      part: { type: 'step-finish', reason: 'stop' }
    })
  })

  it('maps permissions, questions, and execution status', () => {
    const permission = mapOpenCodeV2Event(
      sseEvent('permission.asked', {
        id: 'per_1',
        sessionID: 'ses_1',
        action: 'read',
        resources: ['.env'],
        save: ['*']
      })
    )
    expect(permission[0]).toMatchObject({
      type: 'permission.asked',
      permission: { id: 'per_1', permission: 'read', patterns: ['.env'] }
    })

    const replied = mapOpenCodeV2Event(
      sseEvent('permission.replied', { sessionID: 'ses_1', requestID: 'per_1', reply: 'always' })
    )
    expect(replied[0]).toEqual({
      type: 'permission.replied',
      sessionId: 'ses_1',
      requestId: 'per_1',
      reply: 'always'
    })

    const asked = mapOpenCodeV2Event(
      sseEvent('form.created', {
        form: {
          id: 'frm_1',
          sessionID: 'ses_1',
          title: 'Questions',
          metadata: { kind: 'question', tool: { messageID: 'msg_1', id: 'call_1' } },
          fields: [
            {
              key: 'q0',
              title: 'Colour',
              description: 'Which colour?',
              type: 'string',
              options: [
                { value: 'Red', label: 'Red' },
                { value: 'Blue', label: 'Blue' }
              ],
              custom: true
            }
          ]
        }
      })
    )
    expect(asked[0]).toMatchObject({
      type: 'question.asked',
      requestId: 'frm_1',
      questions: [{ prompt: 'Which colour?', header: 'Colour', options: ['Red', 'Blue'] }]
    })

    const started = mapOpenCodeV2Event(
      sseEvent('session.execution.started', { sessionID: 'ses_1' })
    )
    expect(started[0]).toMatchObject({ type: 'session.status', status: { state: 'working' } })
    // The three terminal events are the driver's own business: they need the
    // message id and last step error it tracks.
    expect(
      mapOpenCodeV2Event(sseEvent('session.execution.succeeded', { sessionID: 'ses_1' }))
    ).toEqual([])
  })
})

describe('opencode v2 forms', () => {
  const form = {
    id: 'frm_1',
    sessionID: 'ses_1',
    title: 'Questions',
    metadata: { kind: 'question' },
    fields: [
      {
        key: 'q0',
        title: 'Colour',
        description: 'Which colour?',
        type: 'string',
        options: [{ value: 'blue', label: 'Blue', description: 'You prefer blue' }],
        custom: true
      },
      { key: 'q1', type: 'boolean', title: 'Sure?' },
      { key: 'q2', type: 'integer', title: 'How many?' }
    ]
  }

  it('maps a form into a pending question request', () => {
    const request = mapOpenCodeV2FormToQuestionRequest(form)
    expect(request?.requestId).toBe('frm_1')
    expect(request?.questions).toHaveLength(3)
    expect(request?.questions[0]?.richOptions?.[0]).toMatchObject({
      label: 'Blue',
      description: 'You prefer blue'
    })
    expect(request?.questions[1]?.options).toEqual(['Yes', 'No'])
    expect(mapOpenCodeV2PendingForms({ data: [form] })).toHaveLength(1)
    expect(mapOpenCodeV2FormToQuestionRequest({ ...form, fields: [] })).toBeNull()
  })

  it('replies with the option value, not its label, and types every field', () => {
    const reply = buildOpenCodeV2FormReply(form, [['Blue'], ['yes'], ['3']])
    expect(reply.answer).toEqual({ q0: 'blue', q1: true, q2: 3 })
    expect(() => buildOpenCodeV2FormReply(form, [[], [], ['not-a-number']])).toThrow(
      /must be a number/
    )
  })
})

describe('opencode v2 permission rules', () => {
  const settings = (permissionLevel: 'full_access' | 'auto_review') =>
    ({ permissionLevel }) as Parameters<typeof buildOpenCodeV2PermissionRuleset>[0]['settings']

  it('allows everything for full access', () => {
    expect(buildOpenCodeV2PermissionRuleset({ settings: settings('full_access') })).toEqual([
      { action: '*', resource: '*', effect: 'allow' }
    ])
  })

  it('never denies read or emits a catch-all deny, which break the harness', () => {
    // Verified live: a `*` deny or a `read` deny makes every v2 turn fail with
    // `provider.auth` 403, because the harness evaluates its own internal
    // actions through the same ruleset.
    const rules = buildOpenCodeV2PermissionRuleset({
      settings: settings('auto_review'),
      allowedTools: ['read', 'grep', 'write']
    })
    expect(rules.some((rule) => rule.action === '*' && rule.effect === 'deny')).toBe(false)
    expect(rules.some((rule) => rule.action === 'read' && rule.effect === 'deny')).toBe(false)
    expect(rules).toContainEqual({ action: 'bash', resource: '*', effect: 'deny' })
    // `write` is expressed as v2's `edit`, and it must come after the denies.
    expect(rules).toContainEqual({ action: 'edit', resource: '*', effect: 'allow' })
    expect(rules.at(-1)).toEqual({ action: 'external_directory', resource: '*', effect: 'allow' })
  })

  it('leaves the allow-list open when the turn states none', () => {
    expect(buildOpenCodeV2PermissionRuleset({ settings: settings('auto_review') })).toEqual([
      { action: 'external_directory', resource: '*', effect: 'allow' }
    ])
  })

  it('expands a lean agent catch-all deny into explicit tool denies', () => {
    const rules = permissionMapToRuleset({
      '*': 'deny',
      read: 'deny',
      webfetch: 'allow',
      bash: { '*': 'deny', 'curl *': 'allow' }
    })
    expect(rules.some((rule) => rule.action === '*')).toBe(false)
    expect(rules.some((rule) => rule.action === 'read')).toBe(false)
    expect(rules).toContainEqual({ action: 'webfetch', resource: '*', effect: 'allow' })
    expect(rules).toEqual(
      expect.arrayContaining([
        { action: 'bash', resource: '*', effect: 'deny' },
        { action: 'bash', resource: 'curl *', effect: 'allow' }
      ])
    )
    // The scoped allow must come after the catch-all deny for it to win.
    expect(rules.findIndex((rule) => rule.action === 'bash')).toBeGreaterThan(
      rules.findIndex((rule) => rule.action === 'edit')
    )
  })
})

describe('opencode v2 catalog', () => {
  it('groups models by provider and keeps the picker fields', () => {
    const catalogs = mapOpenCodeV2Catalogs(
      {
        data: [
          {
            id: 'm1',
            modelID: 'm1',
            providerID: 'p1',
            name: 'Model One',
            capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
            variants: [{ id: 'high' }],
            limit: { context: 1000, output: 100 },
            status: 'active',
            enabled: true
          },
          {
            id: 'm2',
            modelID: 'm2',
            providerID: 'p2',
            name: 'Model Two',
            capabilities: { tools: false, input: ['text'], output: ['text'] },
            variants: [],
            limit: { context: 2000, output: 200 },
            status: 'active',
            enabled: true
          }
        ]
      },
      { data: [{ id: 'p1', name: 'Provider One', activation: 'enabled' }] }
    )
    expect(catalogs.map((catalog) => catalog.id).sort()).toEqual(['p1', 'p2'])
    const p1 = catalogs.find((catalog) => catalog.id === 'p1')
    expect(p1?.name).toBe('Provider One')
    expect(p1?.models[0]).toMatchObject({
      id: 'm1',
      providerId: 'p1',
      toolcall: true,
      attachment: true,
      contextWindow: 1000,
      thinkingPresets: [{ id: 'high', label: 'High', description: 'high reasoning effort' }]
    })
    expect(p1?.harnessId).toBe('opencode')
  })

  it('drops models of a disabled provider and reads declared variants', () => {
    const payload = {
      data: [
        {
          id: 'm1',
          modelID: 'm1',
          providerID: 'p1',
          name: 'M1',
          capabilities: { tools: true, input: ['text'], output: ['text'] },
          variants: [{ id: 'low' }],
          limit: { context: 1, output: 1 }
        }
      ]
    }
    expect(
      mapOpenCodeV2Catalogs(payload, { data: [{ id: 'p1', activation: 'disabled' }] })
    ).toEqual([])
    expect(openCodeV2ModelVariants(payload).get('p1/m1')).toEqual(new Set(['low']))
  })
})

describe('opencode v2 prompt bodies', () => {
  it('only states text, files, delivery, and an optional message id', () => {
    expect(
      buildOpenCodeV2PromptBody({
        text: 'hello',
        files: [{ uri: 'file:///tmp/a.png', name: 'a.png' }],
        userMessageId: 'msg_1'
      })
    ).toEqual({
      id: 'msg_1',
      text: 'hello',
      files: [{ uri: 'file:///tmp/a.png', name: 'a.png' }],
      delivery: 'steer'
    })
  })
})
