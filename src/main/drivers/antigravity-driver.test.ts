import { EventEmitter } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { StorageEngine } from '../storage-engine'
import type { ThreadSettings } from '../../lib/types'
import { AntigravityDriver } from './antigravity-driver'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ spawn: spawnMock }))

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
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-antigravity-driver-'))
  roots.push(root)
  const instance = new StorageEngine(root)
  await instance.initialize()
  return instance
}

const AGY_MODELS = [
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low',
  'claude-sonnet-4-6',
  'gpt-oss-120b-medium'
].join('\n')

describe('AntigravityDriver', () => {
  it('resolves a bare effort model id to an effort-suffixed slug before sending the turn', async () => {
    const calls: string[][] = []
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      calls.push(args)
      const child = new FakeChild()
      const isProbe = args.includes('models')
      queueMicrotask(() => {
        if (isProbe) {
          child.stdout.emit('data', Buffer.from(AGY_MODELS))
          child.emit('exit', 0, null)
        }
      })
      return child as unknown as ChildProcess
    })

    const driver = new AntigravityDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Antigravity thread')
    await driver.sendPrompt('/project', {
      sessionId,
      text: 'Read the project',
      attachments: [],
      settings: {
        harnessId: 'antigravity',
        providerId: 'google',
        modelId: 'gemini-3.6-flash',
        thinkingLevel: 'high',
        permissionLevel: 'auto_review',
        engineeringMode: false
      }
    })

    const turn = calls.find((args) => args.includes('-p'))
    expect(turn).toBeDefined()
    expect(turn).toContain('--model')
    expect(turn).toContain('gemini-3.6-flash-high')
    expect(turn).not.toContain('gemini-3.6-flash')
  })

  it('maps a model with only high/low variants to the closest effort slug', async () => {
    const calls: string[][] = []
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      calls.push(args)
      const child = new FakeChild()
      const isProbe = args.includes('models')
      queueMicrotask(() => {
        if (isProbe) {
          child.stdout.emit('data', Buffer.from('gemini-3.1-pro-high\ngemini-3.1-pro-low\n'))
          child.emit('exit', 0, null)
        }
      })
      return child as unknown as ChildProcess
    })

    const driver = new AntigravityDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Antigravity thread')
    await driver.sendPrompt('/project', {
      sessionId,
      text: 'Read the project',
      attachments: [],
      settings: {
        harnessId: 'antigravity',
        providerId: 'google',
        modelId: 'gemini-3.1-pro',
        thinkingLevel: 'medium',
        permissionLevel: 'auto_review',
        engineeringMode: false
      }
    })

    const turn = calls.find((args) => args.includes('-p'))
    expect(turn).toBeDefined()
    expect(turn).toContain('--model')
    const modelIndex = turn?.indexOf('--model') ?? -1
    expect(['gemini-3.1-pro-high', 'gemini-3.1-pro-low']).toContain(turn?.[modelIndex + 1])
    expect(turn?.[modelIndex + 1]).not.toBe('gemini-3.1-pro')
  })

  it('resolves a standalone model id unchanged when no effort variants exist', async () => {
    const calls: string[][] = []
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      calls.push(args)
      const child = new FakeChild()
      const isProbe = args.includes('models')
      queueMicrotask(() => {
        if (isProbe) {
          child.stdout.emit('data', Buffer.from('claude-sonnet-4-6\n'))
          child.emit('exit', 0, null)
        }
      })
      return child as unknown as ChildProcess
    })

    const driver = new AntigravityDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Antigravity thread')
    await driver.sendPrompt('/project', {
      sessionId,
      text: 'Read the project',
      attachments: [],
      settings: {
        harnessId: 'antigravity',
        providerId: 'google',
        modelId: 'claude-sonnet-4-6',
        thinkingLevel: 'high',
        permissionLevel: 'auto_review',
        engineeringMode: false
      }
    })

    const turn = calls.find((args) => args.includes('-p'))
    expect(turn).toBeDefined()
    expect(turn).toContain('--model')
    expect(turn).toContain('claude-sonnet-4-6')
  })

  it('probes the variant map only once across turns', async () => {
    let probeCount = 0
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeChild()
      if (args.includes('models')) {
        probeCount += 1
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(AGY_MODELS))
          child.emit('exit', 0, null)
        })
      }
      return child as unknown as ChildProcess
    })

    const driver = new AntigravityDriver(await storage())
    const settings: ThreadSettings = {
      harnessId: 'antigravity',
      providerId: 'google',
      modelId: 'gemini-3.6-flash',
      thinkingLevel: 'medium',
      permissionLevel: 'auto_review',
      engineeringMode: false
    }
    const first = await driver.createSession('/project', 'First')
    await driver.sendPrompt('/project', {
      sessionId: first,
      text: 'One',
      attachments: [],
      settings
    })
    const second = await driver.createSession('/project', 'Second')
    await driver.sendPrompt('/project', {
      sessionId: second,
      text: 'Two',
      attachments: [],
      settings
    })

    expect(probeCount).toBe(1)
  })
})
