import { constants } from 'fs'
import { basename, extname, join, relative, sep } from 'path'
import { pathToFileURL } from 'url'
import { open, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import type { FileHandle } from 'fs/promises'
import type {
  CapturableSpecContextType,
  Project,
  PromptAttachment,
  SpecContextReference
} from '../lib/types'
import { generateId, getConfigRoot, ensureDir } from '../lib/utils'
import type { Database } from './database/database'

const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u
const ATTACHMENT_MIME: Record<string, string> = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml'
}

export type { CapturableSpecContextType }

export interface SpecContextProjectLookup {
  getProject(projectId: string): Promise<Project | null>
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..')
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

async function hashFile(file: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let position = 0

  while (true) {
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position)
    if (bytesRead === 0) break
    hash.update(chunk.subarray(0, bytesRead))
    position += bytesRead
  }

  return hash.digest('hex')
}

/**
 * Captures only user-selected files as immutable spec context references.
 * Repository references expose project-relative paths. External attachments
 * are copied into CodeInOven storage and never persist their host path.
 */
export class SpecContextService {
  constructor(
    private readonly db: Database,
    private readonly projects: SpecContextProjectLookup
  ) {}

  async capture(
    projectId: string,
    selectedAbsoluteFile: string,
    type: CapturableSpecContextType
  ): Promise<SpecContextReference> {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error('Project ID contains unsupported characters')
    }

    const project = await this.projects.getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    if (project.source !== 'local') {
      throw new Error('Spec context capture is not available for SSH projects')
    }

    const selectedPath = await this.realFilePath(selectedAbsoluteFile)
    const id = generateId()
    const selectedAt = Date.now()

    if (type === 'attachment') {
      const file = await open(selectedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const metadata = await file.stat()
        if (metadata.size > MAX_ATTACHMENT_BYTES) {
          throw new Error('Attachment exceeds the 16 MiB size limit')
        }

        const content = await file.readFile()
        if (content.byteLength > MAX_ATTACHMENT_BYTES) {
          throw new Error('Attachment exceeds the 16 MiB size limit')
        }

        const directory = join(
          getConfigRoot(),
          'projects',
          projectId,
          'spec-context',
          'attachments'
        )
        await ensureDir(directory)
        const destination = join(directory, id)
        await writeFile(destination, content, { flag: 'wx', mode: 0o600 })

        return {
          id,
          type,
          label: basename(selectedAbsoluteFile),
          contentHash: createHash('sha256').update(content).digest('hex'),
          selectedAt
        }
      } finally {
        await file.close()
      }
    }

    if (!project.path) throw new Error('Local project has no filesystem root')

    const canonicalRoot = await this.realDirectoryPath(project.path)
    if (!isWithinRoot(canonicalRoot, selectedPath)) {
      throw new Error('Selected context file is outside the project root')
    }

    const projectRelativePath = relative(canonicalRoot, selectedPath)
    if (!projectRelativePath) throw new Error('Selected context must be a file')

    const file = await open(selectedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return {
        id,
        type,
        label: basename(projectRelativePath),
        path: toPosixPath(projectRelativePath),
        contentHash: await hashFile(file),
        selectedAt
      }
    } finally {
      await file.close()
    }
  }

  promptAttachments(projectId: string, context: SpecContextReference[]): PromptAttachment[] {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error('Project ID contains unsupported characters')
    }
    return context
      .filter((reference) => reference.type === 'attachment')
      .map((reference) => {
        const source = join(
          getConfigRoot(),
          'projects',
          projectId,
          'spec-context',
          'attachments',
          reference.id
        )
        return {
          mime:
            ATTACHMENT_MIME[extname(reference.label).toLowerCase()] ?? 'application/octet-stream',
          url: pathToFileURL(source).href,
          filename: reference.label
        }
      })
  }

  private async realFilePath(path: string): Promise<string> {
    let canonicalPath: string
    try {
      canonicalPath = await import('fs/promises').then(({ realpath }) => realpath(path))
    } catch {
      throw new Error('Selected context file does not exist')
    }

    const file = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await file.stat()
      if (!metadata.isFile()) throw new Error('Selected context must be a file')
    } finally {
      await file.close()
    }

    return canonicalPath
  }

  private async realDirectoryPath(path: string): Promise<string> {
    let canonicalPath: string
    try {
      canonicalPath = await import('fs/promises').then(({ realpath }) => realpath(path))
    } catch {
      throw new Error('Project root does not exist')
    }

    const file = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await file.stat()
      if (!metadata.isDirectory()) throw new Error('Project root is not a directory')
    } finally {
      await file.close()
    }

    return canonicalPath
  }
}
