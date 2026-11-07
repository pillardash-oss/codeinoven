import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn((): unknown[] => []) },
  app: { isPackaged: false, getPath: () => tmpdir() },
  ipcMain: { handle: () => undefined }
}))

import { createTestDb, destroyTestDb } from './database/test-helper'
import type { Database } from '../../src/main/database/database'
import { ProjectRepo } from '../../src/main/database/repositories/project-repo'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { TRANSIENT_PROVIDER_RETRY_MS } from '../../src/lib/provider-issue'
import { RETRY_FIRE_GRACE_MS } from '../../src/main/chat/chat-engine/chat-engine-constants'
import { ChatEngine } from '../../src/main/chat/chat-engine'
import { RetrySchedulerService } from '../../src/main/system/retry-scheduler-service'
import type { PendingRetryRecord } from '../../src/main/system/retry-scheduler-service'
import type { ConnectivitySource } from '../../src/main/system/connectivity-service'
import type {
  AgentMessage,
  AgentProviderIssue,
  AgentSessionStatus,
  CreateThreadInput,
  Thread
} from '../../src/lib/types'

/**
 * A device that loses its Wi-Fi takes its harness process with it, and the
 * failure that comes back is not always shaped like a transport error: a killed
 * process reports an exit, an empty stream, a driver-specific string, and most
 * of those classify as `unknown`. Treating that as a terminal verdict parked
 * the thread on an error card with nothing left listening for the reconnection  
 * the card's own promise. These lock in the engine's side of that promise: a
 * connection failure is a wait on the resume ledger whatever killed the turn,
 * and a provider that stated its own verdict keeps it.
 */

const PROJECT_ID = 'p1'
const SESSION_ID = 'sess-1'
const PROJECT_PATH = '/project'

const settings = {
  harnessId: 'pi',
  providerId: 'openai',
  modelId: 'gpt-5',
  thinkingLevel: 'medium' as const,
  permissionLevel: 'auto_review' as const
}

interface EngineInternals {
  threadManager: {
    createThread(input: CreateThreadInput): Promise<Thread>
    getThread(projectId: string, threadId: string): Promise<Thread | null>
    setSessionId(
      projectId: string,
      threadId: string,
      sessionId: string,
      harnessId?: string,
      accountId?: string
    ): Promise<Thread>
  }
  sessionRegistry: Map<string, { ephemeral?: boolean }>
  sessionStatuses: Map<string, AgentSessionStatus>
  registerSession(
    sessionId: string,
    projectId: string,
    threadId: string,
    projectPath: string,
    permissionLevel: 'auto_review',
    driverId: string
  ): void
  handleProviderFailure(sessionId: string, issue: AgentProviderIssue, error?: string): Promise<void>
}

const temporaryDatabases: Database[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
let temporaryConfigRoot = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-connection-resume-'))
  process.env['CODEINOVEN_CONFIG_ROOT'] = temporaryConfigRoot
})

afterEach(() => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  rmSync(temporaryConfigRoot, { force: true, recursive: true })
  temporaryConfigRoot = ''
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
})

function internals(engine: ChatEngine): EngineInternals {
  return engine as unknown as EngineInternals
}

/**
 * A connectivity source with no network behind it. The default is a device with
 * a working link; the connection-loss tests flip it the other way.
 */
function connectivitySource(overrides: Partial<ConnectivitySource> = {}): ConnectivitySource {
  return {
    isOnline: () => true,
    isOffline: () => false,
    wasOfflineWithin: () => false,
    invalidate: () => undefined,
    onRestored: () => () => undefined,
    ...overrides
  }
}

/** Let the engine's detached failure handling (schedule, persist) settle. */
async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function waitingIssue(engine: ChatEngine, sessionId: string): AgentProviderIssue | null {
  const status = internals(engine).sessionStatuses.get(sessionId)
  return status?.state === 'waiting' ? status.issue : null
}

