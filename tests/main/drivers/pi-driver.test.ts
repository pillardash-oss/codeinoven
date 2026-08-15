import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { PiDriver, mapPiRecord } from '../../../src/main/drivers/pi-driver'
import type {
  CliLineParseContext,
  PersistentCliSession
} from '../../../src/main/drivers/persistent-cli-driver'

const rpcMock = vi.hoisted(() => {
  const clients: Array<{
    newSession: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    steer: ReturnType<typeof vi.fn>
    abort: ReturnType<typeof vi.fn>
    setModel: ReturnType<typeof vi.fn>
    setThinkingLevel: ReturnType<typeof vi.fn>
    getAvailableModels: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
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
      dispose: ReturnType<typeof vi.fn>
      constructor(options: { onEvent?: (record: Record<string, unknown>) => void }) {
        this.newSession = vi.fn(async () => undefined)
        this.prompt = vi.fn(async () => undefined)
        this.steer = vi.fn(async () => undefined)
        this.abort = vi.fn(async () => undefined)
        this.setModel = vi.fn(async () => undefined)
        this.setThinkingLevel = vi.fn(async () => undefined)
        this.getAvailableModels = vi.fn(async () => ({ models: [] }))
        this.dispose = vi.fn()
        this.onEvent = options.onEvent ?? (() => undefined)
        clients.push(this)
      }
      onEvent: (record: Record<string, unknown>) => void
      emit(record: Record<string, unknown>): void {
        this.onEvent(record)
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

  it('falls back to the bundled catalog when model discovery is empty', async () => {
    const driver = new PiDriver(await storage())
    const catalogs = await driver.listProviders('/project')
    expect(catalogs.length).toBeGreaterThan(0)
    expect(catalogs[0]?.harnessId).toBe('pi')
  })
})
