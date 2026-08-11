import { EventEmitter } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { StorageEngine } from '../storage-engine'
import type { ThreadSettings } from '../../lib/types'
import { AntigravityDriver, mapAntigravityUsage } from './antigravity-driver'

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

describe('Antigravity token usage normalization', () => {
  it('maps reported categories and preserves the verbatim provider total', () => {
    const { legacy, usage } = mapAntigravityUsage({
      input_tokens: 100,
      output_tokens: 30,
      thinking_tokens: 10,
      cache_read_tokens: 40,
      cache_write_tokens: 5,
      total_tokens: 175
    })
    expect(legacy).toEqual({
      input: 100,
      output: 30,
      reasoning: 10,
      cacheRead: 40,
      cacheWrite: 5,
      total: 175
    })
    expect(usage).toEqual({
      uncachedInput: 60,
      cachedInput: 40,
      cacheWrite: 5,
      output: 30,
      reasoning: 10,
      rawProviderUsage: {
        input_tokens: 100,
        output_tokens: 30,
        thinking_tokens: 10,
        cache_read_tokens: 40,
        cache_write_tokens: 5,
        total_tokens: 175
      },
      rawTotal: 175,
      totalSemantics: 'categories_may_overlap'
    })
  })

  it('does not synthesize a comparable total when the provider reports none', () => {
    const { legacy, usage } = mapAntigravityUsage({
      input_tokens: 100,
      output_tokens: 30,
      thinking_tokens: 10,
      cache_read_tokens: 40
    })
    expect(legacy).toBeUndefined()
    expect(usage).toEqual({
      uncachedInput: 60,
      cachedInput: 40,
      cacheWrite: null,
      output: 30,
      reasoning: 10,
      rawProviderUsage: {
        input_tokens: 100,
        output_tokens: 30,
        thinking_tokens: 10,
        cache_read_tokens: 40
      },
      rawTotal: null,
      totalSemantics: 'unavailable'
    })
  })

  it('clamps uncached input at zero when cached input exceeds total input', () => {
    const { legacy, usage } = mapAntigravityUsage({
      input_tokens: 10,
      cache_read_tokens: 40,
      total_tokens: 50
    })
    expect(legacy).toEqual({
      input: 10,
      output: 0,
      reasoning: 0,
      cacheRead: 40,
      cacheWrite: 0,
      total: 50
    })
    expect(usage).toEqual({
      uncachedInput: 0,
      cachedInput: 40,
      cacheWrite: null,
      output: null,
      reasoning: null,
      rawProviderUsage: {
        input_tokens: 10,
        cache_read_tokens: 40,
        total_tokens: 50
      },
      rawTotal: 50,
      totalSemantics: 'categories_may_overlap'
    })
  })

  it('keeps unreported categories null while preserving a reported total', () => {
    const { legacy, usage } = mapAntigravityUsage({
      inputTokens: 50,
      totalTokens: 50
    })
    expect(legacy).toEqual({
      input: 50,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 50
    })
    expect(usage).toEqual({
      uncachedInput: 50,
      cachedInput: null,
      cacheWrite: null,
      output: null,
      reasoning: null,
      rawProviderUsage: { inputTokens: 50, totalTokens: 50 },
      rawTotal: 50,
      totalSemantics: 'categories_may_overlap'
    })
  })

  it('attaches no usage metadata when the provider reports no tokens', () => {
    expect(mapAntigravityUsage({})).toEqual({ legacy: undefined, usage: undefined })
    expect(mapAntigravityUsage(null)).toEqual({ legacy: undefined, usage: undefined })
  })
})
