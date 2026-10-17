import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => resolve('.cio/tmp/assistant-setup-verification') },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined }
}))
import { Database } from '../../src/main/database/database'
import { AssistantRepo } from '../../src/main/database/repositories/assistant-repo'
import type { Assistant } from '../../src/lib/types'
let db: Database
let root: string
beforeEach(async () => {
  await mkdir(resolve('.cio/tmp/assistant-setup-verification'), { recursive: true })
  root = await mkdtemp(resolve('.cio/tmp/assistant-setup-verification/database-'))
  await build({
    entryPoints: [resolve('src/main/database/database-worker-thread.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['better-sqlite3', 'worker_threads'],
    outfile: join(root, 'worker.mjs'),
    logLevel: 'silent'
  })
  db = new Database(
    join(root, 'test.db'),
    (options) => new Worker(join(root, 'worker.mjs'), options)
  )
  await db.init()
})
afterEach(async () => {
  db?.close()
  if (root) await rm(root, { recursive: true, force: true })
})
function seed(id = 'judge'): Assistant {
  return {
    id,
    name: 'Judge',
    personality: 'Be precise',
    knowledge: 'Watch products',
    scheduleUpdatedAt: 1,
    scheduled: true,
    schedule: { cadence: 'weekdays', times: ['07:45', '16:55'] },
    connections: [{ utilityId: 'source', label: 'Source' }],
    createdAt: 1,
    updatedAt: 1
  }
}

describe('assistant reporting persistence', () => {
  it('patches only supplied columns and survives reopening the database', async () => {
    const repo = new AssistantRepo(db)
    repo.upsert(seed())
    const original = await repo.getViaWorker('judge')
    repo.updateReporting('judge', { delivery: { channel: 'in-app' } }, 2)
    repo.updateReporting('judge', { priority: { timeliness: 'today', impact: 'company' } }, 3)
    // A panel edit made between reporting answers must also survive.
    db.run('UPDATE assistants SET personality = ? WHERE id = ?', [
      'Panel-edited personality',
      'judge'
    ])
    repo.updateReporting(
      'judge',
      { delivery: { channel: 'email', target: 'reports@example.com' } },
      4
    )
    db.close()
    db = new Database(
      join(root, 'test.db'),
      (options) => new Worker(join(root, 'worker.mjs'), options)
    )
    await db.init()
    expect(await new AssistantRepo(db).getViaWorker('judge')).toEqual({
      ...original,
      personality: 'Panel-edited personality',
      delivery: { channel: 'email', target: 'reports@example.com' },
      priority: { timeliness: 'today', impact: 'company' },
      updatedAt: 4
    })
  })
  it('does not change another assistant or resurrect a deleted assistant', async () => {
    const repo = new AssistantRepo(db)
    repo.upsert(seed())
    repo.upsert(seed('other'))
    const other = await repo.getViaWorker('other')
    repo.updateReporting('judge', { delivery: { channel: 'in-app' } }, 2)
    expect(await repo.getViaWorker('other')).toEqual(other)
    db.run('DELETE FROM assistants WHERE id = ?', ['judge'])
    repo.updateReporting('judge', { priority: { timeliness: 'today', impact: 'company' } }, 3)
    expect(await repo.getViaWorker('judge')).toBeNull()
  })
})
