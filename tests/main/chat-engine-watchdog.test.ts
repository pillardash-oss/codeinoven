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
  const drivers = (engine as unknown as Record<string, unknown>)['drivers'] as Map<string, unknown>
  drivers.set(id, driver)
}

const baseInfo = { driverId: 'pi', projectId: 'p1', threadId: 't1', projectPath: '/project' }

describe('ChatEngine watchdog   silent-session liveness probe', () => {
  // A wedged RPC transport (pi's documented failure mode) never writes an
  // error to the transcript   it just stops emitting events. Without an
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

describe('ChatEngine watchdog   silent stall ceiling', () => {
  // A half-open provider stream leaves the harness busy with nothing behind it:
  // the in-flight tool it was running never reports completion, so the
  // in-flight exemption re-arms itself forever. These lock in the ceiling that
  // turns that silence into a visible, retryable failure.

  function turnsSessionsOf(engine: ChatEngine): Record<string, unknown> {
    const units = (engine as unknown as Record<string, unknown>)['units'] as Record<
      string,
      Record<string, unknown>
    >
    return units['turns-sessions']
  }

  type StalledInfo = { driverId: string; projectId: string; threadId: string; projectPath: string }

  it('anchors the silence clock on first use and measures from the last harness event', async () => {
    const engine = await makeEngine()
    const unit = turnsSessionsOf(engine)
    const silentElapsedMs = unit['silentStallElapsedMs'] as (info: StalledInfo) => number
    const info: StalledInfo & { lastWorkEventAt?: number } = { ...baseInfo }

    // No event has ever been seen: the clock starts here, never at process boot.
    expect(silentElapsedMs.call(unit, info)).toBe(0)
    expect(info.lastWorkEventAt).toBeGreaterThan(0)

    info.lastWorkEventAt = Date.now() - 90 * 60 * 1000
    expect(silentElapsedMs.call(unit, info)).toBeGreaterThanOrEqual(90 * 60 * 1000)
  })

  it('surfaces a stalled turn as a retryable failure instead of preserving it', async () => {
    const engine = await makeEngine()
    const unit = turnsSessionsOf(engine)
    const seen: Array<{ sessionId: string; issue: Record<string, unknown> }> = []
    unit['failWatchedSession'] = async (
      _info: StalledInfo,
      sessionId: string,
      issue: Record<string, unknown>
    ): Promise<void> => {
      seen.push({ sessionId, issue })
    }

    const failStalledSession = unit['failStalledSession'] as (
      info: StalledInfo,
      sessionId: string,
      silentMs: number
    ) => Promise<void>
    await failStalledSession.call(unit, baseInfo, 'sess-1', 137 * 60 * 1000)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.sessionId).toBe('sess-1')
    expect(seen[0]?.issue).toMatchObject({ kind: 'network', retryable: true, harnessId: 'pi' })
    expect(String(seen[0]?.issue.message)).toContain('137 minutes')
  })

  it('keeps the ceiling at least one full grace window', () => {
    expect(ChatEngine.SILENT_STALL_CEILING_MS).toBeGreaterThan(ChatEngine.SILENT_WORK_GRACE_MS)
  })
})
