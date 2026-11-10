import type { ProjectEnvMode } from '../../lib/project-env'
import type { StorageEngine } from '../storage/storage-engine'

/** One key of a stored manifest. The value lives in the vault, never here. */
export interface StoredProjectEnvEntry {
  name: string
  secretRef: string
  updatedAt: number
}

/** One stored manifest: a directory group plus a run mode. */
export interface StoredProjectEnvFile {
  group: string
  mode: ProjectEnvMode
  entries: StoredProjectEnvEntry[]
  updatedAt: number
  importedFrom?: string
}

interface ProjectEnvDocument {
  version: 1
  projectId: string
  files: StoredProjectEnvFile[]
}

interface ThreadEnvDocument {
  version: 1
  threadId: string
  entries: StoredProjectEnvEntry[]
}

/** Names an id may take before it becomes part of a path. */
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/u

/**
 * The manifests for project- and thread-scoped ENV secrets.
 *
 * A manifest is the only thing persisted: which names exist, in which directory
 * group and run mode, and which vault ref holds each value. It is deliberately
 * small and value-free, so exporting or diffing it can never carry a secret.
 */
export class ProjectEnvStore {
  constructor(private readonly storage: StorageEngine) {}

  async readProject(projectId: string): Promise<StoredProjectEnvFile[]> {
    const document = await this.storage.read<ProjectEnvDocument>(this.projectPath(projectId))
    if (!document || !Array.isArray(document.files)) return []
    return document.files.flatMap((file) => {
      const mode = file?.mode
      if (typeof file?.group !== 'string' || typeof mode !== 'string') return []
      if (!Array.isArray(file.entries)) return []
      return [
        {
          group: file.group,
          mode: mode as ProjectEnvMode,
          updatedAt: typeof file.updatedAt === 'number' ? file.updatedAt : 0,
          entries: file.entries.flatMap((entry) => sanitizeEntry(entry)),
          ...(typeof file.importedFrom === 'string' && file.importedFrom
            ? { importedFrom: file.importedFrom }
            : {})
        }
      ]
    })
  }

  async writeProject(projectId: string, files: readonly StoredProjectEnvFile[]): Promise<void> {
    const document: ProjectEnvDocument = { version: 1, projectId, files: [...files] }
    await this.storage.write(this.projectPath(projectId), document)
  }

  async readThread(threadId: string): Promise<StoredProjectEnvEntry[]> {
    const document = await this.storage.read<ThreadEnvDocument>(this.threadPath(threadId))
    if (!document || !Array.isArray(document.entries)) return []
    return document.entries.flatMap((entry) => sanitizeEntry(entry))
  }

  async writeThread(threadId: string, entries: readonly StoredProjectEnvEntry[]): Promise<void> {
    const document: ThreadEnvDocument = { version: 1, threadId, entries: [...entries] }
    await this.storage.write(this.threadPath(threadId), document)
  }

  private projectPath(projectId: string): string {
    return `project-env/${assertId(projectId, 'project')}.json`
  }

  private threadPath(threadId: string): string {
    return `project-env/threads/${assertId(threadId, 'thread')}.json`
  }
}

function sanitizeEntry(entry: unknown): StoredProjectEnvEntry[] {
  if (typeof entry !== 'object' || entry === null) return []
  const record = entry as Record<string, unknown>
  const name = record['name']
  const secretRef = record['secretRef']
  if (typeof name !== 'string' || !name) return []
  if (typeof secretRef !== 'string' || !secretRef) return []
  return [
    {
      name,
      secretRef,
      updatedAt: typeof record['updatedAt'] === 'number' ? record['updatedAt'] : 0
    }
  ]
}

function assertId(id: string, label: string): string {
  if (!SAFE_ID.test(id)) throw new TypeError(`An env manifest needs a valid ${label} id`)
  return id
}
