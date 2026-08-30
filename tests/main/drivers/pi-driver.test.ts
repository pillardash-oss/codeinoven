import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { PiDriver, mapPiRecord } from '../../../src/main/drivers/pi-driver'
import {
  PI_STATUS_EXTENSION_KEY,
  PI_STATUS_IDLE,
  PI_STATUS_WORKING
} from '../../../src/main/drivers/pi-status-extension'
import type {
  CliLineParseContext,
  PersistentCliSession
} from '../../../src/main/drivers/persistent-cli-driver'
import type { SessionAgentEvent } from '../../../src/lib/types'

const rpcMock = vi.hoisted(() => {
  const clients: Array<{
    newSession: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    steer: ReturnType<typeof vi.fn>
    abort: ReturnType<typeof vi.fn>
    setModel: ReturnType<typeof vi.fn>
    setThinkingLevel: ReturnType<typeof vi.fn>
    getAvailableModels: ReturnType<typeof vi.fn>
    getState: ReturnType<typeof vi.fn>
    getSessionStats: ReturnType<typeof vi.fn>
    getCommands: ReturnType<typeof vi.fn>
    compact: ReturnType<typeof vi.fn>
    setAutoRetry: ReturnType<typeof vi.fn>
    setAutoCompaction: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    onEvent: (record: Record<string, unknown>) => void
    onUiRequest: (record: Record<string, unknown>) => void
    emitUi: (record: Record<string, unknown>) => void
    emitStatus: (record: Record<string, unknown>) => void
    emit: (record: Record<string, unknown>) => void
  }> = []
  return {
    clients,
    PiRpcClient: class PiRpcClientMock {
      newSession: ReturnType<typeof vi.fn>
      prompt: ReturnType<typeof vi.fn>
      steer: ReturnType<typeof vi.fn>
      abort: ReturnType<typeof vi.fn>
      setModel: ReturnType<typeof vi.fn>
      setThinkingLevel: ReturnType<typeof vi.fn>
      getAvailableModels: ReturnType<typeof vi.fn>
      getState: ReturnType<typeof vi.fn>
      getSessionStats: ReturnType<typeof vi.fn>
      getCommands: ReturnType<typeof vi.fn>
      compact: ReturnType<typeof vi.fn>
      setAutoRetry: ReturnType<typeof vi.fn>
      setAutoCompaction: ReturnType<typeof vi.fn>
      dispose: ReturnType<typeof vi.fn>
      constructor(options: {
        onEvent?: (record: Record<string, unknown>) => void
        onUiRequest?: (record: Record<string, unknown>) => void
        onExtensionStatus?: (record: Record<string, unknown>) => void
      }) {
        this.newSession = vi.fn(async () => undefined)
        this.prompt = vi.fn(async () => undefined)
        this.steer = vi.fn(async () => undefined)
        this.abort = vi.fn(async () => undefined)
        this.setModel = vi.fn(async () => undefined)
        this.setThinkingLevel = vi.fn(async () => undefined)
        this.getAvailableModels = vi.fn(async () => ({ models: [] }))
        this.getState = vi.fn(async () => ({
          sessionId: 'native-1',
          model: null,
          thinkingLevel: 'medium'
        }))
        this.getSessionStats = vi.fn(async () => ({
          tokens: { input: 20, output: 5, total: 25 },
          cost: 0.001,
          contextUsage: { tokens: 25, contextWindow: 128000, percent: 0.02 }
        }))
        this.getCommands = vi.fn(async () => ({
          commands: [
            { name: 'session-name', description: 'Set session name', source: 'extension' },
            { name: 'skill:docs', description: 'Docs skill', source: 'skill' }
          ]
        }))
        this.compact = vi.fn(async () => undefined)
        this.setAutoRetry = vi.fn(async () => undefined)
        this.setAutoCompaction = vi.fn(async () => undefined)
        this.dispose = vi.fn()
        this.onEvent = options.onEvent ?? (() => undefined)
        this.onUiRequest = options.onUiRequest ?? (() => undefined)
        this.onExtensionStatus = options.onExtensionStatus ?? (() => undefined)
        clients.push(this)
      }
      onEvent: (record: Record<string, unknown>) => void
      onUiRequest: (record: Record<string, unknown>) => void
      onExtensionStatus: (record: Record<string, unknown>) => void
      emit(record: Record<string, unknown>): void {
        this.onEvent(record)
      }
      emitUi(record: Record<string, unknown>): void {
        this.onUiRequest(record)
      }
      emitStatus(record: Record<string, unknown>): void {
        this.onExtensionStatus(record)
      }
    },
    resolvePiExecutable: vi.fn(async () => 'pi'),
    get client() {
      return clients[0]
    }
  }
})

