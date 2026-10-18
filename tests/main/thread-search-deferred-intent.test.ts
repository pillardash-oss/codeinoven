import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ThreadSearchService,
  type IntentSearchProvider
} from '../../src/lib/engines/thread-manager-search'
import { ThreadRepo } from '../../src/main/database/repositories/thread-repo'
import type { Database } from '../../src/main/database/database'
import type { ThreadSearchResult } from '../../src/lib/types'
import { createTestDb, destroyTestDb } from './database/test-helper'

/**
 * The spotlight's thread search ranks by meaning without ever making the reader
 * wait for the model.
 *
 * The keyword answer is the rows the panel shows; the merged hybrid ranking is
 * handed to the deferred callback once the local model has answered, however
 * long that takes (a cold boot is measured in tens of seconds). The panels' own
 * search buttons never consult the model at all, so a keyword search must not
 * touch the provider.
 */

const PROJECT_ID = 'p-search'
const KEYWORD_THREAD_ID = 'thread-title-match'
const INTENT_THREAD_ID = 'thread-intent-match'

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

describe('thread search deferred intent', () => {
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

  it('answers with keyword rows without waiting for the semantic step', async () => {
    const provider = vi.fn<IntentSearchProvider>(async () => {
      await delay(250)
      return [{ threadId: INTENT_THREAD_ID, score: 0.9 }]
    })
    service.setIntentProvider(provider)
    const deferred = vi.fn<(results: ThreadSearchResult[]) => void>()

    const results = await service.searchWithDeferredIntent('ranking', {}, deferred)

    expect(results.map((result) => result.thread.id)).toEqual([KEYWORD_THREAD_ID])
    expect(deferred).not.toHaveBeenCalled()
    await delay(500)
    expect(deferred).toHaveBeenCalledTimes(1)
  })

  it('hands the merged hybrid ranking to the deferred callback', async () => {
    service.setIntentProvider(async () => [{ threadId: INTENT_THREAD_ID, score: 0.93 }])
    const deferred = vi.fn<(results: ThreadSearchResult[]) => void>()

    const keyword = await service.searchWithDeferredIntent('ranking', {}, deferred)
    await delay(100)

    expect(keyword.map((result) => result.thread.id)).toEqual([KEYWORD_THREAD_ID])
    expect(deferred).toHaveBeenCalledTimes(1)
    const merged = deferred.mock.calls[0]?.[0] ?? []
    expect(merged.map((result) => [result.thread.id, result.kind])).toEqual([
      [KEYWORD_THREAD_ID, 'title'],
      [INTENT_THREAD_ID, 'intent']
    ])
  })

  it('never consults the model for a plain keyword search', async () => {
    const provider = vi.fn<IntentSearchProvider>(async () => [
      { threadId: INTENT_THREAD_ID, score: 0.9 }
    ])
    service.setIntentProvider(provider)

    const results = await service.search('ranking', {})

    expect(provider).not.toHaveBeenCalled()
    expect(results.map((result) => result.thread.id)).toEqual([KEYWORD_THREAD_ID])
  })

  it('keeps the keyword answer when the deferred semantic step fails', async () => {
    service.setIntentProvider(async () => {
      throw new Error('the embedding runtime is gone')
    })
    const deferred = vi.fn<(results: ThreadSearchResult[]) => void>()

    const keyword = await service.searchWithDeferredIntent('ranking', {}, deferred)
    await delay(100)

    expect(deferred).not.toHaveBeenCalled()
    expect(keyword.map((result) => result.thread.id)).toEqual([KEYWORD_THREAD_ID])
  })

  it('sends no deferred answer when the semantic step finds nothing', async () => {
    service.setIntentProvider(async () => [])
    const deferred = vi.fn<(results: ThreadSearchResult[]) => void>()

    await service.searchWithDeferredIntent('ranking', {}, deferred)
    await delay(100)

    expect(deferred).not.toHaveBeenCalled()
  })
})
