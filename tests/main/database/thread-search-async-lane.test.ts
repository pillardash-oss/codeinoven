import { describe, expect, it, vi } from 'vitest'
import { ThreadSearchService } from '../../../src/lib/engines/thread-manager-search'
import type { Database } from '../../../src/main/database/database'
import type { QueryLane } from '../../../src/main/database/database-worker'
import type { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import type { Thread } from '../../../src/lib/types'

/**
 * A thread search reads on the async lane, never in the queue a click waits in.
 *
 * The database's two worker lanes only decide queue order: a statement already
 * running cannot be preempted, so a one-second FTS search on the interactive
 * lane held the next click for the whole of it. These pin the lane each read of
 * the search asks for, on a host double that records what it was asked, instead
 * of measuring the stall again.
 */

interface RecordedRead {
  sql: string
  maxRows: number
  lane: QueryLane | undefined
}

/** A database double that records the lane of every worker-backed read. */
function fakeSearchHost(
  answer: (sql: string) => {
    ok: boolean
    rows: Record<string, unknown>[]
    truncated: boolean
    error?: string
    timedOut?: boolean
  } = () => ({ ok: true, rows: [], truncated: false })
) {
  const reads: RecordedRead[] = []
  const all = vi.fn((_sql: string, ..._params: unknown[]): Record<string, unknown>[] => [])
  const queryViaWorker = vi.fn(
    async (
      sql: string,
      _params: unknown[],
      maxRows: number,
      options: { lane?: QueryLane } = {}
    ) => {
      reads.push({ sql, maxRows, lane: options.lane })
      return answer(sql)
    }
  )
  return {
    reads,
    all,
    queryViaWorker,
    host: { queryViaWorker, all, isSearchMetaReady: () => true } as unknown as Database
  }
}

/** A thread repository double that records how its hydration read was asked for. */
function fakeThreadRepo(threads: Thread[] = []) {
  const listByIdsViaWorker = vi.fn(async (_ids: readonly string[], _options?: object) => threads)
  return {
    listByIdsViaWorker,
    repo: { listByIdsViaWorker } as unknown as ThreadRepo
  }
}

describe('thread search on the async lane', () => {
  it('asks for the async lane on every read a keyword search issues', async () => {
    const db = fakeSearchHost()
    const repo = fakeThreadRepo()
    const service = new ThreadSearchService(db.host, repo.repo)

    await service.search('redis persistence', { projectId: 'p1' })

    // Both halves of the answer, the title substring and the FTS ranking.
    expect(db.reads).toHaveLength(2)
    for (const read of db.reads) expect(read.lane).toBe('async')
    expect(db.reads.some((read) => read.sql.includes('agent_messages_fts'))).toBe(true)
    expect(db.reads.some((read) => read.sql.includes('snippet('))).toBe(true)
  })

  it('hydrates the semantic matches of a search on the async lane', async () => {
    const db = fakeSearchHost()
    const repo = fakeThreadRepo()
    const service = new ThreadSearchService(db.host, repo.repo)
    service.setIntentProvider(async () => [{ threadId: 'thread-1', score: 0.9 }])

    await service.searchWithIntent('ranking', { projectId: 'p1' }, 5_000)

    expect(repo.listByIdsViaWorker).toHaveBeenCalledTimes(1)
    expect(repo.listByIdsViaWorker).toHaveBeenCalledWith(['thread-1'], { lane: 'async' })
  })

  it('re-issues a failed search on the async lane instead of reading synchronously', async () => {
    const db = fakeSearchHost(() => ({
      ok: false,
      rows: [],
      truncated: false,
      error: 'no maintenance worker'
    }))
    const repo = fakeThreadRepo()
    const service = new ThreadSearchService(db.host, repo.repo)

    const results = await service.search('redis persistence', { projectId: 'p1' })

    // The retry is the same two reads, on the same lane: a failure to answer is
    // never turned into a statement on the main thread. The primary-connection
    // fallback belongs to `queryViaWorker`, which is the call under test here.
    expect(db.reads).toHaveLength(4)
    for (const read of db.reads) expect(read.lane).toBe('async')
    expect(db.all).not.toHaveBeenCalled()
    expect(results).toEqual([])
  })
})
