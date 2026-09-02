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
import { ModelRankingRepo } from '../../src/main/database/repositories/model-ranking-repo'
import { ModelRankingSnapshotRepo } from '../../src/main/database/repositories/model-ranking-snapshot-repo'
import type { OpenRankingSnapshotInput } from '../../src/main/database/repositories/model-ranking-snapshot-repo'
import type { AgentMessage, Thread } from '../../src/lib/types'
import type { GradeTurnOptions } from '../../src/main/drivers/driver.interface'

const temporaryDatabases: Database[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
let temporaryConfigRoot = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-model-ranking-'))
  process.env['CODEINOVEN_CONFIG_ROOT'] = temporaryConfigRoot
})

afterEach(() => {
  for (const engine of engines) {
    const timer = (engine as unknown as Record<string, unknown>)['gradeDrainTimer']
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      clearTimeout(timer as ReturnType<typeof setTimeout>)
    }
  }
  engines.splice(0)
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  rmSync(temporaryConfigRoot, { force: true, recursive: true })
  temporaryConfigRoot = ''
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
})

const engines: ChatEngine[] = []

/** A fake harness driver recording every grading request it receives. */
function makeFakeDriver(grades: Array<number | null>): {
  gradeTurnCalls: Array<{ projectPath: string; options: GradeTurnOptions }>
  driver: {
    gradeTurn: (projectPath: string, options: GradeTurnOptions) => Promise<number | null>
  }
} {
  const gradeTurnCalls: Array<{ projectPath: string; options: GradeTurnOptions }> = []
  let index = 0
  return {
    gradeTurnCalls,
    driver: {
      gradeTurn: async (projectPath: string, options: GradeTurnOptions) => {
        gradeTurnCalls.push({ projectPath, options })
        const value = grades[Math.min(index, grades.length - 1)]
        index += 1
        return value
      }
    }
  }
}

function privateOf<T>(engine: ChatEngine, key: string): T {
  const candidate = (engine as unknown as Record<string, unknown>)[key]
  if (candidate === undefined) throw new Error(`${key} missing on ChatEngine`)
  return candidate as T
}

async function makeEngine(fakeDriver: ReturnType<typeof makeFakeDriver>): Promise<ChatEngine> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  const storage = new StorageEngine(temporaryConfigRoot)
  const engine = new ChatEngine(storage, db)
  engines.push(engine)
  // Shadow the private driver resolver so the drain loop hits the fake driver.
  ;(engine as unknown as Record<string, unknown>)['resolve'] = async () => ({
    driver: fakeDriver.driver as never,
    projectPath: temporaryConfigRoot
  })
  return engine
}

function seedProject(db: Database, projectId: string, threadId: string): void {
  db.run(
    `INSERT OR IGNORE INTO projects(id, name, path, source, provider_id, workflow_id, thread_limit, change_tracking_mode, created_at, updated_at)
     VALUES(?, 'Project', '/p', 'local', 'openai', 'default', 70, 'manual', 1, 1)`,
    projectId
  )
  db.run(
    `INSERT INTO threads(id, project_id, provider_id, title, status, pinned, archived, read, scope_bucket_id, created_at, updated_at, last_activity)
     VALUES(?, ?, '', 'created', 'created', 0, 0, 1, 'default', 1, 1, 1)`,
    threadId,
    projectId
  )
}

function userMessage(id: string, text: string, createdAt: number): AgentMessage {
  return {
    id,
    role: 'user',
    origin: 'user',
    parts: [{ type: 'text', id: `${id}-p`, messageID: id, text }],
    createdAt
  }
}

function assistantMessage(id: string, text: string, completedAt: number): AgentMessage {
  return {
    id,
    role: 'assistant',
    origin: 'provider',
    harnessId: 'pi',
    providerId: 'openai',
    modelId: 'gpt-5',
    thinkingLevel: 'high',
    parts: [{ type: 'text', id: `${id}-p`, messageID: id, text }],
    createdAt: completedAt - 5_000,
    completedAt
  }
}

