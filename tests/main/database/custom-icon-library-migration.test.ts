import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import DatabaseConstructor from 'better-sqlite3'
import { Database } from '../../../src/main/database/database'

const testDirectory = join(process.cwd(), '.cio/tmp')
const databasePath = join(testDirectory, 'custom-icon-library-migration.db')
const workerBundlePath = join(testDirectory, `custom-icon-worker-${process.pid}.mjs`)
const workerSource = join(process.cwd(), 'src/main/database/database-worker-thread.ts')

async function createWorkerBundle(): Promise<void> {
  await build({
    entryPoints: [workerSource],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['better-sqlite3', 'worker_threads'],
    outfile: workerBundlePath,
    logLevel: 'error'
  })
}

afterEach(() => {
  rmSync(databasePath, { force: true })
  rmSync(`${databasePath}-shm`, { force: true })
  rmSync(`${databasePath}-wal`, { force: true })
  rmSync(workerBundlePath, { force: true })
})

describe('custom icon library migration', () => {
  it('removes the legacy required name column and preserves existing SVG records', async () => {
    mkdirSync(testDirectory, { recursive: true })
    const legacyDatabase = new DatabaseConstructor(databasePath)
    legacyDatabase.exec(`
      CREATE TABLE custom_icons (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        svg TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO custom_icons(id, name, svg, created_at)
        VALUES ('legacy-id', 'Old label', '<svg viewBox="0 0 1 1"/>', 42);
    `)
    legacyDatabase.close()

    await createWorkerBundle()
    const database = new Database(databasePath, (options) => new Worker(workerBundlePath, options))
    await database.init()
    try {
      expect(
        database.all<{ id: string; svg: string; created_at: number }>(
          'SELECT id, svg, created_at FROM custom_icons'
        )
      ).toEqual([{ id: 'legacy-id', svg: '<svg viewBox="0 0 1 1"/>', created_at: 42 }])
      expect(
        database.get<{ name: string }>(
          'SELECT name FROM pragma_table_info(?) WHERE name = ?',
          'custom_icons',
          'name'
        )
      ).toBeUndefined()
      database.run(
        'INSERT INTO custom_icons(id, svg, created_at) VALUES (?, ?, ?)',
        'new-id',
        '<svg/>',
        43
      )
      expect(
        database.get<{ id: string }>('SELECT id FROM custom_icons WHERE id = ?', 'new-id')
      ).toEqual({ id: 'new-id' })
    } finally {
      await database.close()
    }
  })
})
