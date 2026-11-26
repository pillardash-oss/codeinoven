import { mkdir, mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { RetrySchedulerService } from '../../../src/main/system/retry-scheduler-service'
import { ChatEngineRuntimeConnectivity } from '../../../src/main/chat/chat-engine/chat-engine-runtime-connectivity'
import type { ChatEngine } from '../../../src/main/chat/chat-engine'
import type { AgentProviderIssue } from '../../../src/lib/types'

const roots: string[] = []

async function scheduler(): Promise<RetrySchedulerService> {
  const scratch = join(process.cwd(), '.cio/tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'codeinoven-subagent-retry-'))
  roots.push(root)
  const storage = new StorageEngine(root)
  await storage.initialize()
  const value = new RetrySchedulerService(storage)
  await value.start()
  return value
}

function connectivity(retryScheduler: RetrySchedulerService): ChatEngineRuntimeConnectivity {
  const host = {
    state: {
      retryScheduler,
      childSessionOwners: new Map([
        [
          'child-session',
          {
            projectId: 'project-1',
            threadId: 'parent-thread',
            projectPath: '/tmp/project',
            driverId: 'pi',
            parentSessionId: 'parent-session'
          }
        ]
      ])
    },
    sessionRegistry: new Map(),
    threadManager: {
      wasStoppedByUser: vi.fn(async () => false),
      setStatus: vi.fn(async () => undefined)
    },
    units: {
      'turns-dispatch': { driverForRuntime: () => undefined },
      'assistant-authoring': { tryAssistantModelFallback: async () => false }
    },
    broadcast: vi.fn()
  } as unknown as ChatEngine
  return new ChatEngineRuntimeConnectivity(host)
}

function issue(overrides: Partial<AgentProviderIssue> = {}): AgentProviderIssue {
  return {
    kind: 'rate_limit',
    message: '429: rate limit exceeded, retry later.',
    harnessId: 'pi',
    retryable: true,
    ...overrides
  }
}

beforeEach(() => {
  roots.length = 0
})
afterEach(async () => {
  vi.restoreAllMocks()
  await new Promise((resolve) => setTimeout(resolve, 25))
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }))
  )
})

describe('nested sub-agent retries', () => {
  it('parks a rate-limited sub-agent on its own one-second cooldown', async () => {
    const retryScheduler = await scheduler()
    const unit = connectivity(retryScheduler)
    const startedAt = Date.now()

    expect(await unit.scheduleAutomaticRetry('child-session', issue())).toBe('scheduled')

    const record = retryScheduler.getPendingRetry('child-session')
    expect(record?.retryCooldown).toBe(true)
    expect(record?.cooldownAttempt).toBe(1)
    expect(record?.retryAt).toBeGreaterThanOrEqual(startedAt + 1_000)
    expect(record?.retryAt).toBeLessThanOrEqual(Date.now() + 1_000)
    retryScheduler.stop()
  })

  it('leaves a sub-agent failure the user has to act on alone', async () => {
    const retryScheduler = await scheduler()
    const unit = connectivity(retryScheduler)

    expect(
      await unit.scheduleAutomaticRetry('child-session', issue({ kind: 'authentication' }))
    ).toBe('refused')
    expect(retryScheduler.getPendingRetry('child-session')).toBeUndefined()
    retryScheduler.stop()
  })
})