async function setup(
  connectivity: ConnectivitySource
): Promise<{ engine: ChatEngine; scheduler: RetrySchedulerService; threadId: string }> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  new ProjectRepo(db).upsert({
    id: PROJECT_ID,
    name: 'Project',
    path: PROJECT_PATH,
    source: 'local',
    providerId: 'openai',
    workflowId: 'default',
    threadLimit: 10,
    changeTrackingMode: 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const storage = new StorageEngine(temporaryConfigRoot)
  const engine = new ChatEngine(storage, db)
  const thread = await internals(engine).threadManager.createThread({
    projectId: PROJECT_ID,
    providerId: 'pi',
    title: 'Lose the connection',
    settings
  })
  // The turn's session is registered, but no driver backs it: a Wi-Fi drop is
  // exactly what takes the harness process away, and the wait must survive that.
  internals(engine).registerSession(
    SESSION_ID,
    PROJECT_ID,
    thread.id,
    PROJECT_PATH,
    'auto_review',
    'pi'
  )
  engine.attachConnectivity(connectivity)
  const scheduler = new RetrySchedulerService(storage)
  engine.attachRetryScheduler(scheduler)
  return { engine, scheduler, threadId: thread.id }
}

describe('ChatEngine connection waits', () => {
  it('parks a connection failure on the resume ledger even when its driver is gone', async () => {
    const { engine, scheduler, threadId } = await setup(connectivitySource())
    // The deadline is what puts the wait on the scheduler's clock, so it is
    // measured from the moment the failure was handled rather than the moment
    // the assertion runs (the failed-turn transcript capture in between is a
    // test-environment artifact of the lazily created driver).
    const handledAt = Date.now()
    await internals(engine).handleProviderFailure(
      SESSION_ID,
      { kind: 'network', message: 'Connection error.', harnessId: 'pi', retryable: true },
      'Connection error.'
    )
    await settle()

    const thread = await internals(engine).threadManager.getThread(PROJECT_ID, threadId)
    expect(thread?.status).toBe('working-paused')
    const retained = scheduler.getPendingRetry(SESSION_ID)
    expect(retained?.issueKind).toBe('network')
    expect(retained?.retryAt ?? 0).toBeGreaterThanOrEqual(handledAt)
  })

  it('re-reads a failure with no provider verdict as a connection wait while the device is offline', async () => {
    const { engine, scheduler, threadId } = await setup(
      connectivitySource({ isOffline: () => true, wasOfflineWithin: () => true })
    )
    await internals(engine).handleProviderFailure(
      SESSION_ID,
      {
        kind: 'unknown',
        message: 'Harness process exited unexpectedly',
        harnessId: 'pi',
        retryable: false
      },
      'Harness process exited unexpectedly'
    )
    await settle()

    const issue = waitingIssue(engine, SESSION_ID)
    expect(issue?.kind).toBe('network')
    expect(issue?.message).toContain('resume automatically when the device reconnects')
    const thread = await internals(engine).threadManager.getThread(PROJECT_ID, threadId)
    expect(thread?.status).toBe('working-paused')
    expect(scheduler.getPendingRetry(SESSION_ID)?.issueKind).toBe('network')
  })

  it('re-reads a failure inside the connection-loss window, before the probe flips back', async () => {
    const { engine, scheduler } = await setup(
      connectivitySource({ isOnline: () => false, wasOfflineWithin: () => true })
    )
    await internals(engine).handleProviderFailure(
      SESSION_ID,
      { kind: 'unknown', message: 'Agent session failed', harnessId: 'pi', retryable: false },
      'Agent session failed'
    )
    await settle()

    expect(waitingIssue(engine, SESSION_ID)?.kind).toBe('network')
    expect(scheduler.getPendingRetry(SESSION_ID)?.issueKind).toBe('network')
  })

  it('leaves a provider verdict the user has to act on alone', async () => {
    const { engine, scheduler, threadId } = await setup(
      connectivitySource({ isOffline: () => true, wasOfflineWithin: () => true })
    )
    await internals(engine).handleProviderFailure(
      SESSION_ID,
      {
        kind: 'authentication',
        message: 'Provider sign-in required',
        harnessId: 'pi',
        retryable: false
      },
      'Provider sign-in required'
    )
    await settle()

    // The device is offline, but the provider stated something only the user
    // can fix: masking it behind a connection card would hide that action.
    const thread = await internals(engine).threadManager.getThread(PROJECT_ID, threadId)
    expect(thread?.status).toBe('failed')
    expect(scheduler.getPendingRetry(SESSION_ID)).toBeUndefined()
  })

  it('drops a connection wait whose thread has already moved on', async () => {
    const { engine, scheduler, threadId } = await setup(connectivitySource())
    await internals(engine).threadManager.setSessionId(PROJECT_ID, threadId, 'sess-live', 'pi')
    const stale: PendingRetryRecord = {
      sessionId: 'sess-gone',
      projectId: PROJECT_ID,
      threadId,
      harnessId: 'pi',
      retryAt: Date.now() - 1_000,
      issueKind: 'network',
      issueMessage: 'Connection interrupted.'
    }
    await scheduler.track(stale)

    const sendPrompt = vi.spyOn(engine, 'sendPrompt')
    await engine.continueScheduledThread(stale)

    // Nothing to resume: the wait cannot be admitted for a session the thread no
    // longer owns, so it leaves the ledger instead of being retried forever.
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(scheduler.getPendingRetry('sess-gone')).toBeUndefined()
  })
})

/** Schedulers only need the driver to exist; the transient path never calls it. */
function setPiDriver(engine: ChatEngine): void {
  const drivers = (engine as unknown as { drivers: Map<string, unknown> }).drivers
  drivers.set('pi', { loadMessages: async (): Promise<AgentMessage[]> => [] })
}

const ONE_MINUTE = 60 * 1_000
const ONE_DAY = 24 * 60 * ONE_MINUTE

/**
 * The OpenCode Go incident of 2026-11-05: a transient upstream `[overloaded]`
 * 429 was classified `provider_unavailable`, treated as an account usage
 * window, and parked on the account's monthly reset. The thread sat paused for
 * weeks with nothing to wait for. These lock in the rule that keeps every
 * thread out of that trap: only a quota or rate limit may become a window wait.
 */
describe('ChatEngine transient provider waits', () => {
  it('retries an overloaded provider in a minute instead of the account window', async () => {
    const { engine, scheduler, threadId } = await setup(connectivitySource())
    setPiDriver(engine)
    // If this is ever consulted, the thread is back on the monthly reset.
    const deriveUsageResetRetryAt = vi.spyOn(
      engine.units['turns-dispatch'],
      'deriveUsageResetRetryAt'
    )
    deriveUsageResetRetryAt.mockResolvedValue(Date.now() + 30 * ONE_DAY)

    const handledAt = Date.now()
    await internals(engine).handleProviderFailure(
      SESSION_ID,
      {
        kind: 'provider_unavailable',
        message:
          '429: {"type":"server_error","message":"Upstream request failed: [overloaded], retry shortly"}',
        harnessId: 'pi',
        retryable: true
      },
      '429 overloaded'
    )
    await settle()

    expect(deriveUsageResetRetryAt).not.toHaveBeenCalled()
    const retained = scheduler.getPendingRetry(SESSION_ID)
    expect(retained?.issueKind).toBe('provider_unavailable')
    expect(retained?.retryAt).toBeGreaterThanOrEqual(
      handledAt + TRANSIENT_PROVIDER_RETRY_MS - 1_000
    )
    expect(retained?.retryAt).toBeLessThanOrEqual(handledAt + TRANSIENT_PROVIDER_RETRY_MS + 5_000)
    expect(retained?.resetAt).toBe(retained?.retryAt)
    const thread = await internals(engine).threadManager.getThread(PROJECT_ID, threadId)
    expect(thread?.status).toBe('working-paused')
  })

  it('ignores a usage reset attached to a transient outage and keeps the short backoff', async () => {
    const { engine, scheduler } = await setup(connectivitySource())
    setPiDriver(engine)
    const handledAt = Date.now()

    // The original poison in one shape: an account window leaking onto a
    // provider-load failure. A window may only ever explain a quota or a rate
    // limit, so this deadline must be discarded rather than obeyed.
    await internals(engine).handleProviderFailure(
      SESSION_ID,
      {
        kind: 'provider_unavailable',
        message: '429: Upstream request failed: [overloaded]',
        harnessId: 'pi',
        retryable: true,
        retryAt: handledAt + 30 * ONE_DAY
      },
      '429 overloaded'
    )
    await settle()

    const retained = scheduler.getPendingRetry(SESSION_ID)
    expect(retained?.issueKind).toBe('provider_unavailable')
    expect(retained?.retryAt).toBeLessThanOrEqual(handledAt + TRANSIENT_PROVIDER_RETRY_MS + 5_000)
    expect(retained?.retryAt).toBeGreaterThanOrEqual(
      handledAt + TRANSIENT_PROVIDER_RETRY_MS - 1_000
    )
  })

  it('still parks a genuine usage limit on the provider reset it named', async () => {
    const { engine, scheduler } = await setup(connectivitySource())
    setPiDriver(engine)
    const resetAt = Date.now() + 5 * ONE_DAY

    await internals(engine).handleProviderFailure(
      SESSION_ID,
      {
        kind: 'quota',
        message: 'Go usage limit exceeded',
        harnessId: 'pi',
        retryable: true,
        retryAt: resetAt
      },
      'Go usage limit exceeded'
    )
    await settle()

    const retained = scheduler.getPendingRetry(SESSION_ID)
    expect(retained?.issueKind).toBe('quota')
    // The window is the provider's own reset; the fire time clears the rollover
    // by the grace window so the retry cannot race the reset second.
    expect(retained?.resetAt).toBe(resetAt)
    expect(retained?.retryAt).toBe(resetAt + RETRY_FIRE_GRACE_MS)
  })

  it('leaves a provider_unavailable the harness called terminal off the retry ledger', async () => {
    const { engine, scheduler, threadId } = await setup(connectivitySource())
    setPiDriver(engine)

    await internals(engine).handleProviderFailure(
      SESSION_ID,
      {
        kind: 'provider_unavailable',
        message: 'The provider is not installed',
        harnessId: 'pi',
        retryable: false
      },
      'The provider is not installed'
    )
    await settle()

    // Not every unavailable provider is worth retrying: a terminal verdict must
    // fail visibly instead of waking up again and again.
    expect(scheduler.getPendingRetry(SESSION_ID)).toBeUndefined()
    const thread = await internals(engine).threadManager.getThread(PROJECT_ID, threadId)
    expect(thread?.status).toBe('failed')
  })
})
