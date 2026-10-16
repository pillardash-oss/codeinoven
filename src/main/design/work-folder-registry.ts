import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { DEFAULT_WORK_ROOTS, normalizeWorkRoot } from '../../lib/design/work-roots'
import type { AuthoredWorkKind, DesignEntry } from '../../lib/ipc/design'
import type { Database } from '../database/database'
import { listProjectWorkFolders, readWorkFolder } from './design-listing'
import { projectWorkRootPaths } from './work-roots-state'

interface FolderRow {
  directory: string
  kind: AuthoredWorkKind
  created_at: number
  updated_at: number
  missing: number
}

const registryOperations = new Map<string, Promise<unknown>>()
async function exclusive<T>(projectId: string, action: () => Promise<T>): Promise<T> {
  const previous = registryOperations.get(projectId) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(action)
  registryOperations.set(projectId, operation)
  try {
    return await operation
  } finally {
    if (registryOperations.get(projectId) === operation) registryOperations.delete(projectId)
  }
}

/** Exact work folders, independent of the thread currently previewing them. */
export class WorkFolderRegistry {
  constructor(private readonly database: Database) {}

  private async save(statements: Array<{ sql: string; params: unknown[] }>): Promise<void> {
    for (let index = 0; index < statements.length; index += 50) {
      const result = await this.database.transactionViaWorker(statements.slice(index, index + 50))
      if (!result.ok) throw new Error(result.error ?? 'Could not update work folders')
      await new Promise<void>((resume) => setImmediate(resume))
    }
  }

  /** Only the canonical defaults are discovered from disk. Custom folders are exact records. */
  list(projectId: string, projectPath: string, kind: AuthoredWorkKind): Promise<DesignEntry[]> {
    return exclusive(projectId, () => this.read(projectId, projectPath, kind))
  }

  private async read(
    projectId: string,
    projectPath: string,
    kind: AuthoredWorkKind
  ): Promise<DesignEntry[]> {
    const containers = new Set([
      ...projectWorkRootPaths(projectId, 'design'),
      ...projectWorkRootPaths(projectId, 'video'),
      DEFAULT_WORK_ROOTS.design,
      DEFAULT_WORK_ROOTS.video,
      '.cio'
    ])
    const valid = (directory: string): boolean =>
      normalizeWorkRoot(directory) === directory && !containers.has(directory)
    // Recover exact preview/creator paths from installations predating this registry.
    const legacy = await this.database.queryViaWorker(
      `SELECT directory, kind, updated_at AS created_at FROM thread_designs WHERE project_id = ?
       UNION SELECT o.directory, COALESCE(t.kind, '') AS kind, o.created_at
       FROM design_origins o LEFT JOIN thread_designs t ON t.thread_id = o.thread_id AND t.directory = o.directory
       WHERE o.project_id = ?`,
      [projectId, projectId],
      0
    )
    if (!legacy.ok) throw new Error('Could not read recorded work folders')
    const discovered = await listProjectWorkFolders(projectPath, DEFAULT_WORK_ROOTS[kind])
    const discoveredByPath = new Map(discovered.map((entry) => [entry.directory, entry]))
    const inserts: Array<{ sql: string; params: unknown[] }> = []
    const register = (directory: string, created: number, updated: number): void => {
      if (!valid(directory)) return
      inserts.push({
        sql: `INSERT OR IGNORE INTO authored_work_folders
        (project_id, directory, kind, created_at, updated_at, missing) VALUES (?, ?, ?, ?, ?, 0)`,
        params: [projectId, directory, kind, created, updated]
      })
    }
    for (const row of legacy.rows as unknown as Array<{
      directory: string
      kind: string
      created_at: number
    }>) {
      const recordedKind =
        row.kind ||
        (['design', 'video'] as const).find((candidate) =>
          [DEFAULT_WORK_ROOTS[candidate], ...projectWorkRootPaths(projectId, candidate)].some(
            (root) => row.directory.startsWith(`${root}/`)
          )
        )
      // A generic HTML preview can carry a design mark. It is not proof that an
      // arbitrary scratch path was authored work or explicitly relocated.
      const allowed = [DEFAULT_WORK_ROOTS[kind], ...projectWorkRootPaths(projectId, kind)].some(
        (root) => dirname(row.directory) === root
      )
      if (recordedKind === kind && allowed) register(row.directory, row.created_at, row.created_at)
    }
    for (const entry of discovered) register(entry.directory, entry.createdAt, entry.updatedAt)
    await this.save(inserts)
    const result = await this.database.queryViaWorker(
      'SELECT directory, kind, created_at, updated_at, missing FROM authored_work_folders WHERE project_id = ? AND kind = ?',
      [projectId, kind],
      0
    )
    if (!result.ok) throw new Error('Could not read work folder registry')
    const rows = (result.rows as unknown as FolderRow[]).filter((row) => valid(row.directory))
    const entries: DesignEntry[] = []
    const updates: Array<{ sql: string; params: unknown[] }> = []
    for (let index = 0; index < rows.length; index += 8) {
      const batch = await Promise.all(
        rows.slice(index, index + 8).map(async (row) => {
          const present =
            discoveredByPath.get(row.directory) ??
            (await readWorkFolder(projectPath, row.directory))
          const entry: DesignEntry = present ?? {
            directory: row.directory,
            name: basename(row.directory),
            hasEntry: false,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            creatorThreadId: null,
            missing: true
          }
          if (
            row.missing !== Number(entry.missing === true) ||
            row.updated_at !== entry.updatedAt
          ) {
            updates.push({
              sql: 'UPDATE authored_work_folders SET missing = ?, updated_at = ? WHERE project_id = ? AND directory = ?',
              params: [Number(entry.missing === true), entry.updatedAt, projectId, row.directory]
            })
          }
          return entry
        })
      )
      entries.push(...batch)
      await new Promise<void>((resume) => setImmediate(resume))
    }
    await this.save(updates)
    return entries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Remove an unavailable record only. This operation never deletes files. */
  removeMissing(projectId: string, projectPath: string, directory: string): Promise<void> {
    return exclusive(projectId, () => this.remove(projectId, projectPath, directory))
  }

  private async remove(projectId: string, projectPath: string, directory: string): Promise<void> {
    if (normalizeWorkRoot(directory) !== directory) throw new Error('Invalid work folder')
    const record = await this.database.queryViaWorker(
      'SELECT directory FROM authored_work_folders WHERE project_id = ? AND directory = ?',
      [projectId, directory],
      1
    )
    if (!record.ok || record.rows.length === 0) throw new Error('This folder is not registered')
    const present = await stat(resolve(projectPath, directory)).catch((error: unknown) => {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      )
        return null
      throw error
    })
    if (present?.isDirectory())
      throw new Error('This folder exists. Refresh the panel before removing its record.')
    await this.save([
      {
        sql: 'DELETE FROM authored_work_folders WHERE project_id = ? AND directory = ?',
        params: [projectId, directory]
      },
      {
        sql: 'DELETE FROM thread_designs WHERE project_id = ? AND directory = ?',
        params: [projectId, directory]
      },
      {
        sql: 'DELETE FROM design_origins WHERE project_id = ? AND directory = ?',
        params: [projectId, directory]
      }
    ])
  }
}
