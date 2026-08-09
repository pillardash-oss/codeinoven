import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Worker } from 'worker_threads'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Database } from './database'
import { DatabaseWorker, DATABASE_WORKER_DEFAULTS } from './database-worker'
import { Logger } from '../logger'
import { ProjectRepo } from './repositories/project-repo'
import { ThreadManager } from '../../lib/engines/thread-manager'
import { HistoryEngine } from '../../lib/engines/history-engine'
import type { AgentMessage } from '../../lib/types'

const databaseDir = dirname(fileURLToPath(import.meta.url))
const workerSource = join(databaseDir, 'database-worker-thread.ts')

// Bundled once for the whole suite: the real worker thread (same code the
// electron-vite `?nodeWorker` factory emits) so these tests exercise the actual
// production wiring against a real SQLite file.
let bundledWorkerPath = ''
const cleanupPaths: string[] = []

async function bundleWorkerOnce(): Promise<string> {
  if (bundledWorkerPath) return bundledWorkerPath
  // Bundle inside the project (a gitignored scratch dir) so the worker's bare
  // `better-sqlite3` import resolves against the project's node_modules.
  const bundleDir = join(process.cwd(), '.cio', 'tmp')
  mkdirSync(bundleDir, { recursive: true })
  const outfile = join(bundleDir, `codeinoven-dbw-${process.pid}-${Date.now()}.mjs`)
  await build({
    entryPoints: [workerSource],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['better-sqlite3', 'worker_threads'],
    outfile,
    logLevel: 'error'
  })
  bundledWorkerPath = outfile
  cleanupPaths.push(outfile)
  return outfile
}

function realWorkerFactory(options: ConstructorParameters<typeof Worker>[1]) {
  return new Worker(bundledWorkerPath, options)
}

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dbw-prod-'))
  cleanupPaths.push(dir)
  return dir
}

function msg(id: string, createdAt: number, text: string): AgentMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', id: `${id}-p`, messageID: id, text }],
    createdAt
  }
}

async function openDatabase(dir: string): Promise<Database> {
  const db = new Database(join(dir, 'app.db'), realWorkerFactory)
  await db.init()
  return db
}

beforeAll(async () => {
  await bundleWorkerOnce()
})

afterAll(() => {
  for (const path of cleanupPaths) {
    rmSync(path, { force: true, recursive: true })
  }
})

