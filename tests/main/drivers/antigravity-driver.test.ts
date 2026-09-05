import { EventEmitter } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import type { AgentPart, ThreadSettings } from '../../../src/lib/types'
import {
  AntigravityDriver,
  mapAntigravityUsage,
  setAntigravityBrainRootForTests
} from '../../../src/main/drivers/antigravity-driver'
import { parseBrainTraceLine } from '../../../src/main/drivers/antigravity-brain-trace'

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

describe.skipIf(process.platform === 'win32')('AntigravityDriver', () => {
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
        permissionLevel: 'auto_review'
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
        permissionLevel: 'auto_review'
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
        permissionLevel: 'auto_review'
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
      permissionLevel: 'auto_review'
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

  it('backfills thinking text from the brain transcript onto the step timeline', async () => {
    vi.useFakeTimers()
    try {
      const brainRoot = await mkdtemp(join(tmpdir(), 'codeinoven-antigravity-brain-'))
      roots.push(brainRoot)
      setAntigravityBrainRootForTests(brainRoot)
      const conversationId = 'conv-123'
      let turnChild: FakeChild | undefined
      spawnMock.mockImplementation((_command: string, args: string[]) => {
        const child = new FakeChild()
        if (args.includes('-p')) turnChild = child
        if (args.includes('models')) {
          queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from('claude-sonnet-4-6\n'))
            child.emit('exit', 0, null)
          })
        }
        return child as unknown as ChildProcess
      })

      const driver = new AntigravityDriver(await storage())
      const sessionId = await driver.createSession('/project', 'Antigravity thread')
      const updatedParts: Extract<AgentPart, { type: 'reasoning' }>[] = []
      driver.onEvent((event) => {
        if (event.type === 'message.part.updated' && event.part.type === 'reasoning') {
          updatedParts.push(event.part)
        }
      })
      const sending = driver
        .sendPrompt('/project', {
          sessionId,
          text: 'Read the project',
          attachments: [],
          settings: {
            harnessId: 'antigravity',
            providerId: 'google',
            modelId: 'claude-sonnet-4-6',
            thinkingLevel: 'high',
            permissionLevel: 'auto_review'
          }
        })
        .then(() => 'done')
        .catch(() => 'failed')
      await vi.waitFor(() => {
        if (!turnChild) throw new Error('turn child not spawned')
      })
      const turn = turnChild as FakeChild

      // The stream opens a fresh conversation: its id arrives on the records.
      turn.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ event: 'init', conversation_id: conversationId }) + '\n')
      )
      turn.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            event: 'step_update',
            conversation_id: conversationId,
            step_update: { step_type: 'tool', step_index: 1, state: 'DONE', duration_seconds: 2 }
          }) + '\n'
        )
      )

      // agy persists the brain transcript while the turn runs. Append a
      // thinking entry for step 1 after the tool step streamed.
      const logDir = join(brainRoot, conversationId, '.system_generated', 'logs')
      const { mkdir, writeFile } = await import('fs/promises')
      await mkdir(logDir, { recursive: true })
      await writeFile(
        join(logDir, 'transcript.jsonl'),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: 1,
          thinking: 'Inspect the project layout first.'
        }) + '\n'
      )

      // The poller (800ms interval) picks the entry up while the turn is
      // still running and upserts the reasoning part. The poll's awaited fs
      // work settles outside timer advancement, so wait on the condition.
      await vi.waitFor(
        () => {
          expect(
            updatedParts.some((part) => part.text === 'Inspect the project layout first.')
          ).toBe(true)
        },
        { timeout: 5000 }
      )
      // The brain-backed card joins the streamed step timeline by step index.
      expect(updatedParts[0]?.id.endsWith(':thinking:1')).toBe(true)

      // Finish the turn.
      turn.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            event: 'result',
            conversation_id: conversationId,
            result: { status: 'SUCCESS', response: 'Done.' }
          }) + '\n'
        )
      )
      turn.emit('exit', 0, null)
      expect(await sending).toBe('done')
    } finally {
      setAntigravityBrainRootForTests(undefined)
      vi.useRealTimers()
    }
  })
})

