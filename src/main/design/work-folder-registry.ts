import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { DEFAULT_WORK_ROOTS, normalizeWorkRoot } from '../../lib/design/work-roots'
import type { AuthoredWorkKind, DesignEntry } from '../../lib/ipc/design'
import { ASSISTANT_SPACE_ID } from '../../lib/types'
import type { Database } from '../database/database'
import { isInsideProject } from '../preview/served-folder'
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
export async function withWorkRegistryLock<T>(
  projectId: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = registryOperations.get(projectId) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(action)
  registryOperations.set(projectId, operation)
  try {
    return await operation
  } finally {
    if (registryOperations.get(projectId) === operation) registryOperations.delete(projectId)
  }
}

/**
 * Every folder a conversation workspace has authored.
 *
 * A conversation workspace is listed from disk, because the registry is keyed by
 * project id and every assistant task shares one container id: a registry read
 * there would answer for whichever assistant happened to write a folder of that
 * name first. Disk under the canonical root is only half the truth, though. A
 * folder the user moves elsewhere in the workspace still exists, and it sits
 * outside the root this listing enumerates, so the board that answered from disk
 * alone lost the design it was showing the moment it was relocated (the app had
 * performed the move, told the agent the new path, and then could not draw it).
 *
 * The threads' own records are the other half: they are scoped to this workspace
 * by the assistant that owns them, they are rebased by every move, and each one
 * is verified on disk before it reaches the board, so a folder the user deleted
 * never comes back from a stale row. Both records are read, because they answer
 * different questions: the thread's current folder carries the authoritative kind,
 * and the folder's creator keeps every folder that workspace ever authored even
 * after its thread moved on to another one.
 */
export async function listConversationWorkFolders(input: {
  database: Database
  projectId: string
  threadId: string
  assistantId: string | null
  workspacePath: string
  kind: AuthoredWorkKind
}): Promise<DesignEntry[]> {
  const root = DEFAULT_WORK_ROOTS[input.kind]
  const discovered = await listProjectWorkFolders(input.workspacePath, root)
  const seen = new Set(discovered.map((entry) => entry.directory))
  const recorded = await recordedWorkspaceFolders(input)
  for (let index = 0; index < recorded.length; index += 8) {
    const batch = await Promise.all(
      recorded.slice(index, index + 8).map(async (directory) => ({
        directory,
        entry: await readWorkFolder(input.workspacePath, directory).catch(() => null)
      }))
    )
    for (const { directory, entry } of batch) {
      if (!entry || seen.has(directory)) continue
      seen.add(directory)
      discovered.push({ ...entry, creatorThreadId: null })
    }
    await new Promise<void>((resume) => setImmediate(resume))
  }
  return discovered.sort((left, right) => right.updatedAt - left.updatedAt)
}

/**
 * Folders of one kind this workspace's threads recorded, however they are spelled now.
 *
 * An assistant workspace is shared by every task of that assistant, so the owner
 * is the assistant the row's thread belongs to, falling back to the thread itself
 * for a task that has no assistant. A chat or a browser tab owns its own
 * workspace, so its own thread is the whole filter.
 *
 * Two kinds of record are read, because they answer different questions. The
 * thread's current folder is written by every preview, so it carries the
 * authoritative kind. A folder whose thread has since moved on keeps only its
 * creator row, which does not say what it holds, so it has to be recognised as
 * authored work of this kind by the registry first: previewing a scratch folder is
 * not designing one, and the creator row alone would put every folder a thread
 * ever opened on the board.
 */
async function recordedWorkspaceFolders(input: {
  database: Database
  projectId: string
  threadId: string
  assistantId: string | null
  workspacePath: string
  kind: AuthoredWorkKind
}): Promise<string[]> {
  const byAssistant = input.projectId === ASSISTANT_SPACE_ID
  const owner = byAssistant ? (input.assistantId ?? input.threadId) : input.threadId
  const owned = byAssistant ? 'COALESCE(t.assistant_id, t.id) = ?' : 't.id = ?'
  const [current, registered, created] = await Promise.all([
    input.database.queryViaWorker(
      `SELECT DISTINCT td.directory AS directory FROM thread_designs td
         JOIN threads t ON t.id = td.thread_id
        WHERE td.project_id = ? AND td.kind = ? AND ${owned}`,
      [input.projectId, input.kind, owner],
      0
    ),
    input.database.queryViaWorker(
      'SELECT directory FROM authored_work_folders WHERE project_id = ? AND kind = ?',
      [input.projectId, input.kind],
      0
    ),
    input.database.queryViaWorker(
      `SELECT DISTINCT o.directory AS directory FROM design_origins o
         JOIN threads t ON t.id = o.thread_id
        WHERE o.project_id = ? AND ${owned}`,
      [input.projectId, owner],
      0
    )
  ])
  if (!current.ok || !registered.ok || !created.ok)
    throw new Error('Could not read this workspace’s folders')
  const authored = new Set(
    created.rows.map((row) => String((row as { directory: unknown }).directory))
  )
  const folders = new Set<string>(
    current.rows.map((row) => String((row as { directory: unknown }).directory))
  )
  for (const row of registered.rows) {
    const directory = String((row as { directory: unknown }).directory)
    if (authored.has(directory)) folders.add(directory)
  }
  const root = DEFAULT_WORK_ROOTS[input.kind]
  return [...folders].filter((directory) => isWorkspaceFolder(input.workspacePath, directory, root))
}

