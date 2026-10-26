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
  request: Extract<BackgroundIoRequest, { kind: 'credential-read' | 'credential-delete' }>
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
  let result: unknown
  switch (request.kind) {
    case 'index-read': {
      const { readIndexPage } = await import('../search/thread-index-work')
      result = await readIndexPage(request.path, request.snapshot)
      break
    }
    case 'index-encode': {
      const { encodeIndexPage } = await import('../search/thread-index-work')
      result = encodeIndexPage(request.records)
      break
    }
    case 'index-rank': {
      const { rankIndexPage } = await import('../search/thread-index-work')
      result = rankIndexPage(request.records, request.query, request.limit)
      break
    }
    case 'dangling-references': {
      const { scanDanglingReferences } = await import('../git/git/git-service-references-core')
      result = await scanDanglingReferences(request.root, request.deletedPaths, request.files)
      break
    }
    case 'project-icon': {
      const { ProjectIconDiscovery } = await import('../../lib/project-icon-discovery')
      result = await new ProjectIconDiscovery().detectIcon(request.projectPath)
      break
    }
    case 'prepare-icon': {
      const { prepareIcon } = await import('../../lib/prepare-icon')
      result = await prepareIcon(request.sourcePath)
      break
    }
    case 'document': {
      const documents = await import('../drivers/document-attachment-core')
      result = await (request.preview
        ? documents.readDocumentPreviewHtml(request.attachment)
        : documents.readDocumentText(request.attachment))
      break
    }
    case 'list-directory':
      result = await listDirectory(request)
      break
    case 'turn-stream-tail': {
      const { readTurnStreamTail, fileTurnStreamSource } = await import('../chat/turn-stream-log')
      result = await readTurnStreamTail(
        fileTurnStreamSource(request.path),
        request.size,
        request.windowStartTs
      )
      break
    }
    case 'turn-stream-range': {
      const { readTurnStreamLog, fileTurnStreamSource } = await import('../chat/turn-stream-log')
      result = await readTurnStreamLog(
        fileTurnStreamSource(request.path),
        request.fromByte,
        request.size,
        request.windowStartTs,
        request.windowEndTs
      )
      break
    }
    default:
      result = await credentials(request)
  }
  return result as T
}
