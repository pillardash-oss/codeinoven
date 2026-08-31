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
import { TurnFeedbackRepo } from '../../src/main/database/repositories/turn-feedback-repo'
import type { TurnFeedbackRow } from '../../src/main/database/repositories/turn-feedback-repo'
import type { GradeTurnOptions } from '../../src/main/drivers/driver.interface'

const temporaryDatabases: Database[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
let temporaryConfigRoot = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-turn-feedback-'))
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

function pendingRow(db: Database, parentTurnId: string): TurnFeedbackRow | undefined {
  return db.get('SELECT * FROM turn_feedback WHERE parent_turn_id = ?', parentTurnId) as
    TurnFeedbackRow | undefined
}

describe('ChatEngine turn-feedback pipeline', () => {
  it('captures a completed turn, grades it through the cheap-model judge, and persists the grade', async () => {
    const fake = makeFakeDriver([4])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    const repo = privateOf<TurnFeedbackRepo>(engine, 'turnFeedbackRepo')
    seedProject(db, 'p1', 't1')

    repo.openPending({
      id: 'outcome:turn-1',
      projectId: 'p1',
      threadId: 't1',
      parentTurnId: 'turn-1',
      createdAt: Date.now(),
      feature: 'main',
      taskSlug: null,
      harnessId: 'opencode',
      providerId: 'openai',
      modelId: 'gpt-5',
      thinkingLevel: 'high',
      costUsd: null,
      costStatus: 'unavailable',
      tokensTotal: null,
      userMessageText: 'fix the login bug',
      assistantOutputText: 'I fixed the login validation.',
      generalDeadlineMs: Date.now() + 30 * 60_000
    })
    // Simulate the 30-minute general deadline having elapsed.
    db.run('UPDATE turn_feedback SET due_at_ms = ? WHERE id = ?', Date.now() - 1_000, 'outcome:turn-1')

    await engine.recoverPendingTurnGrades()

    expect(fake.gradeTurnCalls).toHaveLength(1)
    expect(fake.gradeTurnCalls[0].options.userMessage).toBe('fix the login bug')
    expect(fake.gradeTurnCalls[0].options.assistantOutput).toBe('I fixed the login validation.')
    expect(fake.gradeTurnCalls[0].options.settings.modelId).toBe('gpt-5')
    const row = pendingRow(db, 'turn-1')
    expect(row?.status).toBe('graded')
    expect(row?.grade).toBe(4)
    expect(row?.basis).toBe('general_timeout')
    expect(row?.resolved_at).not.toBeNull()
  })

  it('retries with backoff when the judge fails, keeping the row pending', async () => {
    const fake = makeFakeDriver([null])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    const repo = privateOf<TurnFeedbackRepo>(engine, 'turnFeedbackRepo')
    seedProject(db, 'p1', 't1')

    repo.openPending({
      id: 'outcome:turn-2',
      projectId: 'p1',
      threadId: 't1',
      parentTurnId: 'turn-2',
      createdAt: Date.now(),
      feature: 'main',
      taskSlug: null,
      harnessId: 'pi',
      providerId: null,
      modelId: 'some-model',
      thinkingLevel: null,
      costUsd: null,
      costStatus: 'unavailable',
      tokensTotal: null,
      userMessageText: 'add a settings page',
      assistantOutputText: 'Settings page added.',
      generalDeadlineMs: Date.now() + 30 * 60_000
    })
    db.run('UPDATE turn_feedback SET due_at_ms = ? WHERE id = ?', Date.now() - 1_000, 'outcome:turn-2')

    await engine.recoverPendingTurnGrades()

    const row = pendingRow(db, 'turn-2')
    expect(row?.status).toBe('pending')
    expect(row?.attempt_count).toBe(1)
    expect(fake.gradeTurnCalls).toHaveLength(1)
    // The next attempt is re-armed in the future (base retry is 5 minutes).
    expect(row?.due_at_ms).toBeGreaterThanOrEqual(Date.now() + 4 * 60_000)
  })

  it('marks deleted threads due immediately so their captured turns are still graded', async () => {
    const fake = makeFakeDriver([3])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    const repo = privateOf<TurnFeedbackRepo>(engine, 'turnFeedbackRepo')
    seedProject(db, 'p1', 't1')

    repo.openPending({
      id: 'outcome:turn-3',
      projectId: 'p1',
      threadId: 't1',
      parentTurnId: 'turn-3',
      createdAt: Date.now(),
      feature: 'main',
      taskSlug: null,
      harnessId: 'codex',
      providerId: 'openai',
      modelId: 'gpt-5',
      thinkingLevel: 'medium',
      costUsd: null,
      costStatus: 'unavailable',
      tokensTotal: null,
      userMessageText: 'refactor the parser',
      assistantOutputText: 'Parser refactored.',
      generalDeadlineMs: Date.now() + 30 * 60_000
    })
    // Row is far in the future — deletion must pull it forward to "now".
    repo.scheduleDeleted(['t1'], Date.now())

    await engine.recoverPendingTurnGrades()

    expect(fake.gradeTurnCalls).toHaveLength(1)
    const row = pendingRow(db, 'turn-3')
    expect(row?.status).toBe('graded')
    expect(row?.grade).toBe(3)
    expect(row?.basis).toBe('deleted')
  })

  it('moves pending rows to post-read and draft deadlines once', async () => {
    const fake = makeFakeDriver([])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    const repo = privateOf<TurnFeedbackRepo>(engine, 'turnFeedbackRepo')
    seedProject(db, 'p1', 't1')

    repo.openPending({
      id: 'outcome:turn-4',
      projectId: 'p1',
      threadId: 't1',
      parentTurnId: 'turn-4',
      createdAt: Date.now(),
      feature: 'main',
      taskSlug: null,
      harnessId: 'claude-code',
      providerId: 'anthropic',
      modelId: 'claude-opus',
      thinkingLevel: 'high',
      costUsd: null,
      costStatus: 'unavailable',
      tokensTotal: null,
      userMessageText: 'explain the schema',
      assistantOutputText: 'The schema has three tables.',
      generalDeadlineMs: Date.now() + 30 * 60_000
    })

    // Nothing is due yet — the 30-minute general window is still running.
    expect(repo.listDuePendingWithProject(Date.now())).toHaveLength(0)

    engine.handleThreadReadForGrading('p1', 't1')
    const afterRead = pendingRow(db, 'turn-4')
    expect(afterRead?.due_at_ms).toBeGreaterThan(Date.now() + 4 * 60_000)
    expect(afterRead?.due_at_ms).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1_000)

    // Drafting anchors a fresh 10-minute window, replacing the read window.
    engine.handleThreadDraftChangedForGrading('p1', 't1', true)
    const afterDraft = pendingRow(db, 'turn-4')
    expect(afterDraft?.due_at_ms).toBeGreaterThan(Date.now() + 9 * 60_000)
    expect(afterDraft?.due_at_ms).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 1_000)

    // Nothing fires early and no judge call is made before any deadline.
    expect(repo.listDuePendingWithProject(Date.now())).toHaveLength(0)
    expect(fake.gradeTurnCalls).toHaveLength(0)
  })

  it('grades each captured turn exactly once even when drains overlap', async () => {
    const fake = makeFakeDriver([5])
    const engine = await makeEngine(fake)
    const db = temporaryDatabases[0]
    const repo = privateOf<TurnFeedbackRepo>(engine, 'turnFeedbackRepo')
    seedProject(db, 'p1', 't1')

    repo.openPending({
      id: 'outcome:turn-5',
      projectId: 'p1',
      threadId: 't1',
      parentTurnId: 'turn-5',
      createdAt: Date.now(),
      feature: 'main',
      taskSlug: null,
      harnessId: 'opencode',
      providerId: 'openai',
      modelId: 'gpt-5',
      thinkingLevel: 'low',
      costUsd: null,
      costStatus: 'unavailable',
      tokensTotal: null,
      userMessageText: 'write a migration',
      assistantOutputText: 'Migration written.',
      generalDeadlineMs: Date.now() + 30 * 60_000
    })
    db.run('UPDATE turn_feedback SET due_at_ms = ? WHERE id = ?', Date.now() - 1_000, 'outcome:turn-5')

    await Promise.all([engine.recoverPendingTurnGrades(), engine.recoverPendingTurnGrades()])

    expect(fake.gradeTurnCalls).toHaveLength(1)
    const row = pendingRow(db, 'turn-5')
    expect(row?.status).toBe('graded')
    expect(row?.grade).toBe(5)
  })
})
