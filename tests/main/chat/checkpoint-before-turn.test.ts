import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'

// The checkpoint broadcasts a thread update after the swap, and the thread-events
// module reaches for Electron's windows.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn((): unknown[] => []) },
  app: { isPackaged: false, getPath: () => tmpdir() },
  ipcMain: { handle: () => undefined }
}))
import { ChatEngineCheckpoints } from '../../../src/main/chat/chat-engine/chat-engine-checkpoints'
import type { ChatEngine } from '../../../src/main/chat/chat-engine'
import type { HarnessDriver } from '../../../src/main/drivers/driver.interface'
import type {
  ThreadCheckpoint,
  ThreadCheckpointKind,
  ThreadSettings,
  Thread
} from '../../../src/lib/types'

/**
 * The checkpoint is the app's replacement for harness compaction: the session is
 * closed and a successor continues the same thread. These lock in what makes that
 * safe — it fires only past the line, the successor is bound and registered, the
 * boundary is recorded, and a failure leaves the turn on the session it had
 * rather than a row that promises a continuation which never happened.
 */

const settings: ThreadSettings = {
  harnessId: 'pi',
  providerId: 'openai',
  modelId: 'gpt-5',
  thinkingLevel: 'medium',
  permissionLevel: 'auto_review'
}

interface StubOptions {
  used?: number
  createSessionFails?: boolean
}

function stubHost(options: StubOptions = {}): {
  host: ChatEngine
  created: ThreadCheckpoint[]
  closed: { id: string; closed: Record<string, unknown> }[]
  deleted: string[]
  registerSession: ReturnType<typeof vi.fn>
  setSessionId: ReturnType<typeof vi.fn>
  createSession: ReturnType<typeof vi.fn>
} {
  const created: ThreadCheckpoint[] = []
  const closed: { id: string; closed: Record<string, unknown> }[] = []
  const deleted: string[] = []
  const registerSession = vi.fn()
  const setSessionId = vi.fn(async () => ({ id: 'thread-1', title: 'Checkpoint thread' }))
  const createSession = vi.fn(async () => {
    if (options.createSessionFails) throw new Error('harness refused a new session')
    return 'session-2'
  })
  const host = {
    checkpoints: {
      create: (input: {
        threadId: string
        kind: ThreadCheckpointKind
        harnessId: string
        sessionId: string
        projectPath?: string
      }) => {
        const row: ThreadCheckpoint = {
          id: `cp-${created.length + 1}`,
          threadId: input.threadId,
          sequence: created.length + 1,
          kind: input.kind,
          harnessId: input.harnessId,
          sessionId: input.sessionId,
          projectPath: input.projectPath ?? '',
          createdAt: 1
        }
        created.push(row)
        return row
      },
      close: (id: string, patch: Record<string, unknown>) => {
        closed.push({ id, closed: patch })
      },
      delete: (id: string) => {
        deleted.push(id)
      },
      boundaryViaWorker: async () => ({ id: 'msg-9', createdAt: 1234 }),
      listViaWorker: async () => created
    },
    threadManager: {
      getThread: async () => ({ id: 'thread-1', title: 'Checkpoint thread', settings }),
      setSessionId
    },
    registerSession,
    resolve: async () => ({
      driver: {
        id: 'pi',
        name: 'Pi',
        createSession
      } as unknown as HarnessDriver,
      projectPath: '/tmp/project-1'
    }),
    units: {
      'runtime-agents': { selectedModelInputBudget: () => 100_000 },
      transcripts: {
        lastSessionContextUsed: async () => options.used,
        modelContextWindow: () => 200_000
      }
    },
    state: {
      sessionNativeHistory: new Map<string, boolean>(),
      accountRegistry: { resolveForProvider: async () => ({ id: 'account-1' }) }
    }
  }
  return {
    host: host as unknown as ChatEngine,
    created,
    closed,
    deleted,
    registerSession,
    setSessionId,
    createSession
  }
}

