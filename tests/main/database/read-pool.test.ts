import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import {
  DatabaseQueries,
  type DatabaseQueriesHost
} from '../../../src/main/database/database/database-queries'
import { DatabaseAsyncReads } from '../../../src/main/database/database/database-async-reads'
import type {
  DatabaseWorker,
  DatabaseWorkerFactory,
  DatabaseWorkerOutbound
} from '../../../src/main/database/database-worker'

/**
 * Reads do not queue behind each other.
 *
 * One worker thread with one connection cannot express that: a statement already
 * running cannot be preempted, so a usage rollup, a search page or a whole-project
 * scan made the next click wait for its turn (the log carries a 1.2 s page behind
 * a 2.1 s rollup behind a 5.9 s search). SQLite in WAL keeps readers out of the
 * writer's way and readers never block each other, so reads get a pool of
 * read-only connections and the writer keeps its own.
 *
 * These lock in both halves: which connection a read is handed, and that two
 * reads asked for at the same moment really do run at once.
 */

interface StubReader {
  name: string
  queries: number
}

function stubReader(name: string): { worker: DatabaseWorker; stub: StubReader } {
  const stub: StubReader = { name, queries: 0 }
  const worker = {
    isRunning: () => true,
    query: async () => {
      stub.queries += 1
      return { ok: true, rows: [], truncated: false }
    },
    queryMessages: async () => {
      stub.queries += 1
      return { ok: true, messages: [], truncated: false }
    },
    queryUserMessages: async () => {
      stub.queries += 1
      return { ok: true, messages: [], truncated: false }
    },
    queryCheckpointSummaries: async () => {
      stub.queries += 1
      return { ok: true, summaries: [], failed: [] }
    }
  } as unknown as DatabaseWorker
  return { worker, stub }
}

describe('the read pool', () => {
  it('hands each read a reader, never the writer, and spreads them round-robin', async () => {
    const readers = [stubReader('first'), stubReader('second'), stubReader('third')]
    let next = 0
    const writerQueries: string[] = []
    const writer = {
      isRunning: () => true,
      query: async () => {
        writerQueries.push('writer')
        return { ok: true, rows: [], truncated: false }
      }
    } as unknown as DatabaseWorker
    const host: DatabaseQueriesHost = {
      getWorker: () => writer,
      getReadWorker: () => readers[next++ % readers.length]!.worker,
      getAsyncWorker: () => null,
      all: () => [],
      syncProviderDeltas: () => ({
        applied: 0,
        skipped: 0,
        collisions: 0,
        duplicatedPrompts: 0,
        total: 0,
        cursor: null,
        noop: true
      })
    }
    const queries = new DatabaseQueries(host)

    for (let index = 0; index < 6; index += 1) {
      await queries.queryViaWorker('SELECT 1', [], 1)
      await queries.queryMessagesViaWorker('SELECT 1', [], 1)
    }

    expect(writerQueries).toEqual([])
    expect(readers.map((reader) => reader.stub.queries)).toEqual([4, 4, 4])
  })

  it('starts three readers for a file database and spreads reads across them', async () => {
    const threads: FakeThread[] = []
    const reads = new DatabaseAsyncReads(
      join(process.cwd(), '.cio', 'tmp', 'read-pool-lane', 'app.db'),
      (() => {
        const thread = new FakeThread()
        threads.push(thread)
        return thread as unknown as Worker
      }) as DatabaseWorkerFactory
    )
    try {
      reads.start()
      expect(threads).toHaveLength(3)
      for (let index = 0; index < 3; index += 1) {
        void reads.getReadWorker()?.query('SELECT 1', [], 1)
      }
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(threads.map((thread) => thread.queries)).toEqual([1, 1, 1])
    } finally {
      await reads.stop()
    }
  })
})

/** A worker thread that answers queries and records them, one per reader. */
class FakeThread extends EventEmitter {
  queries = 0

  postMessage(message: DatabaseWorkerOutbound): void {
    if (message.request.kind === 'shutdown') {
      setImmediate(() => {
        this.emit('message', {
          type: 'response',
          id: message.id,
          result: { kind: 'shutdown', ok: true }
        })
        this.emit('exit', 0)
      })
      return
    }
    if (message.request.kind === 'query' || message.request.kind === 'query-messages') {
      this.queries += 1
    }
    setImmediate(() => {
      this.emit('message', {
        type: 'response',
        id: message.id,
        result: { kind: 'query', ok: true, rows: [], truncated: false }
      })
    })
  }

  async terminate(): Promise<number> {
    return 0
  }
}
