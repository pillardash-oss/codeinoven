import { EventEmitter } from 'events'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { StorageEngine } from '../storage-engine'
import { CodexDriver } from './codex-driver'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>()
  return { ...original, spawn: spawnMock }
})

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = {
    write: vi.fn((value: string) => {
      const payload = JSON.parse(value) as Record<string, unknown>
      const id = typeof payload['id'] === 'number' ? payload['id'] : undefined
      const method = typeof payload['method'] === 'string' ? payload['method'] : undefined
      if (id === undefined || !method) return true
      const params = payload['params'] as Record<string, unknown> | undefined
      const result =
        method === 'thread/start' || method === 'thread/resume'
          ? { thread: { id: method === 'thread/resume' ? params?.['threadId'] : 'native-1' } }
          : method === 'turn/start'
            ? { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
            : method === 'turn/steer'
              ? { turnId: 'turn-1' }
              : {}
      queueMicrotask(() => this.emitPayload({ id, result }))
      return true
    }),
    end: vi.fn()
  }
  killed = false
  emitPayload(payload: Record<string, unknown>): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`))
  }
  requests(): Array<Record<string, unknown>> {
    return this.stdin.write.mock.calls.map(
      ([value]) => JSON.parse(value) as Record<string, unknown>
    )
  }
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
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-codex-driver-'))
  roots.push(root)
  const value = new StorageEngine(root)
  await value.initialize()
  return value
}

const settings = {
  harnessId: 'codex',
  providerId: 'openai',
  modelId: 'gpt-5.6-sol',
  thinkingLevel: 'medium' as const,
  permissionLevel: 'auto_review' as const,
  engineeringMode: false
}

describe('CodexDriver', () => {
  it('runs new and resumed turns through app-server with the selected sandbox', async () => {
    const driver = new CodexDriver(await storage())
    const firstChild = new FakeChild()
    const secondChild = new FakeChild()
    spawnMock
      .mockReturnValueOnce(firstChild as unknown as ChildProcess)
      .mockReturnValueOnce(secondChild as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Codex')
    await driver.sendPrompt('/project', { sessionId, settings, text: 'first', attachments: [] })
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['app-server', '--listen', 'stdio://'])
    expect(firstChild.requests()).toContainEqual(
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({
          threadId: 'native-1',
          model: 'gpt-5.6-sol',
          sandboxPolicy: expect.objectContaining({ type: 'workspaceWrite' })
        })
      })
    )
    await driver.steerPrompt('/project', {
      sessionId,
      text: 'focus on tests',
      attachments: [],
      userMessageId: 'steer-1'
    })
    expect(firstChild.requests()).toContainEqual({
      id: 4,
      method: 'turn/steer',
      params: {
        threadId: 'native-1',
        clientUserMessageId: 'steer-1',
        input: [{ type: 'text', text: 'focus on tests', text_elements: [] }],
        expectedTurnId: 'turn-1'
      }
    })
    firstChild.emitPayload({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await driver.sendPrompt('/project', {
      sessionId,
      settings: { ...settings, permissionLevel: 'full_access' },
      text: 'second',
      attachments: []
    })
    expect(secondChild.requests()).toContainEqual({
      id: 2,
      method: 'thread/resume',
      params: { threadId: 'native-1' }
    })
    expect(secondChild.requests()).toContainEqual(
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({
          sandboxPolicy: { type: 'dangerFullAccess' }
        })
      })
    )
  })

  it('maps Codex tool and assistant items to render events', async () => {
    const driver = new CodexDriver(await storage())
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Codex')
    await driver.sendPrompt('/project', { sessionId, settings, text: 'go', attachments: [] })
    child.emitPayload({
      method: 'item/started',
      params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'bun test' } }
    })
    child.emitPayload({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'bun test',
          status: 'completed',
          exitCode: 0
        }
      }
    })
    child.emitPayload({
      method: 'item/completed',
      params: { item: { id: 'msg-1', type: 'agentMessage', text: 'Done' } }
    })
    child.emitPayload({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(driver.loadMessages('/project', sessionId)).resolves.toEqual([
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({
        id: `${sessionId}:cmd-1`,
        role: 'assistant',
        parts: [expect.objectContaining({ type: 'tool', tool: 'command_execution' })]
      }),
      expect.objectContaining({ id: `${sessionId}:msg-1`, role: 'assistant' })
    ])
  })

  it('passes only existing local attachment paths to Codex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-codex-image-'))
    roots.push(root)
    const image = join(root, 'image.png')
    await writeFile(image, 'image')
    const driver = new CodexDriver(await storage())
    const firstChild = new FakeChild()
    const secondChild = new FakeChild()
    spawnMock
      .mockReturnValueOnce(firstChild as unknown as ChildProcess)
      .mockReturnValueOnce(secondChild as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Codex')
    await driver.sendPrompt('/project', {
      sessionId,
      settings,
      text: 'look',
      attachments: [{ mime: 'image/png', url: image }]
    })
    expect(firstChild.requests()).toContainEqual(
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({
          input: expect.arrayContaining([{ type: 'localImage', path: image }])
        })
      })
    )
    firstChild.emitPayload({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(
      driver.sendPrompt('/project', {
        sessionId,
        settings,
        text: 'look',
        attachments: [{ mime: 'image/png', url: join(root, 'missing.png') }]
      })
    ).rejects.toThrow('readable local file')
  })
})
