import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  BrowserWindow: class {
    getAllWindows(): unknown[] {
      return []
    }
  },
  app: { isPackaged: false, getPath: () => tmpdir() },
  ipcMain: { handle: () => undefined }
}))

import { createTestDb, destroyTestDb } from './database/test-helper'
import type { Database } from '../../src/main/database/database'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { ChatEngine } from '../../src/main/chat/chat-engine'
import type { AgentMessage } from '../../src/lib/types'

const temporaryDatabases: Database[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
let temporaryConfigRoot = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-chat-engine-watchdog-'))
  process.env['CODEINOVEN_CONFIG_ROOT'] = temporaryConfigRoot
})

afterEach(() => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  rmSync(temporaryConfigRoot, { force: true, recursive: true })
  temporaryConfigRoot = ''
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
})

async function makeEngine(): Promise<ChatEngine> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  const storage = new StorageEngine(temporaryConfigRoot)
  return new ChatEngine(storage, db)
}

/** Reach the private recoverWatchdogIssue(sessionId, info) for direct testing. */
function recoverWatchdogIssueOf(
  engine: ChatEngine
): (
  sessionId: string,
  info: Record<string, unknown>
) => Promise<{ kind: string; message: string; retryable: boolean } | null> {
  const candidate = (engine as unknown as Record<string, unknown>)['recoverWatchdogIssue']
  if (typeof candidate !== 'function') throw new Error('recoverWatchdogIssue missing')
  return candidate.bind(engine) as (
    sessionId: string,
    info: Record<string, unknown>
  ) => Promise<{ kind: string; message: string; retryable: boolean } | null>
}

function setDriver(engine: ChatEngine, id: string, driver: Record<string, unknown>): void {
  const drivers = (engine as unknown as Record<string, unknown>)['drivers'] as Map<
    string,
    unknown
  >
  drivers.set(id, driver)
}

const baseInfo = { driverId: 'pi', projectId: 'p1', threadId: 't1', projectPath: '/project' }

describe('ChatEngine watchdog — silent-session liveness probe', () => {
  // A wedged RPC transport (pi's documented failure mode) never writes an
  // error to the transcript — it just stops emitting events. Without an
  // active liveness probe, the watchdog extended the silence window forever
  // and follow-up turns were stuck on a bare "Working..." spinner
  // indefinitely. These lock in the probe's three outcomes.

  it('treats a session the driver reports as still streaming as legitimate silence', async () => {
    const engine = await makeEngine()
    setDriver(engine, 'pi', {
      loadMessages: async (): Promise<AgentMessage[]> => [],
      isSessionBusy: async () => true
    })
    const recover = recoverWatchdogIssueOf(engine)
    await expect(recover('sess-1', baseInfo)).resolves.toBeNull()
  })

  it('surfaces a retryable issue when the driver reports idle but no completion ever arrived', async () => {
    const engine = await makeEngine()
    setDriver(engine, 'pi', {
      loadMessages: async (): Promise<AgentMessage[]> => [],
      isSessionBusy: async () => false
    })
    const recover = recoverWatchdogIssueOf(engine)
    const issue = await recover('sess-1', baseInfo)
    expect(issue).toMatchObject({ kind: 'network', retryable: true })
    expect(issue?.message).toContain('went idle')
  })

  it('surfaces a wedged-connection issue when the liveness probe itself fails', async () => {
    const engine = await makeEngine()
    setDriver(engine, 'pi', {
      loadMessages: async (): Promise<AgentMessage[]> => [],
      isSessionBusy: async () => {
        throw new Error('RPC transport closed')
      }
    })
    const recover = recoverWatchdogIssueOf(engine)
    const issue = await recover('sess-1', baseInfo)
    expect(issue).toMatchObject({ kind: 'network', retryable: true })
    expect(issue?.message).toContain('wedged')
  })

  it('keeps extending silence forever for drivers with no liveness probe capability', async () => {
    const engine = await makeEngine()
    setDriver(engine, 'pi', { loadMessages: async (): Promise<AgentMessage[]> => [] })
    const recover = recoverWatchdogIssueOf(engine)
    await expect(recover('sess-1', baseInfo)).resolves.toBeNull()
  })

  it('still prioritizes an explicit provider error already persisted to the transcript', async () => {
    const engine = await makeEngine()
    setDriver(engine, 'pi', {
      loadMessages: async (): Promise<AgentMessage[]> => [
        {
          id: 'a1',
          role: 'assistant',
          parts: [],
          createdAt: Date.now(),
          harnessId: 'pi',
          error: 'rate limit exceeded'
        }
      ],
      // A live probe must never override a real persisted failure.
      isSessionBusy: async () => true
    })
    const recover = recoverWatchdogIssueOf(engine)
    const issue = await recover('sess-1', baseInfo)
    expect(issue?.message).toBe('rate limit exceeded')
  })
})