function fakeThread(): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    settings: {
      harnessId: 'pi',
      providerId: 'openai',
      modelId: 'gpt-5',
      thinkingLevel: 'high'
    }
  } as unknown as Thread
}

/** Drive the private capture entry point exactly as the turn pipeline would. */
async function capture(
  engine: ChatEngine,
  user: AgentMessage,
  assistant: AgentMessage
): Promise<void> {
  const openRankingSnapshot = privateOf<
    (thread: Thread, threadId: string, mirror: AgentMessage[], parentTurnId: string, turnAssistant: AgentMessage, awaitingUser: boolean) => Promise<void>
  >(engine, 'openRankingSnapshot')
  await openRankingSnapshot.call(engine, fakeThread(), 't1', [user, assistant], user.id, assistant, false)
  // The worker-offloaded insert settles on the next tick.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function snapshotInput(threadId: string, overrides: Partial<OpenRankingSnapshotInput> = {}): OpenRankingSnapshotInput {
  return {
    threadId,
    projectId: 'p1',
    shotCategory: 'first_shot',
    harnessId: 'pi',
    providerId: 'openai',
    modelId: 'gpt-5',
    thinkingLevel: 'high',
    startedAt: 1_000,
    endedAt: 46_000,
    dueAtMs: Date.now() + 24 * 3_600_000,
    userMessageText: 'fix the login bug',
    assistantOutputText: 'I fixed the login validation.',
    costUsd: 0.02,
    costStatus: 'known',
    ...overrides
  }
}

function snapshotRow(db: Database): Record<string, unknown> | undefined {
  return db.get('SELECT * FROM model_ranking_snapshots LIMIT 1') as
    | Record<string, unknown>
    | undefined
}

