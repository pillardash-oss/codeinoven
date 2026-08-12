import { EventEmitter } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import type { AgentMessage } from '../../lib/types'
import { StorageEngine } from '../storage-engine'
import type {
  CliLineParseContext,
  CliLineParseResult,
  CliTurnCommand,
  PersistentCliSession
} from './persistent-cli-driver'
import { PersistentCliDriver } from './persistent-cli-driver'
import type { HarnessCapabilities, SendPromptOptions } from './driver.interface'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({ spawn: spawnMock }))

const capabilities: HarnessCapabilities = {
  runtimeTopology: { kind: 'turn_process', scope: 'session' },
  streaming: true,
  steering: false,
  nativeResume: true,
  messageHistory: 'mirrored',
  interactivePermissions: false,
  attachments: false,
  commands: false,
  providerCatalog: false,
  sessionStatus: false,
  contextUsage: false,
  compaction: false,
  subagents: false
}

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

class FixtureCliDriver extends PersistentCliDriver {
  readonly id = 'fixture-cli'
  readonly name = 'Fixture CLI'
  readonly capabilities = capabilities

  protected async ensureCliReady(): Promise<void> {}

  protected async buildTurnCommand(
    _projectPath: string,
    session: PersistentCliSession,
    _options: SendPromptOptions
  ): Promise<CliTurnCommand> {
    void _projectPath
    void _options
    return {
      command: 'fixture-cli',
      args: session.nativeSessionId ? ['--resume', session.nativeSessionId] : [],
      input: 'prompt'
    }
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    if (!isRecord(value) || value['type'] !== 'result') return null
    const authenticationFailure = value['authenticationFailure'] === true
    const message: AgentMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: authenticationFailure
        ? [
            {
              type: 'text',
              id: 'assistant-1:text',
              messageID: 'assistant-1',
              text: 'Arbitrary provider failure text that must never become a title'
            }
          ]
        : [],
      createdAt: 10,
      completedAt: 20
    }
    return {
      nativeSessionId: 'native-1',
      messages: [message],
      ...(authenticationFailure
        ? {
            events: [
              {
                type: 'message.completed' as const,
                sessionId: context.sessionId,
                messageId: message.id,
                error: 'Authentication failed',
                issue: {
                  kind: 'authentication' as const,
                  message: 'Provider authentication failed.',
                  harnessId: 'fixture-cli',
                  retryable: true
                }
              }
            ]
          }
        : {})
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

const prompt: SendPromptOptions = {
  sessionId: '',
  settings: {
    harnessId: 'fixture-cli',
    providerId: '',
    modelId: '',
    thinkingLevel: 'low',
    permissionLevel: 'auto_review',
    engineeringMode: false
  },
  text: 'hello',
  attachments: []
}

const tempRoots: string[] = []

afterEach(async () => {
  spawnMock.mockReset()
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createStorage(): Promise<StorageEngine> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-cli-driver-'))
  tempRoots.push(root)
  const storage = new StorageEngine(root)
  await storage.initialize()
  return storage
}

describe('PersistentCliDriver', () => {
  it('persists logical sessions and rehydrates their messages', async () => {
    const storage = await createStorage()
    const driver = new FixtureCliDriver(storage)
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    let resolveIdle: (() => void) | undefined
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve
    })
    driver.onEvent((event) => {
      if (event.type === 'session.idle') resolveIdle?.()
    })

    const sessionId = await driver.createSession('/project', 'Fixture thread')
    await driver.sendPrompt('/project', { ...prompt, sessionId })
    child.stdout.emit('data', Buffer.from('{"type":"result"}\n'))
    child.emit('exit', 0, null)
    await idle

    const restarted = new FixtureCliDriver(storage)
    const messages = await restarted.loadMessages('/project', sessionId)
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ id: 'assistant-1', role: 'assistant' })
      ])
    )
  })

  it('normalizes provider IDs and emits terminal idle', async () => {
    const storage = await createStorage()
    const driver = new FixtureCliDriver(storage)
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const events: string[] = []
    driver.onEvent((event) => {
      const sessionId = 'sessionId' in event ? (event.sessionId ?? '') : ''
      events.push(`${event.type}:${sessionId}`)
    })

    const sessionId = await driver.createSession('/project', 'Fixture thread')
    await driver.sendPrompt('/project', { ...prompt, sessionId })
    child.stdout.emit('data', Buffer.from('{"type":"result"}\n'))
    child.emit('exit', 0, null)
    await vi.waitFor(() => {
      expect(events).toEqual([`session.idle:${sessionId}`])
    })
  })

  it('aborts only the child process associated with the logical session', async () => {
    const storage = await createStorage()
    const driver = new FixtureCliDriver(storage)
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Fixture thread')

    await driver.sendPrompt('/project', { ...prompt, sessionId })
    await driver.abort('/project', sessionId)

    expect(child.killed).toBe(true)
  })

  it('rejects a structured authentication failure instead of using its response as a title', async () => {
    const storage = await createStorage()
    const driver = new FixtureCliDriver(storage)
    spawnMock.mockImplementation(() => {
      const child = new FakeChild()
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('{"type":"result","authenticationFailure":true}\n'))
      })
      return child as unknown as ChildProcess
    })

    const title = await driver.generateTitle('/project', {
      settings: {
        ...prompt.settings,
        providerId: 'fixture-provider',
        modelId: 'fixture-model'
      },
      message: 'Fix my account'
    })

    expect(title).toBeNull()
    expect(spawnMock).toHaveBeenCalledOnce()
  })
})
