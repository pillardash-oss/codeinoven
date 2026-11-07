import { describe, expect, it, vi } from 'vitest'
import { RunBaseRecorder } from '../../src/main/chat/run-receipt/run-receipt-base'
import { RunReceiptService } from '../../src/main/chat/run-receipt-service'
import { RunBaseRecorder as Recorder } from '../../src/main/chat/run-receipt/run-receipt-base'
import type { RunBaseRecord, ScopeBoard, Thread } from '../../src/lib/types'
import { ASSISTANT_SPACE_ID, DEFAULT_SCOPE_BUCKET_ID } from '../../src/lib/types'

/**
 * A run's base is recorded once, at the start, and never moved.
 *
 * Everything a receipt claims depends on this: re-deriving the base at settle
 * time would describe whatever the checkout looks like now, and an unbased run
 * that borrowed today's HEAD would attribute the whole checkout to it.
 */

const PROJECT_ID = 'project1'
const THREAD_ID = 'thread1'

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD_ID,
    projectId: ASSISTANT_SPACE_ID,
    providerId: 'pi',
    title: 'A run',
    titleSource: 'manual',
    status: 'completed',
    pinned: false,
    archived: false,
    read: true,
    boundScope: { projectId: PROJECT_ID, scopeBucketId: DEFAULT_SCOPE_BUCKET_ID },
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp/project',
    ...overrides
  }
}

function recorder(initial: Thread | null) {
  let stored = initial
  const writes: RunBaseRecord[] = []
  const instance = new RunBaseRecorder({
    getThread: async () => stored,
    setRunBase: async (_projectId, _threadId, base) => {
      writes.push(base)
      stored = stored ? { ...stored, runBase: base } : stored
    }
  })
  return { instance, writes }
}

describe('RunBaseRecorder', () => {
  it('writes the base once, with the scope it was taken in', async () => {
    const { instance, writes } = recorder(thread())
    const base = await instance.record(ASSISTANT_SPACE_ID, THREAD_ID, 'abc123', {
      projectId: PROJECT_ID,
      scopeBucketId: DEFAULT_SCOPE_BUCKET_ID
    })
    expect(base?.sha).toBe('abc123')
    expect(base?.projectId).toBe(PROJECT_ID)
    expect(writes).toHaveLength(1)
  })

  it('keeps the original base when a run resumes', async () => {
    const existing: RunBaseRecord = {
      sha: 'first',
      projectId: PROJECT_ID,
      scopeBucketId: DEFAULT_SCOPE_BUCKET_ID,
      recordedAt: 1
    }
    const { instance, writes } = recorder(thread({ runBase: existing }))
    const base = await instance.record(ASSISTANT_SPACE_ID, THREAD_ID, 'second', {
      projectId: PROJECT_ID,
      scopeBucketId: DEFAULT_SCOPE_BUCKET_ID
    })
    expect(base).toEqual(existing)
    expect(writes).toHaveLength(0)
  })

  it('records nothing for a blank sha or a thread that is gone', async () => {
    const present = recorder(thread())
    expect(
      await present.instance.record(ASSISTANT_SPACE_ID, THREAD_ID, '   ', {
        projectId: PROJECT_ID,
        scopeBucketId: DEFAULT_SCOPE_BUCKET_ID
      })
    ).toBeNull()
    expect(present.writes).toHaveLength(0)

    const missing = recorder(null)
    expect(
      await missing.instance.record(ASSISTANT_SPACE_ID, THREAD_ID, 'abc', {
        projectId: PROJECT_ID,
        scopeBucketId: DEFAULT_SCOPE_BUCKET_ID
      })
    ).toBeNull()
    expect(missing.writes).toHaveLength(0)
  })
})

describe('a run with no recorded base', () => {
  const board: ScopeBoard = {
    version: 2,
    buckets: [
      {
        id: DEFAULT_SCOPE_BUCKET_ID,
        name: 'Default',
        sortOrder: 0,
        collapsed: false,
        collapsedSlices: [],
        root: { kind: 'project' }
      }
    ],
    worktreeDefaults: { setupCommands: [], runSetupByDefault: true, environmentMode: 'copy' }
  }

  it('reports no-base rather than borrowing the checkout today', async () => {
    const getStatus = vi.fn()
    const receipts = new RunReceiptService({
      git: {
        getStatus,
        log: vi.fn(async () => []),
        rangeFiles: vi.fn(async () => [])
      },
      threads: { getThread: async () => thread() },
      checks: { listToolMessageParts: async () => [] },
      resolveRoot: async () => '/tmp/project',
      scopeBoard: async () => board,
      bases: new Recorder({
        getThread: async () => thread(),
        setRunBase: async () => undefined
      })
    })
    const receipt = await receipts.read({ projectId: ASSISTANT_SPACE_ID, threadId: THREAD_ID })
    expect(receipt.state).toBe('no-base')
    expect(receipt.baseSha).toBeNull()
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('records the base through the service port, unchanged', async () => {
    const written: RunBaseRecord[] = []
    const service = new RunReceiptService({
      git: { getStatus: vi.fn(), log: vi.fn(), rangeFiles: vi.fn() },
      threads: { getThread: async () => thread() },
      checks: { listToolMessageParts: async () => [] },
      resolveRoot: async () => '/tmp/project',
      scopeBoard: async () => board,
      bases: new Recorder({
        getThread: async () => thread(),
        setRunBase: async (_projectId, _threadId, base) => {
          written.push(base)
        }
      })
    })
    await service.recordBase(ASSISTANT_SPACE_ID, THREAD_ID, 'deadbeef', {
      projectId: PROJECT_ID,
      scopeBucketId: DEFAULT_SCOPE_BUCKET_ID
    })
    expect(written).toHaveLength(1)
    expect(written[0]?.sha).toBe('deadbeef')
  })
})
