import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import type { Database } from '../../../src/main/database/database'
import { ScopeManager, ScopeManagerError } from '../../../src/lib/engines/scope-manager'
import {
  DEFAULT_SCOPE_BUCKET_ID,
  DEFAULT_SCOPE_WORKTREE_DEFAULTS,
  type ManagedWorktreeDescriptor,
  type ScopeBoard
} from '../../../src/lib/types'
import { getScopeRootPath } from '../../../src/lib/utils'

const temporaryDatabases: Database[] = []
const originalConfigRoot = process.env['CODEINOVEN_CONFIG_ROOT']
const originalSmokeFlag = process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT']
let temporaryConfigRoot = ''

beforeEach(() => {
  temporaryConfigRoot = mkdtempSync(join(tmpdir(), 'codeinoven-scope-manager-'))
  // getConfigRoot only honours the override in packaged-smoke mode.
  process.env['CODEINOVEN_CONFIG_ROOT'] = temporaryConfigRoot
  process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT'] = '1'
})

async function createManager(): Promise<ScopeManager> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  return new ScopeManager(db)
}

afterEach(() => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  rmSync(temporaryConfigRoot, { force: true, recursive: true })
  temporaryConfigRoot = ''
  if (originalConfigRoot === undefined) delete process.env['CODEINOVEN_CONFIG_ROOT']
  else process.env['CODEINOVEN_CONFIG_ROOT'] = originalConfigRoot
  if (originalSmokeFlag === undefined) delete process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT']
  else process.env['CODEINOVEN_PACKAGED_SMOKE_OUTPUT'] = originalSmokeFlag
})

