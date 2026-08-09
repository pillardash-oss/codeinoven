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

    db.close()
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

    db.close()
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

    db.close()
  })
})