/** Whether a recorded spelling names a folder of work inside this workspace. */
function isWorkspaceFolder(workspacePath: string, directory: string, root: string): boolean {
  if (normalizeWorkRoot(directory) !== directory) return false
  if (directory === '.cio' || directory === root) return false
  return isInsideProject(workspacePath, resolve(workspacePath, directory))
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
    return withWorkRegistryLock(projectId, () => this.read(projectId, projectPath, kind))
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
    const aliases = await this.database.queryViaWorker(
      'SELECT directory FROM work_folder_relocations WHERE project_id = ?',
      [projectId],
      0
    )
    if (!aliases.ok) throw new Error('Could not read relocated folders')
    const relocated = new Set(aliases.rows.map((row) => String(row.directory)))
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
      if (!valid(directory) || relocated.has(directory)) return
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
    const rows = (result.rows as unknown as FolderRow[]).filter(
      (row) => valid(row.directory) && !relocated.has(row.directory)
    )
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
    await this.repairStaleMoves(projectId, entries)
    return entries
      .filter((entry) => !relocated.has(entry.directory))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Repair a late navigation recorded after an older version already moved its history. */
  private async repairStaleMoves(projectId: string, entries: DesignEntry[]): Promise<void> {
    const missing = entries.filter((entry) => entry.missing)
    if (missing.length === 0) return
    const origins = await this.database.queryViaWorker(
      `SELECT o.directory, o.thread_id, o.created_at,
        EXISTS(SELECT 1 FROM design_revisions r WHERE r.project_id = o.project_id AND r.directory = o.directory) AS history
       FROM design_origins o WHERE o.project_id = ?`,
      [projectId],
      0
    )
    if (!origins.ok) throw new Error('Could not reconcile moved folders')
    const rows = origins.rows as unknown as Array<{
      directory: string
      thread_id: string
      created_at: number
      history: number
    }>
    const originsByPath = new Map(rows.map((row) => [row.directory, row]))
    const destinations = new Map<string, typeof rows>()
    for (const entry of entries) {
      const origin = originsByPath.get(entry.directory)
      if (entry.missing || !origin?.history) continue
      const key = `${origin.thread_id}\u0000${entry.name}`
      const candidates = destinations.get(key) ?? []
      candidates.push(origin)
      destinations.set(key, candidates)
    }
    const removed = new Set<string>()
    for (const entry of missing) {
      const old = originsByPath.get(entry.directory)
      if (!old || old.history) continue
      const candidates = (destinations.get(`${old.thread_id}\u0000${entry.name}`) ?? []).filter(
        (origin) => origin.created_at < old.created_at
      )
      if (candidates.length !== 1) continue
      const destination = candidates[0]!.directory
      await this.save([
        {
          sql: 'UPDATE thread_designs SET directory = ? WHERE project_id = ? AND directory = ?',
          params: [destination, projectId, entry.directory]
        },
        {
          sql: 'INSERT OR REPLACE INTO work_folder_relocations (project_id, directory, destination) VALUES (?, ?, ?)',
          params: [projectId, entry.directory, destination]
        },
        {
          sql: 'DELETE FROM design_origins WHERE project_id = ? AND directory = ?',
          params: [projectId, entry.directory]
        },
        {
          sql: 'DELETE FROM authored_work_folders WHERE project_id = ? AND directory = ?',
          params: [projectId, entry.directory]
        }
      ])
      removed.add(entry.directory)
    }
    for (let index = entries.length - 1; index >= 0; index--) {
      if (removed.has(entries[index]!.directory)) entries.splice(index, 1)
    }
  }

  /** Individual relocations can live outside every project default root. */
  async kindFor(projectId: string, directory: string): Promise<AuthoredWorkKind | null> {
    const result = await this.database.queryViaWorker(
      'SELECT kind FROM authored_work_folders WHERE project_id = ? AND directory = ?',
      [projectId, directory],
      1
    )
    if (!result.ok) throw new Error('Could not recognize the work folder')
    const row = result.rows[0] as { kind: string } | undefined
    return row?.kind === 'design' || row?.kind === 'video' ? row.kind : null
  }

  /** Remove an unavailable record only. This operation never deletes files. */
  removeMissing(projectId: string, projectPath: string, directory: string): Promise<void> {
    return withWorkRegistryLock(projectId, () => this.remove(projectId, projectPath, directory))
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