describe('DatabaseWorker production wrapper', () => {
  it('starts, answers a typed ping, shuts down gracefully, and can restart', async () => {
    const dir = makeDir()
    const worker = new DatabaseWorker(
      {
        dbPath: join(dir, 'app.db'),
        backupDir: join(dir, 'backups'),
        maintenanceEnabled: false,
        ...DATABASE_WORKER_DEFAULTS
      },
      Logger,
      realWorkerFactory
    )
    worker.start()
    expect(worker.isRunning()).toBe(true)
    await expect(worker.ping()).resolves.toMatchObject({ kind: 'ping', ok: true })

    // Graceful shutdown: typed shutdown sent and awaited before the handle clears.
    await worker.shutdown()
    expect(worker.isRunning()).toBe(false)

    // Restart on the same instance works and serves requests again.
    worker.start()
    expect(worker.isRunning()).toBe(true)
    await expect(worker.ping()).resolves.toMatchObject({ kind: 'ping', ok: true })
    await worker.shutdown()
  })

  it('syncs transcript deltas on the worker and detects in-place edits', async () => {
    const dir = makeDir()
    const db = await openDatabase(dir)
    new ProjectRepo(db).upsert({
      id: 'p1',
      name: 'P',
      path: '/p',
      source: 'local',
      providerId: 'openai',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: 1,
      updatedAt: 1
    })
    const manager = new ThreadManager(db)
    const thread = await manager.createThread({ projectId: 'p1', providerId: 'openai', title: 'T' })

    const a = msg('a', 1, 'first')
    const b = msg('b', 2, 'final')
    const first = await manager.upsertMessages('p1', thread.id, [a, b], 'sess')
    expect(first.applied).toBe(2)

    const noop = await manager.upsertMessages('p1', thread.id, [a, b], 'sess')
    expect(noop.noop).toBe(true)
    expect(noop.applied).toBe(0)

    // Same count, same final id — the in-place edit of `a` must still be written.
    const aEdited: AgentMessage = {
      ...a,
      parts: [{ type: 'text', id: 'a-p', messageID: 'a', text: 'edited' }]
    }
    const edited = await manager.upsertMessages('p1', thread.id, [aEdited, b], 'sess')
    expect(edited.applied).toBe(1)
    expect(edited.skipped).toBe(1)

    await db.close()
  })

  it('restores a backup end to end and passes post-restore integrity', async () => {
    const dir = makeDir()
    const db = await openDatabase(dir)
    db.run(
      `INSERT INTO projects(id, name, path, source, provider_id, workflow_id, thread_limit, change_tracking_mode, created_at, updated_at)
       VALUES('p-restore', 'Restore project', '/restore', 'local', 'openai', 'default', 70, 'manual', 1, 1)`
    )

    const backup = await db.backupDatabaseToDefaultDir()
    expect(backup.ok).toBe(true)
    expect(backup.path).toBeTruthy()
    expect(statSync(backup.path ?? '').size).toBeGreaterThan(0)

    // Mutate the live database after the backup was taken.
    db.run("DELETE FROM projects WHERE id = 'p-restore'")
    expect(db.get('SELECT id FROM projects WHERE id = ?', 'p-restore')).toBeUndefined()

    const restored = await db.restoreFromBackup(backup.path ?? '')
    expect(restored.ok).toBe(true)

    // The primary connection was reopened on the restored inode.
    expect(db.isOpen()).toBe(true)
    const row = db.get<{ id: string }>('SELECT id FROM projects WHERE id = ?', 'p-restore')
    expect(row?.id).toBe('p-restore')

    // The maintenance worker was retained and still serves post-restore integrity.
    const integrity = await db.integrityCheck(true)
    expect(integrity.ok).toBe(true)
    const health = await db.healthCheck()
    expect(health.ok).toBe(true)

    await db.close()
  })

  it('returns an explicit source_invalid kind when restoring a missing backup', async () => {
    const dir = makeDir()
    const db = await openDatabase(dir)
    db.run(
      `INSERT INTO projects(id, name, path, source, provider_id, workflow_id, thread_limit, change_tracking_mode, created_at, updated_at)
       VALUES('p-keep', 'Kept project', '/keep', 'local', 'openai', 'default', 70, 'manual', 1, 1)`
    )

    const failed = await db.restoreFromBackup(join(dir, 'does-not-exist.db'))
    expect(failed.ok).toBe(false)
    expect(failed.reason).toBe('source_invalid')

    // The database stays usable with the unchanged inode.
    expect(db.isOpen()).toBe(true)
    const row = db.get<{ id: string }>('SELECT id FROM projects WHERE id = ?', 'p-keep')
    expect(row?.id).toBe('p-keep')
    const integrity = await db.integrityCheck(true)
    expect(integrity.ok).toBe(true)

    await db.close()
  })

  it('serializes every worker request (flooded worker never overlaps)', async () => {
    const dir = makeDir()
    const worker = new Worker(bundledWorkerPath, {
      workerData: {
        dbPath: join(dir, 'app.db'),
        backupDir: join(dir, 'backups'),
        maintenanceEnabled: false,
        ...DATABASE_WORKER_DEFAULTS
      }
    })
    let nextId = 1
    const pending = new Map<number, (result: unknown) => void>()
    worker.on('message', (msg: { type: string; id: number; result: unknown }) => {
      if (msg.type !== 'response') return
      const resolve = pending.get(msg.id)
      if (resolve) {
        pending.delete(msg.id)
        resolve(msg.result)
      }
    })
    const request = (req: { kind: string }) =>
      new Promise((resolve) => {
        const id = nextId++
        pending.set(id, resolve)
        worker.postMessage({ type: 'request', id, request: req })
      })

    await new Promise((resolve) => worker.once('online', resolve))

    // Flood the worker directly (bypassing the client's single-flight queue)
    // with reads, writes, and a maintenance-style op to prove the mutex
    // serializes. The raw database is schema-empty, so every op must not
    // depend on application tables.
    const requests = [
      ...Array.from({ length: 15 }, () => ({ kind: 'ping' as const })),
      { kind: 'checkpoint' as const, mode: 'passive' as const },
      { kind: 'query' as const, sql: 'SELECT 1 AS one', params: [], maxRows: 1 },
      { kind: 'transaction' as const, statements: [] }
    ]
    const results = await Promise.all(requests.map((req) => request(req)))
    expect(results.every((r) => (r as { ok: boolean }).ok)).toBe(true)

    const stats = (await request({ kind: 'stats' })) as {
      ok: boolean
      maxObservedConcurrency: number
      totalOps: number
    }
    expect(stats.ok).toBe(true)
    expect(stats.totalOps).toBeGreaterThanOrEqual(requests.length)
    expect(stats.maxObservedConcurrency).toBe(1)

    await request({ kind: 'shutdown' })
    await worker.terminate()
  })

  it('keeps the main event loop responsive during heavy worker work (measured proof)', async () => {
    const dir = makeDir()
    const db = await openDatabase(dir)
    db.run(
      `INSERT INTO projects(id, name, path, source, provider_id, workflow_id, thread_limit, change_tracking_mode, created_at, updated_at)
       VALUES('p-meas', 'Measured project', '/measured', 'local', 'openai', 'default', 70, 'manual', 1, 1)`
    )

    const statements: Array<{ sql: string; params: unknown[] }> = []
    for (let i = 0; i < 8000; i++) {
      statements.push({
        sql: 'INSERT INTO db_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        params: [`measured-${i}`, String(i)]
      })
    }

    const started = Date.now()
    const heavy = db.transactionViaWorker(statements)

    // Main-loop responsiveness while the worker is busy: 40 zero-delay timers.
    const tickStart = Date.now()
    await new Promise<void>((resolve) => {
      let remaining = 40
      for (let i = 0; i < 40; i++) {
        setTimeout(() => {
          remaining--
          if (remaining === 0) resolve()
        }, 0)
      }
    })
    const ticksElapsed = Date.now() - tickStart

    const result = await heavy
    const totalElapsed = Date.now() - started
    expect(result.ok).toBe(true)
    expect(totalElapsed).toBeGreaterThan(0)
    // If the write ran on the main thread, the timers would have been queued
    // behind the synchronous transaction and ticksElapsed would approach
    // totalElapsed. Off-main, they complete almost immediately.
    expect(ticksElapsed).toBeLessThan(totalElapsed)
    expect(ticksElapsed).toBeLessThan(500)

    await db.close()
  })

  it('routes thread FTS search through the worker', async () => {
    const dir = makeDir()
    const db = await openDatabase(dir)
    new ProjectRepo(db).upsert({
      id: 'p1',
      name: 'P',
      path: '/p',
      source: 'local',
      providerId: 'openai',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: 1,
      updatedAt: 1
    })
    const manager = new ThreadManager(db)
    const thread = await manager.createThread({ projectId: 'p1', providerId: 'openai', title: 'Redis notes' })
    await manager.upsertMessages('p1', thread.id, [msg('search-1', 1, 'redis persistence internals')], 'sess')

    const found = await manager.searchThreads('redis', { projectId: 'p1' })
    expect(found.some((r) => r.thread.id === thread.id)).toBe(true)
    const titleMatch = await manager.searchThreads('Redis', { projectId: 'p1' })
    expect(titleMatch.some((r) => r.kind === 'title' && r.thread.id === thread.id)).toBe(true)

    await db.close()
  })

  it('fails the restore when reopening the primary connection fails (injected)', async () => {
    const dir = makeDir()
    class FlakyDatabase extends Database {
      failInit = false
      async init(): Promise<void> {
        if (this.failInit) throw new Error('injected reopen failure')
        return super.init()
      }
    }
    const db = new FlakyDatabase(join(dir, 'app.db'), realWorkerFactory)
    await db.init()
    db.run(
      `INSERT INTO projects(id, name, path, source, provider_id, workflow_id, thread_limit, change_tracking_mode, created_at, updated_at)
       VALUES('p-flaky', 'Flaky project', '/flaky', 'local', 'openai', 'default', 70, 'manual', 1, 1)`
    )
    const backup = await db.backupDatabaseToDefaultDir()
    expect(backup.ok).toBe(true)

    db.failInit = true
    const restored = await db.restoreFromBackup(backup.path ?? '')
    expect(restored.ok).toBe(false)
    expect(restored.reason).toBe('io')
    expect(restored.error).toContain('reopening')

    await db.close()
  })

  it('awaits a graceful database close that stops the worker', async () => {
    const dir = makeDir()
    const db = await openDatabase(dir)
    expect(db.hasMaintenanceWorker()).toBe(true)
    await db.close()
    expect(db.isOpen()).toBe(false)
    expect(db.hasMaintenanceWorker()).toBe(false)
  })

  it('production lifecycle: close awaits the worker shutdown before closing the primary', async () => {
    const dir = makeDir()
    const db = await openDatabase(dir)
    expect(db.isOpen()).toBe(true)

    const closePromise = db.close()
    // Synchronously after calling close(), the primary connection is still open
    // — close() awaits the worker's typed shutdown acknowledgment (and clean
    // exit) before closing the primary. A runShutdownPipeline awaiting
    // database.close() therefore never app.quit()s ahead of the storage teardown.
    expect(db.isOpen()).toBe(true)

    await closePromise
    expect(db.isOpen()).toBe(false)
    expect(db.hasMaintenanceWorker()).toBe(false)
  })

  it('routes history CRUD and history FTS through the worker', async () => {
    const dir = makeDir()
    const db = await openDatabase(dir)
    new ProjectRepo(db).upsert({
      id: 'p1',
      name: 'P',
      path: '/p',
      source: 'local',
      providerId: 'openai',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: 1,
      updatedAt: 1
    })
    const manager = new ThreadManager(db)
    const thread = await manager.createThread({ projectId: 'p1', providerId: 'openai', title: 'History' })
    const history = new HistoryEngine(db)

    await history.append('p1', thread.id, 'user', 'alpha history note')
    await history.append('p1', thread.id, 'assistant', 'bravo history note')

    const loaded = await history.load('p1', thread.id)
    expect(loaded.length).toBe(2)
    expect(await history.count('p1', thread.id)).toBe(2)

    const found = await history.search('bravo', 'p1')
    expect(found.some((entry) => entry.content.includes('bravo'))).toBe(true)

    await history.truncate('p1', thread.id, 2)
    expect(await history.count('p1', thread.id)).toBe(1)

    await db.close()
  })

  it('routes page-around, user messages, and subagent transcripts through the worker', async () => {
    const dir = makeDir()
    const db = await openDatabase(dir)
    new ProjectRepo(db).upsert({
      id: 'p1',
      name: 'P',
      path: '/p',
      source: 'local',
      providerId: 'openai',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: 1,
      updatedAt: 1
    })
    const manager = new ThreadManager(db)
    const thread = await manager.createThread({ projectId: 'p1', providerId: 'openai', title: 'Routes' })

    const messages: AgentMessage[] = []
    for (let i = 0; i < 25; i++) {
      messages.push({
        id: `r-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', id: `rp-${i}`, messageID: `r-${i}`, text: `message ${i}` }],
        createdAt: 100 + i
      })
    }
    await manager.upsertMessages('p1', thread.id, messages, 'sess')

    const users = await manager.loadUserMessages('p1', thread.id)
    expect(users.filter((user) => user.id.startsWith('r-'))).toHaveLength(13)

    const around = await manager.loadMessagePageAround('p1', thread.id, 'r-15', 10)
    expect(around.messages.some((m) => m.id === 'r-15')).toBe(true)
    expect(around.messages.length).toBeGreaterThan(0)

    await manager.saveSubagentMessages('p1', thread.id, 'sub-1', [
      {
        id: 's-1',
        role: 'assistant',
        parts: [{ type: 'text', id: 'sp-1', messageID: 's-1', text: 'sub note' }],
        createdAt: 900
      }
    ])
    const sub = await manager.loadSubagentMessages('p1', thread.id, 'sub-1')
    expect(sub).toHaveLength(1)
    expect(sub[0].id).toBe('s-1')

    await db.close()
  })

  it('allocates distinct ordered history sequences under concurrent appends', async () => {
    const dir = makeDir()
    const db = await openDatabase(dir)
    new ProjectRepo(db).upsert({
      id: 'p1',
      name: 'P',
      path: '/p',
      source: 'local',
      providerId: 'openai',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: 1,
      updatedAt: 1
    })
    const manager = new ThreadManager(db)
    const thread = await manager.createThread({ projectId: 'p1', providerId: 'openai', title: 'Concurrent history' })
    const history = new HistoryEngine(db)

    const appends = Array.from({ length: 40 }, (_, i) =>
      history.append('p1', thread.id, 'user', `concurrent entry ${i}`)
    )
    await Promise.all(appends)

    const sequences = db.all<{ sequence: number }>('SELECT "sequence" FROM history_entries ORDER BY "sequence" ASC')
    expect(sequences).toHaveLength(40)
    // Distinct, contiguous, ordered sequences — no two concurrent appends ever
    // allocated the same sequence.
    expect(sequences.map((row) => row.sequence)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1)
    )

    const loaded = await history.load('p1', thread.id)
    expect(loaded).toHaveLength(40)
    expect(loaded.map((entry) => entry.content)).toEqual(
      Array.from({ length: 40 }, (_, i) => `concurrent entry ${i}`)
    )

    await db.close()
  })

  it('returns the full history beyond one page without omission (bounded worker reads)', async () => {
    const dir = makeDir()
    const db = await openDatabase(dir)
    new ProjectRepo(db).upsert({
      id: 'p1',
      name: 'P',
      path: '/p',
      source: 'local',
      providerId: 'openai',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: 1,
      updatedAt: 1
    })
    const manager = new ThreadManager(db)
    const thread = await manager.createThread({ projectId: 'p1', providerId: 'openai', title: 'Large history' })
    const history = new HistoryEngine(db)

    const total = 1250
    const appends: Promise<unknown>[] = []
    for (let i = 0; i < total; i++) {
      appends.push(history.append('p1', thread.id, 'user', `large entry ${i}`))
    }
    // Chunked concurrency so the client still serializes but the load is exercised.
    for (let i = 0; i < appends.length; i += 50) {
      await Promise.all(appends.slice(i, i + 50))
    }

    expect(await history.count('p1', thread.id)).toBe(total)

    // Full-load API returns every row — no silent 1000-row truncation — while
    // each worker query stays bounded (cursor-paged in chunks).
    const loaded = await history.load('p1', thread.id)
    expect(loaded).toHaveLength(total)
    const contents = new Set(loaded.map((entry) => entry.content))
    expect(contents.size).toBe(total)
    expect(loaded[0].content).toBe('large entry 0')
    expect(loaded[total - 1].content).toBe(`large entry ${total - 1}`)

    await db.close()
  })
})
