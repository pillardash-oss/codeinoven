import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the rule that reads on interaction paths never run SQLite on the
 * Electron main thread.
 *
 * A synchronous read there holds the whole main process for as long as the OS
 * takes to serve it. The same statement that measures 0.04 ms against the real
 * database was measured at 20-890 ms on the main thread, where a page fault into
 * the mmap'd file, a WAL lock wait, or a scheduling gap lands inside the call and
 * stalls a frame. So reads on interaction paths go through
 * `Database.queryViaWorker` (or a repository's `...ViaWorker` method), and the
 * synchronous `get`/`all` API is reserved for startup, migrations, write
 * transactions, and the primary-connection fallback a worker-backed read takes
 * when no worker exists.
 *
 * The table below is that reservation written down: a file plus how many
 * synchronous reads it currently owns. Adding one anywhere, including to a file
 * that already has budget, fails this test. That failure is the point: it asks
 * "does this read belong on the worker?" while the code is being written, instead
 * of surfacing as a slow-operation storm in the user's log weeks later.
 *
 * Passing again means either reading through the worker, or raising the count and
 * saying why in the commit. Lowering a count when a read is converted keeps the
 * table honest. `run`, `prepare` and `transaction` are deliberately out of scope:
 * a write is bounded by its own statement and is normally the tail of an
 * interaction that must be atomic, while a read's cost follows the size of the
 * data it walks.
 */

/** A read a repository exposes on the synchronous API, reached only through the
 *  worker-backed variant on interaction paths. */
const REPOSITORY_READ =
  'repository read on the synchronous API; interaction paths use the ...ViaWorker variant'

/** A read of one of the lifecycle engines, whose callers are turn actions. */
const ENGINE_READ = 'lifecycle engine read on the synchronous API'

interface SyncReadAllowance {
  file: string
  /** Synchronous `db.get` / `db.all` call sites the file is allowed to own. */
  maxSites: number
  reason: string
}

const SYNC_READ_ALLOWANCES: readonly SyncReadAllowance[] = [
  {
    file: 'src/main/database/database.ts',
    maxSites: 1,
    reason: 'the synchronous API itself and its own worker fallback'
  },
  {
    file: 'src/main/database/repositories/agent-message-repo.ts',
    maxSites: 14,
    reason: REPOSITORY_READ
  },
  {
    file: 'src/main/database/repositories/assignment-repo.ts',
    maxSites: 6,
    reason: REPOSITORY_READ
  },
  {
    file: 'src/main/database/repositories/attachment-grant-repo.ts',
    maxSites: 1,
    reason: REPOSITORY_READ
  },
  {
    file: 'src/main/database/repositories/expert-settings-repo.ts',
    maxSites: 1,
    reason: REPOSITORY_READ
  },
  {
    file: 'src/main/database/repositories/harness-usage-repo.ts',
    maxSites: 5,
    reason: REPOSITORY_READ
  },
  { file: 'src/main/database/repositories/history-repo.ts', maxSites: 7, reason: REPOSITORY_READ },
  {
    file: 'src/main/database/repositories/model-ranking-repo.ts',
    maxSites: 3,
    reason: REPOSITORY_READ
  },
  {
    file: 'src/main/database/repositories/model-ranking-snapshot-repo.ts',
    maxSites: 8,
    reason: REPOSITORY_READ
  },
  { file: 'src/main/database/repositories/note-repo.ts', maxSites: 2, reason: REPOSITORY_READ },
  { file: 'src/main/database/repositories/project-repo.ts', maxSites: 5, reason: REPOSITORY_READ },
  { file: 'src/main/database/repositories/routine-repo.ts', maxSites: 1, reason: REPOSITORY_READ },
  { file: 'src/main/database/repositories/thread-repo.ts', maxSites: 9, reason: REPOSITORY_READ },
  { file: 'src/lib/engines/assignment-engine.ts', maxSites: 2, reason: ENGINE_READ },
  { file: 'src/lib/engines/audit-engine.ts', maxSites: 4, reason: ENGINE_READ },
  { file: 'src/lib/engines/brainstorm-engine.ts', maxSites: 2, reason: ENGINE_READ },
  { file: 'src/lib/engines/engineering-lifecycle-engine.ts', maxSites: 2, reason: ENGINE_READ },
  { file: 'src/lib/engines/plan-engine.ts', maxSites: 3, reason: ENGINE_READ },
  { file: 'src/lib/engines/prd-engine.ts', maxSites: 5, reason: ENGINE_READ },
  { file: 'src/lib/engines/scope-manager.ts', maxSites: 1, reason: ENGINE_READ },
  { file: 'src/lib/engines/spec-engine.ts', maxSites: 2, reason: ENGINE_READ },
  {
    file: 'src/main/storage/checkpoint-manager.ts',
    maxSites: 6,
    reason: 'turn-checkpoint bookkeeping read'
  },
  {
    file: 'src/main/system/workflow-ownership-service.ts',
    maxSites: 1,
    reason: 'workflow ownership probe read'
  }
]

/** A synchronous read of the main connection: `db.get` / `db.all` with a type
 *  argument or a call, and nothing else `db.*`. */
const SYNC_READ_CALL = /\bdb\.(get|all)\s*[<(]/gu

function sourceFiles(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

describe('main-thread SQLite reads', () => {
  it('keeps every synchronous read inside a declared allowance', () => {
    const projectRoot = process.cwd()
    const counts = new Map<string, number>()
    for (const path of sourceFiles(join(projectRoot, 'src'))) {
      const sites = readFileSync(path, 'utf-8').match(SYNC_READ_CALL)?.length ?? 0
      if (sites > 0) counts.set(relative(projectRoot, path).split(sep).join('/'), sites)
    }

    const allowed = new Map(SYNC_READ_ALLOWANCES.map((entry) => [entry.file, entry]))
    const undeclared = [...counts].filter(([file]) => !allowed.has(file))
    const overBudget = [...counts]
      .filter(([file, sites]) => (allowed.get(file)?.maxSites ?? 0) < sites)
      .map(
        ([file, sites]) =>
          `${file}: ${sites} synchronous reads (allowance ${allowed.get(file)?.maxSites})`
      )
    const missingFiles = SYNC_READ_ALLOWANCES.filter(
      (entry) => !existsSync(join(projectRoot, entry.file))
    ).map((entry) => entry.file)

    const report = [
      undeclared.length > 0
        ? `Undeclared synchronous reads (read through Database.queryViaWorker or a ...ViaWorker repo method, or add an allowance with a reason):\n  ${undeclared
            .map(([file, sites]) => `${file}: ${sites}`)
            .join('\n  ')}`
        : '',
      overBudget.length > 0 ? `A file gained synchronous reads:\n  ${overBudget.join('\n  ')}` : '',
      missingFiles.length > 0
        ? `Allowances for files that no longer exist:\n  ${missingFiles.join('\n  ')}`
        : ''
    ]
      .filter((part) => part.length > 0)
      .join('\n\n')

    expect(report).toBe('')
  })

  it('declares each file once, with a reason', () => {
    const files = SYNC_READ_ALLOWANCES.map((entry) => entry.file)
    expect(new Set(files).size).toBe(files.length)
    for (const entry of SYNC_READ_ALLOWANCES) {
      expect(entry.maxSites).toBeGreaterThan(0)
      expect(entry.reason.length).toBeGreaterThan(0)
    }
  })
})
