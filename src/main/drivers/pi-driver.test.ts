import { EventEmitter } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { StorageEngine } from '../storage-engine'
import { PiDriver, mapPiRecord } from './pi-driver'
import type { CliLineParseContext, PersistentCliSession } from './persistent-cli-driver'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>()
  return { ...original, spawn: spawnMock }
})

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { write: vi.fn(), end: vi.fn() }
  killed = false
  kill(): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

const roots: string[] = []
afterEach(async () => {
  spawnMock.mockReset()
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
  it('runs new and resumed turns with JSON mode, provider, model, and thinking level', async () => {
    const driver = new PiDriver(await storage())
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Pi')
    await driver.sendPrompt('/project', { sessionId, settings, text: 'first', attachments: [] })
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      '--mode',
      'json',
      '-p',
      '--provider',
      'lmstudio',
      '--model',
      'qwen/qwen3.5-9b',
      '--thinking',
      'medium',
      'first'
    ])
    child.stdout.emit('data', Buffer.from('{"type":"session","id":"native-1"}\n'))
    child.emit('exit', 0, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await driver.sendPrompt('/project', {
      sessionId,
      settings: { ...settings, thinkingLevel: 'max' },
      text: 'second',
      attachments: []
    })
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '--mode',
      'json',
      '-p',
      '--session-id',
      'native-1',
      '--provider',
      'lmstudio',
      '--model',
      'qwen/qwen3.5-9b',
      '--thinking',
      'xhigh',
      'second'
    ])
  })

  it('restricts Pi to read-only tools and appends the system prompt for read-only turns', async () => {
    const driver = new PiDriver(await storage())
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Pi')
    await driver.sendPrompt('/project', {
      sessionId,
      settings,
      text: 'inspect',
      attachments: [],
      readOnly: true,
      systemPrompt: 'Be surgical.'
    })
    expect(spawnMock.mock.calls[0]?.[1]).toContain('--tools')
    expect(spawnMock.mock.calls[0]?.[1]).toContain('read,grep,find,ls')
    expect(spawnMock.mock.calls[0]?.[1]).toContain('--append-system-prompt')
    expect(spawnMock.mock.calls[0]?.[1]).toContain('Be surgical.')
    child.emit('exit', 0, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('maps Pi JSONL events into assistant messages, deltas, and tool states', async () => {
    const driver = new PiDriver(await storage())
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Pi')
    await driver.sendPrompt('/project', { sessionId, settings, text: 'go', attachments: [] })
    child.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"session","id":"native-9"}',
          '{"type":"turn_start"}',
          '{"type":"message_start","message":{"role":"assistant","content":[]}}',
          '{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}',
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}],"usage":{"input":10,"output":5,"cacheRead":2,"cacheWrite":1,"cost":{"total":0.001}}}}',
          '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"ls"}}]},"toolResults":[{"toolCallId":"call-1","toolName":"bash","content":[{"type":"text","text":"out"}],"isError":false}]}'
        ].join('\n') + '\n'
      )
    )
    child.emit('exit', 0, null)
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