vi.mock('../../../src/main/drivers/pi-rpc-client', () => ({
  PiRpcClient: rpcMock.PiRpcClient,
  resolvePiExecutable: rpcMock.resolvePiExecutable
}))

// The connected-provider filter reads the real user-level pi credential and
// native-provider stores, which are non-hermetic inputs. Stub both so the
// connected set cannot be determined and catalogs stay unfiltered — the
// documented behavior for unreliable reads.
vi.mock('../../../src/main/providers/pi-auth-config', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/providers/pi-auth-config')>(
    '../../../src/main/providers/pi-auth-config'
  )
  return {
    ...actual,
    piAuthFileIo: {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined)
    }
  }
})

vi.mock('../../../src/main/agents/native-provider-config-service', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/main/agents/native-provider-config-service')
  >('../../../src/main/agents/native-provider-config-service')
  return {
    ...actual,
    piNativeProviderIds: vi.fn(async () => null)
  }
})

vi.mock('../../../src/main/drivers/harness-runtime', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/drivers/harness-runtime')>(
    '../../../src/main/drivers/harness-runtime'
  )
  return {
    ...actual,
    resolveHarnessRuntime: vi.fn(async () => ({ command: 'pi', args: [] })),
    prepareHarnessInvocation: vi.fn(async () => ({ command: 'pi', args: [] })),
    runHarnessCommand: actual.runHarnessCommand
  }
})

