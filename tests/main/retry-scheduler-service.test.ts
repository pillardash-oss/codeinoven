import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { RetrySchedulerService, type PendingRetryRecord } from
  '../../src/main/system/retry-scheduler-service'

const roots: string[] = []
beforeEach(async () => {
  roots.length = 0
})
afterEach(async () => {
  vi.restoreAllMocks()
  // Let any pending asynchronously-persisted scheduler snapshot settle first.
  await new Promise((resolve) => setTimeout(resolve, 25))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storage(): Promise<StorageEngine> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-retry-scheduler-'))
  roots.push(root)
  const value = new StorageEngine(root)
  await value.initialize()
  return value
}

function record(overrides: Partial<PendingRetryRecord> = {}): PendingRetryRecord {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    threadId: 'thread-1',
    harnessId: 'opencode',
    retryAt: Date.now() + 60_000,
    issueKind: 'quota',
    issueMessage: 'Usage limit reached — retry after reset.',
    ...overrides
  }
}

describe('RetrySchedulerService', () => {
  it('tracks a pending reset retry and exposes it', async () => {
    const scheduler = new RetrySchedulerService(await storage())
    await scheduler.start()
    const saved = record()
    expect(scheduler.track(saved)).toBe(true)
    expect(scheduler.getPendingRetry('session-1')).toEqual(saved)
    scheduler.stop()
  })

  it('restores pending retries across app restarts (persisted)', async () => {
    const storageEngine = await storage()
    const first = new RetrySchedulerService(storageEngine)
    await first.start()
    const saved = record({ retryAt: Date.now() + 120_000 })
    first.track(saved)
    await new Promise((resolve) => setTimeout(resolve, 0))
    first.dispose()

    const restarted = new RetrySchedulerService(storageEngine)
    await restarted.start()
    const pending = restarted.getPendingRetry('session-1')
    expect(pending).toEqual(saved)
    restarted.stop()
  })

  it('fires a due retry once through the attached resume callback', async () => {
    const scheduler = new RetrySchedulerService(await storage())
    await scheduler.start()
    const resume = vi.fn(async () => undefined)
    scheduler.attachContinue(resume)
    const due = record({ retryAt: Date.now() - 1_000 })
    scheduler.track(due)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith(due)
    expect(scheduler.getPendingRetry('session-1')).toBeUndefined()
    scheduler.stop()
  })

  it('clears a pending record explicitly (e.g. native resume / stop)', async () => {
    const scheduler = new RetrySchedulerService(await storage())
    await scheduler.start()
    scheduler.track(record())
    scheduler.clear('session-1')
    expect(scheduler.getPendingRetry('session-1')).toBeUndefined()
    scheduler.stop()
  })

  it('does not track or resume when the auto-retry toggle is disabled', async () => {
    const scheduler = new RetrySchedulerService(await storage())
    await scheduler.start()
    scheduler.setEnabled(false)
    const resume = vi.fn(async () => undefined)
    scheduler.attachContinue(resume)
    expect(scheduler.track(record({ retryAt: Date.now() - 1 }))).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resume).not.toHaveBeenCalled()
  })
})
