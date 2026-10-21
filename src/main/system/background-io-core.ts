import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackgroundIoRequest } from './background-io-protocol'
import type { ProjectFileEntry } from '../../lib/types'
import {
  isSymlinkedDirectoryInsideRoot,
  MAX_DIRECTORY_ENTRIES
} from '../editor/project-files/project-files-paths'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

async function listDirectory(
  request: Extract<BackgroundIoRequest, { kind: 'list-directory' }>
): Promise<ProjectFileEntry[]> {
  const results: ProjectFileEntry[] = []
  for await (const entry of await opendir(request.directory)) {
    let kind: ProjectFileEntry['kind'] | undefined
    if (entry.isFile()) kind = 'file'
    else if (entry.isDirectory()) kind = 'directory'
    else if (entry.isSymbolicLink()) {
      const path = join(request.directory, entry.name)
      try {
        const target = await stat(path)
        if (target.isFile()) kind = 'file'
        else if (target.isDirectory() && (await isSymlinkedDirectoryInsideRoot(request.root, path)))
          kind = 'directory'
      } catch {
        // Broken links are omitted, as in the existing explorer.
      }
    }
    if (!kind) continue
    if (results.length === MAX_DIRECTORY_ENTRIES)
      throw new Error(
        `Directory contains more than ${MAX_DIRECTORY_ENTRIES.toLocaleString()} visible entries`
      )
    results.push({
      name: entry.name,
      path: request.relativeDirectory ? `${request.relativeDirectory}/${entry.name}` : entry.name,
      kind
    })
  }
  results.sort((a, b) =>
    a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'directory' ? -1 : 1
  )
  return results
}

async function credentials(
  request: Exclude<BackgroundIoRequest, { kind: 'list-directory' }>
): Promise<unknown> {
  const fallback = request.kind === 'credential-read' ? [] : 0
  let database: import('better-sqlite3').Database | undefined
  try {
    const { default: Database } = await import('better-sqlite3')
    database = new Database(request.databasePath, {
      readonly: request.kind === 'credential-read',
      fileMustExist: true,
      timeout: 100
    })
    if (request.kind === 'credential-read') {
      const fields = request.values
        ? 'id, integration_id AS integrationId, value, active, time_updated AS updatedAt'
        : 'id, integration_id AS integrationId, label, method_id AS method'
      const rows = database.prepare(`SELECT ${fields} FROM credential LIMIT 10000`).all() as Record<
        string,
        unknown
      >[]
      return rows
        .filter(
          (row) =>
            typeof row.id === 'string' &&
            row.id &&
            typeof row.integrationId === 'string' &&
            row.integrationId
        )
        .map((row) =>
          request.values
            ? row
            : {
                id: row.id,
                integrationId: row.integrationId,
                label: typeof row.label === 'string' ? row.label : null,
                method: typeof row.method === 'string' ? row.method : null
              }
        )
    }
    if (request.candidates.length === 0) return 0
    const where = request.candidates.map(() => 'LOWER(integration_id) = LOWER(?)').join(' OR ')
    return database.prepare(`DELETE FROM credential WHERE ${where}`).run(...request.candidates)
      .changes
  } catch {
    // Missing, locked, or incompatible stores do not break account discovery.
    return fallback
  } finally {
    database?.close()
  }
}

/** Disposable remote Oven processes also use this implementation directly. */
export async function backgroundIo<T>(request: BackgroundIoRequest): Promise<T> {
  return (
    request.kind === 'list-directory' ? await listDirectory(request) : await credentials(request)
  ) as T
}