describe('Antigravity brain trace parser', () => {
  it('extracts step-indexed thinking from PLANNER_RESPONSE lines', () => {
    const line = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 3,
      thinking: '**Reading the schema**\n\nThe plan requires care.'
    })
    expect(parseBrainTraceLine(line)).toEqual({
      stepIndex: 3,
      thinking: '**Reading the schema**\n\nThe plan requires care.'
    })
  })

  it('skips entries without thinking text or a usable step index', () => {
    expect(
      parseBrainTraceLine(JSON.stringify({ type: 'GENERIC', step_index: 1, content: 'x' }))
    ).toBeNull()
    expect(
      parseBrainTraceLine(JSON.stringify({ type: 'PLANNER_RESPONSE', thinking: 'no step' }))
    ).toBeNull()
    expect(
      parseBrainTraceLine(
        JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: -1, thinking: 'neg' })
      )
    ).toBeNull()
    expect(
      parseBrainTraceLine(
        JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1.5, thinking: 'frac' })
      )
    ).toBeNull()
  })

  it('skips noise without throwing', () => {
    expect(parseBrainTraceLine('')).toBeNull()
    expect(parseBrainTraceLine('not json')).toBeNull()
    expect(parseBrainTraceLine('{broken')).toBeNull()
    expect(parseBrainTraceLine('null')).toBeNull()
    expect(parseBrainTraceLine('[]')).toBeNull()
  })

  it('keeps a partial trailing line out of parsed entries', () => {
    // A tailer splits full lines and keeps the incomplete last one in its
    // pending buffer; the parser itself must also refuse truncated JSON.
    expect(
      parseBrainTraceLine('{"type":"PLANNER_RESPONSE","step_index":2,"thinking":"cut')
    ).toBeNull()
  })
})

describe('Antigravity token normalizedUsage normalization', () => {
  it('maps reported categories and preserves the verbatim provider total', () => {
    const { aggregateTokens, normalizedUsage } = mapAntigravityUsage({
      input_tokens: 100,
      output_tokens: 30,
      thinking_tokens: 10,
      cache_read_tokens: 40,
      cache_write_tokens: 5,
      total_tokens: 175
    })
    expect(aggregateTokens).toEqual({
      input: 100,
      output: 30,
      reasoning: 10,
      cacheRead: 40,
      cacheWrite: 5,
      total: 175
    })
    expect(normalizedUsage).toEqual({
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
    const { aggregateTokens, normalizedUsage } = mapAntigravityUsage({
      input_tokens: 100,
      output_tokens: 30,
      thinking_tokens: 10,
      cache_read_tokens: 40
    })
    expect(aggregateTokens).toBeUndefined()
    expect(normalizedUsage).toEqual({
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
    const { aggregateTokens, normalizedUsage } = mapAntigravityUsage({
      input_tokens: 10,
      cache_read_tokens: 40,
      total_tokens: 50
    })
    expect(aggregateTokens).toEqual({
      input: 10,
      output: 0,
      reasoning: 0,
      cacheRead: 40,
      cacheWrite: 0,
      total: 50
    })
    expect(normalizedUsage).toEqual({
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
    const { aggregateTokens, normalizedUsage } = mapAntigravityUsage({
      inputTokens: 50,
      totalTokens: 50
    })
    expect(aggregateTokens).toEqual({
      input: 50,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 50
    })
    expect(normalizedUsage).toEqual({
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

  it('attaches no normalizedUsage metadata when the provider reports no tokens', () => {
    expect(mapAntigravityUsage({})).toEqual({
      aggregateTokens: undefined,
      normalizedUsage: undefined
    })
    expect(mapAntigravityUsage(null)).toEqual({
      aggregateTokens: undefined,
      normalizedUsage: undefined
    })
  })
})