/** Let pending microtasks (drain claim, judge dispatch) settle. */
async function flushMicrotasksLikeTurnPipeline(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function aggregateRow(db: Database): Record<string, unknown> | undefined {
  return db.get('SELECT * FROM model_rankings LIMIT 1') as Record<string, unknown> | undefined
}

describe('ChatEngine model-ranking pipeline', () => {
  it('captures a first_shot snapshot with attribution and timestamps', async () => {
    const engine = await makeEngine(makeFakeDriver([null]))
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')
    const started = Date.now() - 45_000
    const ended = Date.now()

    await capture(
      engine,
      userMessage('turn-1', 'fix the login bug', started),
      assistantMessage('turn-2', 'I fixed the login validation.', ended)
    )

    const row = snapshotRow(db)
    expect(row?.['shot_category']).toBe('first_shot')
    expect(row?.['status']).toBe('pending')
    expect(row?.['closed_at_ms']).toBeNull()
    expect(row?.['harness_id']).toBe('pi')
    expect(row?.['provider_id']).toBe('openai')
    expect(row?.['model_id']).toBe('gpt-5')
    expect(row?.['thinking_level']).toBe('high')
    expect(row?.['started_at']).toBe(started)
    expect(row?.['ended_at']).toBe(ended)
    expect(row?.['due_at_ms']).toBeGreaterThan(Date.now() + 23 * 3_600_000)
  })

  it('never captures greeting-only first prompts', async () => {
    const engine = await makeEngine(makeFakeDriver([null]))
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')

    for (const greeting of ['Hello!', '  hi?? ', 'Hey there']) {
      await capture(
        engine,
        userMessage(`turn-${greeting.length}`, greeting, 1_000),
        assistantMessage(`answer-${greeting.length}`, 'Hello to you too.', 46_000)
      )
    }

    expect(snapshotRow(db)).toBeUndefined()
  })

  it('upgrades an open snapshot to multi_shot and keeps the window open', async () => {
    const engine = await makeEngine(makeFakeDriver([null]))
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')

    await capture(
      engine,
      userMessage('turn-1', 'fix the login bug', Date.now() - 90_000),
      assistantMessage('turn-2', 'I fixed the login validation.', Date.now() - 45_000)
    )
    const followUpEnded = Date.now()
    await capture(
      engine,
      userMessage('turn-3', 'now add tests for it', followUpEnded - 5_000),
      assistantMessage('turn-4', 'Tests added.', followUpEnded)
    )

    const row = snapshotRow(db)
    expect(row?.['shot_category']).toBe('multi_shot')
    expect(row?.['follow_up_text']).toBe('now add tests for it')
    expect(row?.['ended_at']).toBe(followUpEnded)
    // The window stays open: grading happens once, at close (deletion or
    // inactivity), never mid-conversation.
    expect(row?.['closed_at_ms']).toBeNull()
    expect(row?.['status']).toBe('pending')
    expect(row?.['due_at_ms']).toBeGreaterThan(Date.now() + 23 * 3_600_000)
  })

  it('keeps later exchanges in the same multi_shot window with accumulated context', async () => {
    const engine = await makeEngine(makeFakeDriver([null]))
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')

    await capture(
      engine,
      userMessage('turn-1', 'fix the login bug', Date.now() - 130_000),
      assistantMessage('turn-2', 'Fixed.', Date.now() - 90_000)
    )
    await capture(
      engine,
      userMessage('turn-3', 'now add tests', Date.now() - 45_000),
      assistantMessage('turn-4', 'Tests added.', Date.now() - 40_000)
    )
    const thirdEnded = Date.now() - 30_000
    await capture(
      engine,
      userMessage('turn-5', 'also update the changelog', thirdEnded - 5_000),
      assistantMessage('turn-6', 'Changelog updated.', thirdEnded)
    )

    // One window per conversation: the third exchange never opens a new
    // first_shot window, so one-shot statistics stay unpolluted.
    const rows = db.all('SELECT * FROM model_ranking_snapshots ORDER BY started_at') as Array<
      Record<string, unknown>
    >
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['shot_category']).toBe('multi_shot')
    expect(rows[0]?.['follow_up_text']).toBe('now add tests\n\nalso update the changelog')
    expect(rows[0]?.['ended_at']).toBe(thirdEnded)
    expect(rows[0]?.['closed_at_ms']).toBeNull()
  })

  it('closes open snapshots when their threads are deleted and grades them', async () => {
    const fake = makeFakeDriver([8])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')
    const repo = privateOf<ModelRankingSnapshotRepo>(engine, 'rankingSnapshotRepo')
    repo.insert(snapshotInput('t1', { dueAtMs: Date.now() + 24 * 3_600_000 }))

    // Deletion is the conversation close signal, wired through ThreadManager.
    const threadManager = privateOf<{
      onThreadsDeletedForRanking?: (projectId: string, threadIds: string[]) => void
    }>(engine, 'threadManager')
    threadManager.onThreadsDeletedForRanking?.('p1', ['t1'])
    await engine.recoverPendingRankingGrades()

    expect(fake.gradeTurnCalls).toHaveLength(1)
    expect(fake.gradeTurnCalls[0].options.userMessage).toBe('fix the login bug')
    expect(fake.gradeTurnCalls[0].options.settings.modelId).toBe('gpt-5')
    // Scored snapshots are hard-deleted; the aggregate holds the result.
    expect(snapshotRow(db)).toBeUndefined()
    const aggregate = aggregateRow(db)
    expect(aggregate?.['one_shot_score_sum']).toBe(8)
    expect(aggregate?.['one_shot_samples']).toBe(1)
  })

  it('grades each closed conversation exactly once even when drains overlap', async () => {
    const fake = makeFakeDriver([9])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')
    const repo = privateOf<ModelRankingSnapshotRepo>(engine, 'rankingSnapshotRepo')
    repo.insert(snapshotInput('t1', { dueAtMs: Date.now() - 1_000 }))

    await Promise.all([engine.recoverPendingRankingGrades(), engine.recoverPendingRankingGrades()])

    expect(fake.gradeTurnCalls).toHaveLength(1)
    expect(snapshotRow(db)).toBeUndefined()
    const aggregate = aggregateRow(db)
    expect(aggregate?.['one_shot_score_sum']).toBe(9)
  })

  it('applies multi-shot scores and agent-window durations to the multi_shot bucket', async () => {
    const fake = makeFakeDriver([6])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')
    const repo = privateOf<ModelRankingSnapshotRepo>(engine, 'rankingSnapshotRepo')
    repo.insert(
      snapshotInput('t1', {
        shotCategory: 'multi_shot',
        dueAtMs: Date.now() - 1_000,
        startedAt: 1_000,
        endedAt: 31_000
      })
    )

    await engine.recoverPendingRankingGrades()

    const aggregate = aggregateRow(db)
    expect(aggregate?.['multi_shot_score_sum']).toBe(6)
    expect(aggregate?.['multi_shot_samples']).toBe(1)
    expect(aggregate?.['multi_shot_duration_sum_ms']).toBe(30_000)
    expect(aggregate?.['one_shot_samples']).toBe(0)
  })

  it('retries judge failures with backoff without touching the aggregate', async () => {
    const fake = makeFakeDriver([null])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')
    const repo = privateOf<ModelRankingSnapshotRepo>(engine, 'rankingSnapshotRepo')
    repo.insert(snapshotInput('t1', { dueAtMs: Date.now() - 1_000 }))

    await engine.recoverPendingRankingGrades()

    const row = snapshotRow(db)
    expect(row?.['status']).toBe('pending')
    expect(row?.['attempt_count']).toBe(1)
    expect(row?.['due_at_ms']).toBeGreaterThanOrEqual(Date.now() + 4 * 60_000)
    expect(aggregateRow(db)).toBeUndefined()
  })

  it('parks exhausted rows as failed for recovery instead of deleting them unscored', async () => {
    const fake = makeFakeDriver([null])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')
    const repo = privateOf<ModelRankingSnapshotRepo>(engine, 'rankingSnapshotRepo')
    repo.insert(snapshotInput('t1', { dueAtMs: Date.now() - 1_000 }))

    // Drive the drain past the attempt cap (5), re-arming the deadline each pass.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      db.run(
        'UPDATE model_ranking_snapshots SET due_at_ms = ? WHERE status = ?',
        Date.now() - 1_000,
        'pending'
      )
      await engine.recoverPendingRankingGrades()
    }

    const row = snapshotRow(db)
    expect(row?.['status']).toBe('failed')
    expect(row?.['attempt_count']).toBe(5)
    expect(aggregateRow(db)).toBeUndefined()
    expect(fake.gradeTurnCalls).toHaveLength(5)
  })

  it('re-queues recovered failed rows and scores them on a later successful pass', async () => {
    const fake = makeFakeDriver([null, null, null, null, null, 7])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')
    const repo = privateOf<ModelRankingSnapshotRepo>(engine, 'rankingSnapshotRepo')
    repo.insert(snapshotInput('t1', { dueAtMs: Date.now() - 1_000 }))

    for (let attempt = 0; attempt < 5; attempt += 1) {
      db.run(
        'UPDATE model_ranking_snapshots SET due_at_ms = ? WHERE status = ?',
        Date.now() - 1_000,
        'pending'
      )
      await engine.recoverPendingRankingGrades()
    }
    expect(snapshotRow(db)?.['status']).toBe('failed')

    // Simulate the recovery cooldown elapsing; the next drain re-queues and scores.
    db.run(
      'UPDATE model_ranking_snapshots SET last_attempt_at_ms = ?',
      Date.now() - 25 * 3_600_000
    )
    await engine.recoverPendingRankingGrades()

    expect(fake.gradeTurnCalls).toHaveLength(6)
    expect(snapshotRow(db)).toBeUndefined()
    const aggregate = aggregateRow(db)
    expect(aggregate?.['one_shot_score_sum']).toBe(7)
    expect(aggregate?.['one_shot_samples']).toBe(1)
  })

  it('never applies a stale pre-follow-up judge result to a re-claimed row', async () => {
    // A judge whose results are released manually, so the stale-result race
    // can be reproduced deterministically.
    const releases: Array<(score: number | null) => void> = []
    const gradeTurnCalls: Array<{ projectPath: string; options: GradeTurnOptions }> = []
    const manualFake = {
      gradeTurnCalls,
      driver: {
        gradeTurn: async (
          projectPath: string,
          options: GradeTurnOptions
        ): Promise<number | null> => {
          gradeTurnCalls.push({ projectPath, options })
          return new Promise<number | null>((resolve) => {
            releases.push(resolve)
          })
        }
      }
    }
    const engine = await makeEngine(manualFake)
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')
    const repo = privateOf<ModelRankingSnapshotRepo>(engine, 'rankingSnapshotRepo')
    repo.insert(snapshotInput('t1', { dueAtMs: Date.now() - 1_000 }))

    // Drain 1 claims the row; its judge hangs in flight.
    const drain1 = engine.recoverPendingRankingGrades()
    await flushMicrotasksLikeTurnPipeline()
    expect(gradeTurnCalls).toHaveLength(1)

    // The follow-up lands mid-flight: the claimed row is pulled back to
    // pending and its claim token is cleared.
    const open = repo.openForThread('t1')
    repo.registerCompletedExchange(open?.id ?? '', 'late follow-up', Date.now(), Date.now() + 86_400_000)

    // The stale pre-follow-up judge result resolves — it must not score.
    releases[0]?.(3)
    await drain1
    expect(aggregateRow(db)).toBeUndefined()
    expect(snapshotRow(db)?.['status']).toBe('pending')

    // The next drain re-claims with a fresh generation and judges the full
    // conversation; only this result may apply.
    db.run('UPDATE model_ranking_snapshots SET due_at_ms = ?', Date.now() - 1_000)
    const drain2 = engine.recoverPendingRankingGrades()
    await flushMicrotasksLikeTurnPipeline()
    expect(gradeTurnCalls).toHaveLength(2)
    expect(gradeTurnCalls[1]?.options.followUp).toBe('late follow-up')
    releases[1]?.(8)
    await drain2

    expect(snapshotRow(db)).toBeUndefined()
    // The late follow-up upgraded the window to multi_shot, so the re-claim
    // scores the multi_shot bucket with the full conversation context.
    const aggregate = aggregateRow(db)
    expect(aggregate?.['multi_shot_score_sum']).toBe(8)
    expect(aggregate?.['multi_shot_samples']).toBe(1)
    expect(aggregate?.['one_shot_samples']).toBe(0)
  })

  it('reports ranking aggregates and grading spend through the repo views', async () => {
    const fake = makeFakeDriver([8])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    seedProject(db, 'p1', 't1')
    const rankingRepo = privateOf<ModelRankingRepo>(engine, 'rankingRepo')
    const repo = privateOf<ModelRankingSnapshotRepo>(engine, 'rankingSnapshotRepo')
    repo.insert(snapshotInput('t1', { dueAtMs: Date.now() - 1_000 }))

    await engine.recoverPendingRankingGrades()

    const view = rankingRepo.analytics()
    expect(view).toHaveLength(1)
    expect(view[0]?.harnessId).toBe('pi')
    expect(view[0]?.providerId).toBe('openai')
    expect(view[0]?.modelId).toBe('gpt-5')
    expect(view[0]?.thinkingLevel).toBe('high')
    expect(view[0]?.oneShot.averageScore).toBe(8)
    expect(view[0]?.oneShot.samples).toBe(1)
    expect(view[0]?.oneShot.averageDurationMs).toBe(45_000)
    expect(view[0]?.oneShot.costUsd).toBeCloseTo(0.02, 10)
    expect(rankingRepo.gradingSpend().costUsd).toBeCloseTo(0.02, 10)
  })

})