async function beforeTurn(
  unit: ChatEngineCheckpoints,
  host: ChatEngine,
  sessionId = 'session-1'
): Promise<string | undefined> {
  return unit.checkpointBeforeTurn({
    projectId: 'project-1',
    threadId: 'thread-1',
    sessionId,
    driver: {
      id: 'pi',
      name: 'Pi',
      createSession: vi.fn(async () => 'session-2')
    } as unknown as HarnessDriver,
    projectPath: '/tmp/project-1',
    settings
  })
}

describe('ChatEngineCheckpoints', () => {
  it('closes the session past the line and continues on a successor', async () => {
    const stub = stubHost({ used: 90_000 })
    const unit = new ChatEngineCheckpoints(stub.host)
    const successor = await beforeTurn(unit, stub.host)

    expect(successor).toBe('session-2')
    expect(stub.created).toHaveLength(1)
    expect(stub.created[0]).toMatchObject({
      threadId: 'thread-1',
      kind: 'auto',
      harnessId: 'pi',
      sessionId: 'session-1'
    })
    expect(stub.closed).toEqual([
      {
        id: 'cp-1',
        closed: {
          nextSessionId: 'session-2',
          tokensBefore: 90_000,
          contextWindow: 200_000,
          boundaryMessageId: 'msg-9',
          boundaryCreatedAt: 1234
        }
      }
    ])
    expect(stub.setSessionId).toHaveBeenCalledWith(
      'project-1',
      'thread-1',
      'session-2',
      'pi',
      undefined
    )
    expect(stub.registerSession).toHaveBeenCalled()
    expect(stub.host.state.sessionNativeHistory.get('session-2')).toBe(false)
  })

  it('leaves a session inside its window alone', async () => {
    const stub = stubHost({ used: 10_000 })
    const unit = new ChatEngineCheckpoints(stub.host)
    expect(await beforeTurn(unit, stub.host)).toBeUndefined()
    expect(stub.created).toHaveLength(0)
    expect(stub.setSessionId).not.toHaveBeenCalled()
  })

  it('keeps the turn on the session it has when the successor cannot start', async () => {
    const stub = stubHost({ used: 90_000, createSessionFails: true })
    stub.host.threadManager.getThread = async () =>
      ({
        id: 'thread-1',
        title: 'Checkpoint thread'
      }) as unknown as Thread
    const unit = new ChatEngineCheckpoints(stub.host)
    const driver = {
      id: 'pi',
      name: 'Pi',
      createSession: async () => {
        throw new Error('harness refused a new session')
      }
    } as unknown as HarnessDriver
    const successor = await unit.checkpointBeforeTurn({
      projectId: 'project-1',
      threadId: 'thread-1',
      sessionId: 'session-1',
      driver,
      projectPath: '/tmp/project-1',
      settings
    })
    expect(successor).toBeUndefined()
    // The half-written row must not survive: it promises a continuation that
    // never happened, and every reader would treat it as a real boundary.
    expect(stub.deleted).toEqual(['cp-1'])
  })

  it('records a session another path closed as its own checkpoint', async () => {
    const stub = stubHost()
    const unit = new ChatEngineCheckpoints(stub.host)
    await unit.recordClosedSession({
      projectId: 'project-1',
      threadId: 'thread-1',
      sessionId: 'session-pi',
      harnessId: 'pi',
      nextSessionId: 'session-codex',
      kind: 'harness-switch',
      projectPath: '/tmp/project-1',
      label: 'Moved to another harness'
    })
    expect(stub.created[0]).toMatchObject({
      kind: 'harness-switch',
      harnessId: 'pi',
      sessionId: 'session-pi'
    })
    expect(stub.closed[0]?.closed).toMatchObject({
      nextSessionId: 'session-codex',
      boundaryMessageId: 'msg-9'
    })
  })
})
