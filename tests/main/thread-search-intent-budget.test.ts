import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  INTENT_SEARCH_BUDGET_MS,
  ThreadSearchService,
  withinBudget,
  type IntentSearchProvider
} from '../../src/lib/engines/thread-manager-search'
import { ThreadRepo } from '../../src/main/database/repositories/thread-repo'
import type { Database } from '../../src/main/database/database'
import { createTestDb, destroyTestDb } from './database/test-helper'

/**
 * An interactive search may not wait on the embedding runtime.
 *
 * Semantic ranking rides the same channel as keyword search, and the local
 * runtime boots its model on demand - measured at 22 s for a cold start on this
 * machine. Held inline, that made the first search of a session sit in a loading
 * state for as long as the model took (and forever when the runtime never
 * answered), which is the bug these tests lock down: the keyword answer is the
 * search, semantic matches only join it when they are ready in time.
 */

const PROJECT_ID = 'p-search'
const KEYWORD_THREAD_ID = 'thread-title-match'
const INTENT_THREAD_ID = 'thread-intent-match'

/** Long enough to outlast the budget by a wide margin, short enough to not hang CI. */
const LATE_MATCH_MS = 5_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

function seedSearchCorpus(db: Database): void {
  db.run(
    `INSERT OR IGNORE INTO projects(id, name, path, source, provider_id, workflow_id, thread_limit, change_tracking_mode, created_at, updated_at)
     VALUES(?, 'Search', '/p', 'local', 'openai', 'default', 70, 'manual', 1, 1)`,
    PROJECT_ID
  )
  for (const [id, title] of [
    [KEYWORD_THREAD_ID, 'Sidebar search ranking'],
    [INTENT_THREAD_ID, 'Something else entirely']
  ] as const) {
    db.run(
      `INSERT INTO threads(id, project_id, provider_id, title, status, pinned, archived, read, scope_bucket_id, created_at, updated_at, last_activity)
       VALUES(?, ?, '', ?, 'created', 0, 0, 1, 'default', 1, 1, 1)`,
      id,
      PROJECT_ID,
      title
    )
  }
}

describe('withinBudget', () => {
  it('returns the work when it lands inside the budget', async () => {
    await expect(
      withinBudget(
        delay(5).then(() => 'ready'),
        500
      )
    ).resolves.toBe('ready')
  })

  it('returns null when the work misses the budget', async () => {
    await expect(
      withinBudget(
        delay(200).then(() => 'late'),
        10
      )
    ).resolves.toBeNull()
  })

  it('observes a rejection that lands after the deadline', async () => {
    // A late rejection must not escape as an unhandled rejection - vitest fails
    // the file on one, so waiting past the loser is the assertion.
    const late = delay(30).then(() => {
      throw new Error('late failure')
    })
    await expect(withinBudget(late, 5)).resolves.toBeNull()
    await delay(80)
  })
})

describe('thread search intent budget', () => {
  let db: Database
  let service: ThreadSearchService

  beforeEach(async () => {
    db = await createTestDb()
    seedSearchCorpus(db)
    service = new ThreadSearchService(db, new ThreadRepo(db))
  })

  afterEach(() => {
    destroyTestDb(db)
  })

  it('answers with the keyword results when semantic matches miss the budget', async () => {
    const slow: IntentSearchProvider = async () => {
      await delay(LATE_MATCH_MS)
      return [{ threadId: INTENT_THREAD_ID, score: 0.99 }]
    }
    service.setIntentProvider(slow)

    const startedAt = Date.now()
    const results = await service.search('ranking', {})
    const elapsed = Date.now() - startedAt

    expect(elapsed).toBeLessThan(INTENT_SEARCH_BUDGET_MS + 1_000)
    expect(results.map((result) => result.thread.id)).toEqual([KEYWORD_THREAD_ID])
  })

  it('still merges semantic matches that arrive inside the budget', async () => {
    service.setIntentProvider(async () => [{ threadId: INTENT_THREAD_ID, score: 0.93 }])

    const results = await service.search('ranking', {})

    expect(results.map((result) => [result.thread.id, result.kind])).toEqual([
      [KEYWORD_THREAD_ID, 'title'],
      [INTENT_THREAD_ID, 'intent']
    ])
  })

  it('answers with the keyword results when the semantic step fails', async () => {
    service.setIntentProvider(async () => {
      throw new Error('the embedding runtime is gone')
    })

    const results = await service.search('ranking', {})

    expect(results.map((result) => result.thread.id)).toEqual([KEYWORD_THREAD_ID])
  })
})
