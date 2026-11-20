/**
 * Residency is per harness, not per project.
 *
 * The idle reaper used to release a whole project's runtimes together, so a
 * thread of one harness working in a folder kept another harness's runtime
 * alive: a finished Codex app-server, and the code-mode host it spawned,
 * outlived its own last turn by hours because a Pi thread was busy in the same
 * directory. These tests hold the reaper to the narrower rule   a harness that
 * has nothing in flight releases its own runtime, and its neighbour keeps
 * working.
 */
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
import {
  HarnessIdleLedger,
  harnessProjectKey
} from '../../src/main/chat/chat-engine/chat-engine-harness-idle'

const MINUTE = 60_000
const PROJECT_ID = 'project-1'
const PROJECT_PATH = '/work/project-1'

describe('HarnessIdleLedger', () => {
  it('releases a quiet harness while its neighbour keeps working', () => {
    const ledger = new HarnessIdleLedger()
    ledger.notePath(PROJECT_ID, 'codex', PROJECT_PATH)
    ledger.notePath(PROJECT_ID, 'pi', PROJECT_PATH)

    // One pass with the Pi harness busy: it resets Pi's clock and nothing else.
    ledger.markActive(PROJECT_ID, 'pi')
    expect(ledger.releaseDue(0, MINUTE)).toEqual([])

    // A grace later Pi is still busy, and Codex has been quiet all along.
    ledger.markActive(PROJECT_ID, 'pi')
    expect(ledger.releaseDue(10 * MINUTE, 10 * MINUTE)).toEqual([
      { projectId: PROJECT_ID, driverId: 'codex', paths: [PROJECT_PATH] }
    ])
    // Pi's own resources are untouched, so the next pass still has them.
    expect(ledger.pending).toBe(1)
  })

  it('asks every harness of a project to wait when none is named', () => {
    const ledger = new HarnessIdleLedger()
    ledger.notePath(PROJECT_ID, 'codex', PROJECT_PATH)
    ledger.notePath(PROJECT_ID, 'pi', PROJECT_PATH)
    ledger.markActive(PROJECT_ID)
    expect(ledger.releaseDue(10 * MINUTE, 10 * MINUTE)).toEqual([])
  })

  it('makes a released harness eligible again once it does new work', () => {
    const ledger = new HarnessIdleLedger()
    ledger.notePath(PROJECT_ID, 'codex', PROJECT_PATH)
    // The clock starts at the first pass that finds it quiet, the way an idle
    // grace always does: the release lands one grace later.
    expect(ledger.releaseDue(0, MINUTE)).toEqual([])
    expect(ledger.releaseDue(MINUTE, MINUTE)).toHaveLength(1)
    // Released once is not released forever: the same grace applies to the next
    // burst of work instead of the runtime being released every pass.
    expect(ledger.releaseDue(2 * MINUTE, MINUTE)).toEqual([])

    ledger.notePath(PROJECT_ID, 'codex', PROJECT_PATH)
    ledger.markActive(PROJECT_ID, 'codex')
    expect(ledger.releaseDue(3 * MINUTE, MINUTE)).toEqual([])
    expect(ledger.releaseDue(4 * MINUTE, MINUTE)).toEqual([
      { projectId: PROJECT_ID, driverId: 'codex', paths: [PROJECT_PATH] }
    ])
  })

  it('keys one harness in one project without colliding on the other', () => {
    expect(harnessProjectKey(PROJECT_ID, 'pi')).not.toBe(harnessProjectKey(PROJECT_ID, 'codex'))
    expect(harnessProjectKey(PROJECT_ID, 'pi')).not.toBe(harnessProjectKey('project-2', 'pi'))
  })
})

const temporaryDatabases: Database[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
let temporaryConfigRoot = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-harness-idle-'))
  process.env['CODEINOVEN_CONFIG_ROOT'] = temporaryConfigRoot
})

afterEach(() => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  rmSync(temporaryConfigRoot, { force: true, recursive: true })
  temporaryConfigRoot = ''
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
})

describe('idle reaper', () => {
  it('releases the idle harness and leaves the working one alone', async () => {
    const db = await createTestDb()
    temporaryDatabases.push(db)
    const engine = new ChatEngine(new StorageEngine(temporaryConfigRoot), db)

    const released: string[] = []
    const driver = (id: string): Record<string, unknown> => ({
      id,
      name: id,
      releaseProjectResources: (projectPath: string) => {
        released.push(`${id}:${projectPath}`)
      }
    })
    engine.drivers.set('pi', driver('pi') as never)
    engine.drivers.set('codex', driver('codex') as never)

    for (const [sessionId, driverId, state] of [
      ['codex-session', 'codex', 'idle'],
      ['pi-session', 'pi', 'working']
    ] as const) {
      engine.sessionRegistry.set(sessionId, {
        sessionId,
        projectId: PROJECT_ID,
        threadId: `thread-${driverId}`,
        projectPath: PROJECT_PATH,
        permissionLevel: 'auto_review',
        driverId
      })
      engine.sessionStatuses.set(sessionId, { state })
    }

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const reaper = engine.units['lifecycle-shutdown']
    await reaper.reapIdleResources()
    expect(released).toEqual([])

    // The grace passes with the Pi turn still running: Codex's runtime is unused
    // and must go, Pi's is in use and must stay.
    vi.setSystemTime(new Date(Date.parse('2026-01-01T00:00:00Z') + 11 * MINUTE))
    await reaper.reapIdleResources()
    expect(released).toEqual([`codex:${PROJECT_PATH}`])
    vi.useRealTimers()
  })
})