describe.skipIf(process.platform === 'win32')('ScopeManager', () => {
  it('creates a default version 2 board for missing records', async () => {
    const manager = await createManager()
    const board = manager.getBoard('project1')
    expect(board.version).toBe(2)
    expect(board.buckets).toHaveLength(1)
    expect(board.buckets[0]?.id).toBe(DEFAULT_SCOPE_BUCKET_ID)
    expect(board.buckets[0]?.root).toEqual({ kind: 'project' })
    expect(board.worktreeDefaults).toEqual({
      setupCommands: [],
      runSetupByDefault: DEFAULT_SCOPE_WORKTREE_DEFAULTS.runSetupByDefault,
      environmentMode: 'copy'
    })
  })

  it('migrates a version 1 board deterministically to project-rooted version 2', async () => {
    const manager = await createManager()
    const v1 = {
      version: 1,
      buckets: [
        { id: 'default', name: 'Default', sortOrder: 0, collapsed: false, collapsedSlices: [] },
        {
          id: 'feature',
          name: 'Feature',
          sortOrder: 1,
          collapsed: true,
          collapsedSlices: ['todo'],
          color: '#ef4444',
          iconType: 'folder'
        }
      ]
    }
    const db = (manager as unknown as { db: Database }).db
    db.run(
      'INSERT OR REPLACE INTO scope_boards(project_id, data, updated_at) VALUES(?,?,?)',
      'project1',
      JSON.stringify(v1),
      Date.now()
    )

    const board = manager.getBoard('project1')
    expect(board.version).toBe(2)
    expect(board.buckets.map((bucket) => bucket.id)).toEqual(['default', 'feature'])
    expect(board.buckets[1]?.collapsed).toBe(true)
    expect(board.buckets[1]?.color).toBe('#ef4444')
    expect(board.buckets[1]?.root).toEqual({ kind: 'project' })

    // Re-loading must be stable and already persisted as version 2.
    const reloaded = manager.getBoard('project1')
    expect(reloaded).toEqual(board)
    const raw = JSON.parse(
      (db.get<{ data: string }>('SELECT data FROM scope_boards WHERE project_id=?', 'project1')
        ?.data ?? '') as string
    ) as ScopeBoard
    expect(raw.version).toBe(2)
  })

  it('throws on malformed board records instead of discarding scopes', async () => {
    const manager = await createManager()
    const db = (manager as unknown as { db: Database }).db
    db.run(
      'INSERT OR REPLACE INTO scope_boards(project_id, data, updated_at) VALUES(?,?,?)',
      'project1',
      '{not-json',
      Date.now()
    )
    expect(() => manager.getBoard('project1')).toThrow(ScopeManagerError)
  })

  it('rejects duplicate bucket IDs when loading persisted boards', async () => {
    const manager = await createManager()
    const db = (manager as unknown as { db: Database }).db
    const duplicated = {
      version: 2,
      buckets: [
        {
          id: 'default',
          name: 'Default',
          sortOrder: 0,
          collapsed: false,
          collapsedSlices: [],
          root: { kind: 'project' }
        },
        {
          id: 'a',
          name: 'A',
          sortOrder: 1,
          collapsed: false,
          collapsedSlices: [],
          root: { kind: 'project' }
        },
        {
          id: 'a',
          name: 'B',
          sortOrder: 2,
          collapsed: false,
          collapsedSlices: [],
          root: { kind: 'project' }
        }
      ],
      worktreeDefaults: DEFAULT_SCOPE_WORKTREE_DEFAULTS
    }
    db.run(
      'INSERT OR REPLACE INTO scope_boards(project_id, data, updated_at) VALUES(?,?,?)',
      'project1',
      JSON.stringify(duplicated),
      Date.now()
    )
    expect(() => manager.getBoard('project1')).toThrow(/Duplicate scope bucket ID/)
  })

  it('preserves managed root metadata during layout and appearance updates', async () => {
    const manager = await createManager()
    const created = manager.createBucket('project1', { name: 'Feature' })
    const descriptor: ManagedWorktreeDescriptor = {
      kind: 'worktree',
      directoryName: 'feature',
      branch: 'cio/feature',
      baseBranch: 'main',
      baseCommit: 'abc123',
      createdAt: 1000,
      environmentMode: 'copy',
      setup: { state: 'succeeded', commands: [], finishedAt: 2000 }
    }
    manager.attachManagedRoot('project1', created.bucket.id, descriptor)

    manager.updateLayout('project1', [created.bucket.id, DEFAULT_SCOPE_BUCKET_ID])
    manager.updateAppearance('project1', created.bucket.id, { name: 'Renamed' })

    const board = manager.getBoard('project1')
    const bucket = board.buckets.find((candidate) => candidate.id === created.bucket.id)
    expect(bucket?.name).toBe('Renamed')
    expect(bucket?.root).toEqual(descriptor)
  })

  it('refuses to archive, delete, or worktree-enable the Default scope', async () => {
    const manager = await createManager()
    expect(() => manager.setArchive('project1', DEFAULT_SCOPE_BUCKET_ID, true)).toThrow(
      ScopeManagerError
    )
    expect(() => manager.deleteBucket('project1', DEFAULT_SCOPE_BUCKET_ID)).toThrow(
      ScopeManagerError
    )
    expect(() =>
      manager.attachManagedRoot('project1', DEFAULT_SCOPE_BUCKET_ID, {
        kind: 'worktree',
        directoryName: 'x',
        branch: 'cio/x',
        baseBranch: 'main',
        baseCommit: 'abc',
        createdAt: 1,
        environmentMode: 'copy',
        setup: { state: 'not_run', commands: [] }
      })
    ).toThrow(ScopeManagerError)
  })

  it('archives and restores custom scopes without touching their root', async () => {
    const manager = await createManager()
    const { bucket } = manager.createBucket('project1', { name: 'Feature' })
    manager.setArchive('project1', bucket.id, true)
    let loaded = manager.getBoard('project1').buckets.find((entry) => entry.id === bucket.id)
    expect(loaded?.archivedAt).toBeGreaterThan(0)
    manager.setArchive('project1', bucket.id, false)
    loaded = manager.getBoard('project1').buckets.find((entry) => entry.id === bucket.id)
    expect(loaded?.archivedAt).toBeUndefined()
  })

  it('persists project-level worktree defaults', async () => {
    const manager = await createManager()
    manager.setWorktreeDefaults('project1', {
      setupCommands: [{ executable: 'bun', args: ['install'] }],
      runSetupByDefault: false,
      environmentMode: 'symlink'
    })
    const board = manager.getBoard('project1')
    expect(board.worktreeDefaults.setupCommands).toEqual([{ executable: 'bun', args: ['install'] }])
    expect(board.worktreeDefaults.runSetupByDefault).toBe(false)
    expect(board.worktreeDefaults.environmentMode).toBe('symlink')
  })
})

describe.skipIf(process.platform === 'win32')('getScopeRootPath', () => {
  it('resolves beneath projects/<id>/scope deterministically', async () => {
    // getScopeRootPath is symlink-canonical; resolve the config root first so
    // the expected path matches the realpath'd value on macOS.
    const expected = join(realpathSync(temporaryConfigRoot), 'projects', 'p1', 'scope', 'feature')
    expect(getScopeRootPath('p1', 'feature')).toBe(expected)
    expect(getScopeRootPath('p1', 'feature')).toBe(getScopeRootPath('p1', 'feature'))
  })

  it('rejects absolute names and traversal segments', async () => {
    expect(() => getScopeRootPath('p1', '/etc')).toThrow()
    expect(() => getScopeRootPath('p1', '..')).toThrow()
    expect(() => getScopeRootPath('p1', 'a/b')).toThrow()
    expect(() => getScopeRootPath('p1', '')).toThrow()
  })
})
