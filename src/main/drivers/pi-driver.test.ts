import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageEngine } from '../storage-engine'
import { PiDriver, mapPiRecord } from './pi-driver'
import type { CliLineParseContext, PersistentCliSession } from './persistent-cli-driver'

const sdkMock = vi.hoisted(() => {
  const createCalls: Array<Record<string, unknown>> = []
  const loaderOptions: Array<Record<string, unknown>> = []
  const sessions: Array<{
    sessionId: string
    model: { id: string; provider: string }
    prompt: ReturnType<typeof vi.fn>
    steer: ReturnType<typeof vi.fn>
    abort: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    setModel: ReturnType<typeof vi.fn>
    setThinkingLevel: ReturnType<typeof vi.fn>
    emit: (event: unknown) => void
  }> = []
  const runtime = {
    getModel: vi.fn((provider: string, model: string) => ({ id: model, provider })),
    getModels: vi.fn(() => []),
    registerProvider: vi.fn(),
    setRuntimeApiKey: vi.fn()
  }
  const createAgentSession = vi.fn(async (options: Record<string, unknown>) => {
    createCalls.push(options)
    const listeners = new Set<(event: unknown) => void>()
    const session = {
      sessionId: `native-${sessions.length + 1}`,
      model: { id: 'qwen/qwen3.5-9b', provider: 'lmstudio' },
      prompt: vi.fn(async () => undefined),
      steer: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
      setModel: vi.fn(async (model: { id: string; provider: string }) => {
        session.model = model
      }),
      setThinkingLevel: vi.fn(),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
      emit: (event: unknown) => {
        for (const listener of listeners) listener(event)
      }
    }
    sessions.push(session)
    return { session }
  })
  return { createAgentSession, createCalls, loaderOptions, runtime, sessions }
})

vi.mock('@earendil-works/pi-coding-agent', () => {
  class DefaultResourceLoader {
    static options: unknown[] = []
    constructor(options: Record<string, unknown>) {
      DefaultResourceLoader.options.push(options)
      sdkMock.loaderOptions.push(options)
    }
    async reload(): Promise<void> {}
  }
  return {
    createAgentSession: sdkMock.createAgentSession,
    DefaultResourceLoader,
    getAgentDir: () => '/agent',
    ModelRuntime: { create: vi.fn(async () => sdkMock.runtime) },
    SessionManager: { inMemory: vi.fn(() => ({ kind: 'memory' })) }
  }
})

const roots: string[] = []
afterEach(async () => {
  sdkMock.createAgentSession.mockClear()
  sdkMock.createCalls.splice(0)
  sdkMock.loaderOptions.splice(0)
  sdkMock.runtime.getModel.mockClear()
  sdkMock.runtime.getModels.mockClear()
  sdkMock.runtime.registerProvider.mockClear()
  sdkMock.runtime.setRuntimeApiKey.mockClear()
  sdkMock.sessions.splice(0)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storage(): Promise<StorageEngine> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-pi-driver-'))
  roots.push(root)
  const value = new StorageEngine(root)
  await value.initialize()
  return value
}

const settings = {
  harnessId: 'pi',
  providerId: 'lmstudio',
  modelId: 'qwen/qwen3.5-9b',
  thinkingLevel: 'medium' as const,
  permissionLevel: 'auto_review' as const,
  engineeringMode: false
}

function sessionContext(
  sessionId: string,
  messages: PersistentCliSession['messages'] = []
): CliLineParseContext {
  const now = Date.now()
  return {
    session: {
      id: sessionId,
      title: 'Pi',
      projectPathHash: 'x',
      messages,
      createdAt: now,
      updatedAt: now
    },
    sessionId
  }
}

describe('PiDriver', () => {
  it('runs multiple logical sessions in one embedded model runtime', async () => {
    const driver = new PiDriver(await storage())
    const first = await driver.createSession('/project', 'First')
    const second = await driver.createSession('/project', 'Second')
    await Promise.all([
      driver.sendPrompt('/project', { sessionId: first, settings, text: 'first', attachments: [] }),
      driver.sendPrompt('/project', {
        sessionId: second,
        settings,
        text: 'second',
        attachments: []
      })
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sdkMock.createAgentSession).toHaveBeenCalledTimes(2)
    expect(sdkMock.createCalls[0]?.['modelRuntime']).toBe(sdkMock.runtime)
    expect(sdkMock.createCalls[1]?.['modelRuntime']).toBe(sdkMock.runtime)
    expect(sdkMock.sessions[0]?.prompt).toHaveBeenCalledWith('first', { source: 'rpc' })
    expect(sdkMock.sessions[1]?.prompt).toHaveBeenCalledWith('second', { source: 'rpc' })
  })

  it('restricts embedded Pi to read-only tools and scopes its system prompt', async () => {
    const driver = new PiDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Pi')
    await driver.sendPrompt('/project', {
      sessionId,
      settings,
      text: 'inspect',
      attachments: [],
      readOnly: true,
      systemPrompt: 'Be surgical.'
    })
    const options = sdkMock.createCalls[0]
    expect(options?.['tools']).toEqual(['read', 'grep', 'find', 'ls'])
    expect(sdkMock.loaderOptions).toContainEqual(
      expect.objectContaining({ appendSystemPrompt: ['Be surgical.'] })
    )
  })

  it('maps embedded Pi events into assistant messages, deltas, and tool states', async () => {
    const driver = new PiDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Pi')
    await driver.sendPrompt('/project', { sessionId, settings, text: 'go', attachments: [] })
    const sdkSession = sdkMock.sessions[0]
    sdkSession?.emit({ type: 'turn_start' })
    sdkSession?.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    sdkSession?.emit({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' }
    })
    sdkSession?.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello world' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }
        ],
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.001 } }
      }
    })
    sdkSession?.emit({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }]
      },
      toolResults: [
        {
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'out' }],
          isError: false
        }
      ]
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = await driver.loadMessages('/project', sessionId)
    const assistant = messages.find((message) => message.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant?.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Hello world' })
    )
    expect(assistant?.tokens).toEqual({
      input: 10,
      output: 5,
      reasoning: 0,
      cacheRead: 2,
      cacheWrite: 1,
      total: 18
    })
    const tool = assistant?.parts.find((part) => part.type === 'tool' && part.callID === 'call-1')
    expect(tool).toMatchObject({ type: 'tool', tool: 'bash', callID: 'call-1' })
    if (tool && tool.type === 'tool') {
      expect(tool.state.status).toBe('completed')
      expect(tool.state.output).toBe('out')
    }
  })

  it('reports a failed turn as a session error from agent_end', () => {
    const state = { assistantMessageId: null, turnIndex: 1 }
    const result = mapPiRecord(
      {
        type: 'agent_end',
        willRetry: false,
        messages: [
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'rate limit exceeded'
          }
        ]
      },
      sessionContext('s-1'),
      state
    )
    expect(result?.events).toContainEqual(
      expect.objectContaining({ type: 'session.error', error: 'rate limit exceeded' })
    )
  })
})
