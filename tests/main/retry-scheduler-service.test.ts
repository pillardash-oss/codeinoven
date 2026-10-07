import { mkdir, mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import {
  RetrySchedulerService,
  type PendingRetryRecord
} from '../../src/main/system/retry-scheduler-service'

const roots: string[] = []
beforeEach(async () => {
  roots.length = 0
})
afterEach(async () => {
  vi.restoreAllMocks()
  // Let any pending asynchronously-persisted scheduler snapshot settle first.
  // Recursive `rm` is not atomic: a fire-and-forget scheduler write (track/fire
  // persisting `scheduler/retry-scheduler.json`) can land between the directory
  // listing and the final `rmdir`, which then fails with ENOTEMPTY on Windows.
  // Retry briefly so late writes can settle (same precedent as
  // routine-scheduler-service and claude-code-driver tests).
  await new Promise((resolve) => setTimeout(resolve, 25))
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }))
  )
})

async function storage(): Promise<StorageEngine> {
  const scratch = join(process.cwd(), '.cio/tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'codeinoven-retry-scheduler-'))
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
    issueMessage: 'Usage limit reached   retry after reset.',
    ...overrides
  }
}

describe('RetrySchedulerService', () => {
  it('tracks a pending reset retry and exposes it', async () => {
    const scheduler = new RetrySchedulerService(await storage())
    await scheduler.start()
    const saved = record()
    expect(await scheduler.track(saved)).toBe(true)
    expect(scheduler.getPendingRetry('session-1')).toEqual(saved)
    await scheduler.flush()
    scheduler.stop()
  })

  it('restores pending retries across app restarts (persisted)', async () => {
    const storageEngine = await storage()
    const first = new RetrySchedulerService(storageEngine)
    await first.start()
    const saved = record({ retryAt: Date.now() + 120_000 })
    await first.track(saved)
    // Wait for the serialized atomic write to land before simulating shutdown.
    await first.flush()
    first.dispose()

    const restarted = new RetrySchedulerService(storageEngine)
    await restarted.start()
    const pending = restarted.getPendingRetry('session-1')
    expect(pending).toEqual(saved)
    restarted.stop()
  })

  it('admits all six due retries in pairs without waiting for their turns to finish', async () => {
    const scheduler = new RetrySchedulerService(await storage())
    await scheduler.start()
    scheduler.setEnabled(false)
    const due = Array.from({ length: 6 }, (_, index) =>
      record({
        sessionId: `session-${index}`,
        threadId: `thread-${index}`,
        retryAt: Date.now() - 1_000
      })
    )
    for (const pending of due) await scheduler.track(pending)
    const finishers: Array<() => void> = []
    const resume = vi.fn(() => new Promise<void>((resolve) => finishers.push(resolve)))
    await scheduler.attachContinue(resume)
    scheduler.setEnabled(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resume).toHaveBeenCalledTimes(2)
    for (const pending of due) {
      scheduler.clear(pending.sessionId)
      scheduler.resumed(pending.sessionId)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(resume).toHaveBeenCalledTimes(6)
    for (const pending of due) expect(resume).toHaveBeenCalledWith(pending)
    for (const finish of finishers) finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(scheduler.size).toBe(0)
    await scheduler.flush()
    scheduler.stop()
  })

  it('clears a pending record explicitly (e.g. native resume / stop)', async () => {
    const scheduler = new RetrySchedulerService(await storage())
    await scheduler.start()
    await scheduler.track(record())
    scheduler.clear('session-1')
    expect(scheduler.getPendingRetry('session-1')).toBeUndefined()
    await scheduler.flush()
    scheduler.stop()
  })

  it('does not track or resume when the auto-retry toggle is disabled', async () => {
    const scheduler = new RetrySchedulerService(await storage())
    await scheduler.start()
    scheduler.setEnabled(false)
    const resume = vi.fn(async () => undefined)
    await scheduler.attachContinue(resume)
    // The wait is still recorded (it backs the manual "Waiting to retry"
    // card), but with the toggle off `tick` never fires it: the resume
    // callback must not be invoked.
    expect(await scheduler.track(record({ retryAt: Date.now() - 1 }))).toBe(true)
    expect(scheduler.getPendingRetry('session-1')).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resume).not.toHaveBeenCalled()
    await scheduler.flush()
    scheduler.stop()
  })
})