const roots: string[] = []
afterEach(async () => {
  rpcMock.clients.splice(0)
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
  it('spawns one RPC client per session and drives a prompt turn', async () => {
    const driver = new PiDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Pi')
    await driver.sendPrompt('/project', { sessionId, settings, text: 'go', attachments: [] })

    expect(rpcMock.clients.length).toBeGreaterThan(0)
    const client = rpcMock.clients[0]
    expect(client).toBeDefined()
    expect(client.newSession).toHaveBeenCalled()
    expect(client.setModel).toHaveBeenCalledWith('lmstudio', 'qwen/qwen3.5-9b')
    expect(client.setThinkingLevel).toHaveBeenCalledWith('medium')
    expect(client.prompt).toHaveBeenCalledWith('go', [])
  })

  it('delivers a system prompt and read-only tool scope on the turn', async () => {
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
    const client = rpcMock.clients[0]
    expect(client).toBeDefined()
    const [promptText] = client.prompt.mock.calls[0] as [string, undefined]
    expect(promptText).toContain('Be surgical.')
    expect(promptText).toContain('inspect')
  })

  it('surfaces a permanently failed run from agent_settled', () => {
    const context = sessionContext('s-1', [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', id: 'assistant-1:text', messageID: 'assistant-1', text: '' }],
        createdAt: Date.now(),
        harnessId: 'pi',
        error: 'rate limit exceeded'
      }
    ])
    const state = { assistantMessageId: null, turnIndex: 1 }
    const result = mapPiRecord({ type: 'agent_settled' }, context, state)
    expect(result?.events).toContainEqual(
      expect.objectContaining({
        type: 'session.status',
        status: expect.objectContaining({ state: 'error' })
      })
    )
    const issue = result?.events?.find((event) => event.type === 'session.status')?.status
    expect(issue && issue.state === 'error' ? issue.issue?.message : undefined).toBe(
      'rate limit exceeded'
    )
  })

  it('is neutral to agent_end while an auto-retry may still follow', () => {
    const state = { assistantMessageId: null, turnIndex: 1 }
    const result = mapPiRecord(
      {
        type: 'agent_end',
        willRetry: true,
        messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'overloaded' }]
      },
      sessionContext('s-1'),
      state
    )
    expect(result?.events ?? []).toHaveLength(0)
  })

  it('falls back to the bundled catalog when model discovery is empty', async () => {
    const driver = new PiDriver(await storage())
    const catalogs = await driver.listProviders('/project')
    expect(catalogs.length).toBeGreaterThan(0)
    expect(catalogs[0]?.harnessId).toBe('pi')
  })

  it('discovers slash commands and skills from a disposable session', async () => {
    const driver = new PiDriver(await storage())
    await driver.createSession('/project', 'Pi')
    const commands = await driver.listCommands('/project')
    expect(commands).toEqual([
      { name: 'session-name', description: 'Set session name' },
      { name: 'skill:docs', description: 'Docs skill', source: 'skill' }
    ])
  })

  it('emits a working session status from the status extension record', async () => {
    const driver = new PiDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Pi')
    const events: Array<{ type: string; status?: { state: string } }> = []
    driver.onEvent((event) => events.push(event as { type: string; status?: { state: string } }))
    await driver.sendPrompt('/project', { sessionId, settings, text: 'go', attachments: [] })
    const client = rpcMock.client
    expect(client).toBeDefined()
    client.emitStatus({
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'setStatus',
      statusKey: PI_STATUS_EXTENSION_KEY,
      statusText: PI_STATUS_WORKING
    })
    const status = events.find((event) => event.type === 'session.status')
    expect(status?.status?.state).toBe('working')
  })

  it('emits an idle session status from the status extension record', async () => {
    const driver = new PiDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Pi')
    const events: Array<{ type: string; status?: { state: string } }> = []
    driver.onEvent((event) => events.push(event as { type: string; status?: { state: string } }))
    await driver.sendPrompt('/project', { sessionId, settings, text: 'go', attachments: [] })
    const client = rpcMock.client
    expect(client).toBeDefined()
    client.emitStatus({
      type: 'extension_ui_request',
      id: 'ui-2',
      method: 'setStatus',
      statusKey: PI_STATUS_EXTENSION_KEY,
      statusText: PI_STATUS_IDLE
    })
    const status = events.find((event) => event.type === 'session.status')
    expect(status?.status?.state).toBe('idle')
  })

  it('ignores status records from foreign extension keys', async () => {
    const driver = new PiDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Pi')
    const events: Array<{ type: string; status?: { state: string } }> = []
    driver.onEvent((event) => events.push(event as { type: string; status?: { state: string } }))
    await driver.sendPrompt('/project', { sessionId, settings, text: 'go', attachments: [] })
    const client = rpcMock.client
    expect(client).toBeDefined()
    client.emitStatus({
      type: 'extension_ui_request',
      id: 'ui-3',
      method: 'setStatus',
      statusKey: 'user-extension',
      statusText: PI_STATUS_WORKING
    })
    client.emitStatus({
      type: 'extension_ui_request',
      id: 'ui-4',
      method: 'setStatus',
      statusKey: PI_STATUS_EXTENSION_KEY,
      statusText: 'user status text'
    })
    expect(events.find((event) => event.type === 'session.status')).toBeUndefined()
  })

  it('finalizes a running turn when agent_settled arrives after streaming', async () => {
    const driver = new PiDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Pi')
    const events: string[] = []
    const ready = new Promise<void>((resolve) => {
      driver.onEvent((event) => {
        events.push(event.type)
        if (event.type === 'session.idle') resolve()
      })
    })
    await driver.sendPrompt('/project', { sessionId, settings, text: 'go', attachments: [] })
    const client = rpcMock.client
    expect(client).toBeDefined()
    client.emit({
      type: 'message_start',
      message: { role: 'assistant', content: [], timestamp: Date.now() }
    })
    client.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        timestamp: Date.now()
      }
    })
    client.emit({
      type: 'turn_end',
      message: { role: 'assistant', content: [], usage: { input: 10, output: 5 } },
      toolResults: []
    })
    client.emit({ type: 'agent_end', willRetry: false, messages: [] })
    client.emit({ type: 'agent_settled' })
    await ready
    expect(events).toContain('session.idle')
    expect(rpcMock.client.getSessionStats).toHaveBeenCalled()
  })

  it('maps cio_spawn_agent tool calls into subagent activity parts', () => {
    const context = sessionContext('s-1')
    const state = { assistantMessageId: null, turnIndex: 1 }
    const result = mapPiRecord(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Spawning a cleanup worker.' },
            {
              type: 'toolCall',
              id: 'call-spawn-1',
              name: 'cio_spawn_agent',
              arguments: {
                purpose: 'cleanup',
                instructions: 'Run lint and format.',
                background: true
              }
            }
          ],
          timestamp: Date.now()
        }
      },
      context,
      state
    )
    const part = result?.events?.find(
      (event): event is Extract<SessionAgentEvent, { type: 'message.part.updated' }> =>
        event.type === 'message.part.updated' && event.part.type === 'subagent'
    )?.part
    expect(part).toMatchObject({
      type: 'subagent',
      id: 'pi-subagent-call-spawn-1',
      callID: 'call-spawn-1',
      activity: {
        status: 'pending',
        agent: 'cleanup',
        prompt: 'Run lint and format.',
        background: true
      }
    })
  })

  it('tracks sub-agent progress and results through execution events', () => {
    const context = sessionContext('s-1')
    const state = { assistantMessageId: null, turnIndex: 1 }
    // The assistant message carrying the spawn call must exist first.
    mapPiRecord(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-spawn-2',
              name: 'cio_spawn_agent',
              arguments: { purpose: 'tests', instructions: 'Run baseline tests.' }
            }
          ],
          timestamp: Date.now()
        }
      },
      context,
      state
    )
    const start = mapPiRecord(
      {
        type: 'tool_execution_start',
        toolCallId: 'call-spawn-2',
        toolName: 'cio_spawn_agent',
        args: { purpose: 'tests', instructions: 'Run baseline tests.' }
      },
      context,
      state
    )
    expect(start?.events?.[0]).toMatchObject({
      type: 'message.part.updated',
      part: { type: 'subagent', activity: { status: 'running' } }
    })

    const markerPayload = {
      agentId: 'cio-subagent-1',
      purpose: 'tests',
      childSessionId: 'native-child-1',
      status: 'running',
      model: 'lmstudio/qwen3.5-9b',
      thinkingLevel: 'medium',
      output: 'Running vitest…'
    }
    const update = mapPiRecord(
      {
        type: 'tool_execution_update',
        toolCallId: 'call-spawn-2',
        toolName: 'cio_spawn_agent',
        args: {},
        partialResult: {
          content: [{ type: 'text', text: `cio-subagent:${JSON.stringify(markerPayload)}` }]
        }
      },
      context,
      state
    )
    const updatedPart =
      update?.events?.[0]?.type === 'message.part.updated' ? update.events[0].part : undefined
    expect(updatedPart).toMatchObject({
      type: 'subagent',
      activity: {
        status: 'running',
        childSessionId: 'native-child-1',
        modelId: 'lmstudio/qwen3.5-9b',
        output: 'Running vitest…'
      }
    })

    const end = mapPiRecord(
      {
        type: 'tool_execution_end',
        toolCallId: 'call-spawn-2',
        toolName: 'cio_spawn_agent',
        isError: false,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...markerPayload,
                status: 'completed',
                output: 'All 10 tests passed.'
              })
            }
          ]
        }
      },
      context,
      state
    )
    const endPart =
      end?.events?.[0]?.type === 'message.part.updated' ? end.events[0].part : undefined
    expect(endPart).toMatchObject({
      type: 'subagent',
      activity: {
        status: 'completed',
        childSessionId: 'native-child-1',
        output: 'All 10 tests passed.'
      }
    })
    expect(endPart?.type === 'subagent' ? endPart.activity.time?.end : undefined).toBeDefined()
  })

  it('splits the question marker payload into scope header and question text', async () => {
    const driver = new PiDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Pi')
    const events: unknown[] = []
    driver.onEvent((event) => events.push(event))
    await driver.sendPrompt('/project', { sessionId, settings, text: 'go', attachments: [] })
    const client = rpcMock.client
    expect(client).toBeDefined()
    client.emitUi({
      type: 'extension_ui_request',
      id: 'ui-q1',
      method: 'select',
      title: `cio-question:${JSON.stringify({
        header: 'Next step',
        prompt: 'Want me to implement the fix for the silent brainstorm refresh failure?'
      })}`,
      options: ['Fix both defects', 'No fix for now']
    })
    const asked = events.find((event) => (event as { type: string }).type === 'question.asked') as
      { questions: Array<{ header?: string; prompt: string }> } | undefined
    expect(asked?.questions?.[0]).toMatchObject({
      header: 'Next step',
      prompt: 'Want me to implement the fix for the silent brainstorm refresh failure?'
    })
    // The scope header must not leak into the question body.
    expect(asked?.questions?.[0]?.prompt.startsWith('Next step')).toBe(false)
  })

  it('keeps sub-agent-done custom messages out of the transcript', () => {
    const context = sessionContext('s-1')
    const state = { assistantMessageId: null, turnIndex: 1 }
    const record = {
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'cio-subagent-done',
        content: 'Sub-agent done for task explore codebase (cio-subagent-1, status: completed).',
        display: false,
        timestamp: Date.now()
      }
    }
    const result = mapPiRecord(record, context, state)
    expect(result?.events ?? []).toEqual([])
    // And it must not be mistaken for a user message.
    expect(context.session.messages).toHaveLength(0)
  })
})
