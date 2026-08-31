import { constants, lstatSync, realpathSync } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ProjectFileIndexService } from './project-file-index-service'
import type {
  Project,
  ProjectFileDropResult,
  ProjectFileEntry,
  ProjectFileInfo,
  ProjectFileTransferMode,
  ProjectTextFile,
  PromptProjectReference
} from '../../lib/types'

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 10_000
const MAX_RELATIVE_PATH_LENGTH = 4_096

export interface ProjectFilesProjectLookup {
  getProject(projectId: string): Promise<Project | null>
}

/** Resolves a managed scope's filesystem root; unhealthy scopes fail closed. */
export interface ProjectFilesScopeRootLookup {
  resolveCompatibilityRoot(projectId: string, scopeBucketId: string): Promise<string | null>
}

/** Cache/invalidation key for a (project, scope) root pair. */
function scopedKey(projectId: string, scopeBucketId?: string): string {
  return scopeBucketId ? `${projectId}::${scopeBucketId}` : projectId
}

function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  )
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

function revisionOf(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function decodeText(content: Uint8Array): string {
  if (content.includes(0)) {
    throw new Error('Binary files cannot be edited in the sidebar')
  }
  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true
    }).decode(content)
  } catch {
    throw new Error('Only valid UTF-8 text files can be edited in the sidebar')
  }
}

export class ProjectFilesService {
  private readonly writeQueues = new Map<string, Promise<void>>()
  private readonly projectRoots = new Map<string, string>()
  private readonly fileIndex = new ProjectFileIndexService()
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly projects: ProjectFilesProjectLookup,
    private readonly scopeRoots?: ProjectFilesScopeRootLookup
  ) {}

  async listDirectory(
    projectId: string,
    relativeDirectory: string,
    scopeBucketId?: string
  ): Promise<ProjectFileEntry[]> {
    const root = await this.projectRoot(projectId, scopeBucketId)
    const directory = await this.resolveExistingPath(root, relativeDirectory, true)
    const entries = await readdir(directory, { withFileTypes: true })
    const visible = entries
      .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1
        }
        return left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: 'base'
        })
      })

    if (visible.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error(
        `Directory contains more than ${MAX_DIRECTORY_ENTRIES.toLocaleString()} visible entries`
      )
    }

    const results: ProjectFileEntry[] = []
    for (const entry of visible) {
      const entryPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        results.push({ name: entry.name, path: entryPath, kind: 'directory' })
        continue
      }
      results.push({ name: entry.name, path: entryPath, kind: 'file' })
    }
    return results
  }

  async searchFiles(
    projectId: string,
    query: string,
    category: 'all' | 'rules',
    scopeBucketId?: string
  ): Promise<ProjectFileEntry[]> {
    const root = await this.projectRoot(projectId, scopeBucketId)
    const project = await this.projects.getProject(projectId)
    // Scoped searches index their own root: a worktree checkout must never
    // share (or poison) the project-root index.
    return this.fileIndex.search(
      scopedKey(projectId, scopeBucketId),
      root,
      query,
      category,
      project?.name
    )
  }

  invalidateProject(projectId: string, scopeBucketId?: string): void {
    if (scopeBucketId) {
      this.fileIndex.invalidate(scopedKey(projectId, scopeBucketId))
      return
    }
    // A project-level invalidation clears the project root's index plus every
    // scoped index derived from it, so stale worktree entries never survive.
    this.fileIndex.invalidate(projectId)
    const prefix = `${projectId}::`
    for (const key of [...this.fileIndex.indexKeys()]) {
      if (key.startsWith(prefix)) this.fileIndex.invalidate(key)
    }
  }

  /** Warm the file index for a project in the background and start watching
   *  its root for external changes (agent file writes, git operations, other
   *  editors), so searches are instant and stay fresh without a full rebuild
   *  per search. Fire-and-forget: projects without a usable local root
   *  (remote, cloud) simply never get an index or watcher. */
  async prewarmProject(projectId: string): Promise<void> {
    try {
      const root = await this.projectRoot(projectId)
      await this.fileIndex.prewarm(projectId, root)
    } catch {
      // No local root; nothing to index or watch.
    }
  }

  /** Stop watching a project and drop its index (project removed). */
  disposeProject(projectId: string): void {
    this.fileIndex.dispose(projectId)
    const prefix = `${projectId}::`
    for (const key of [...this.fileIndex.indexKeys()]) {
      if (key.startsWith(prefix)) this.fileIndex.dispose(key)
    }
  }

  /**
   * Resolve agent-authored file citations against the project root. A candidate
   * resolves to a canonical project-relative path only when the entry actually
   * exists on disk as a regular file or directory inside the root. Candidates
   * may be relative (`src/foo.ts`), prefixed with the project CWD (absolute), or
   * `file://` URLs. Anything that does not exist, escapes the root, or is a
   * symbolic link resolves to `null` — such citations must never become links.
   */
  async resolveCitationPaths(
    projectId: string,
    candidates: string[],
    scopeBucketId?: string
  ): Promise<Record<string, string | null>> {
    const project = await this.projects.getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    if (project.source !== 'local' || !project.path.trim()) {
      return Object.fromEntries(candidates.map((candidate) => [candidate, null]))
    }
    const root = await this.projectRoot(projectId, scopeBucketId)
    const results: Record<string, string | null> = {}
    for (const rawCandidate of candidates) {
      results[rawCandidate] = await this.resolveCitationPath(root, rawCandidate)
    }
    return results
  }

  /**
   * Existence probe for absolute citation paths that live outside the project
   * root (e.g. Codex `:codex-file-citation` tokens). Returns whether each path
   * exists on disk as a regular file or directory (symlinks resolve to false).
   * Purely an existence check — no content is read or returned.
   */
  async resolveExternalCitationPaths(absolutePaths: string[]): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {}
    for (const candidate of absolutePaths) {
      results[candidate] = await this.externalCitationPathExists(candidate)
    }
    return results
  }

  private async externalCitationPathExists(rawCandidate: string): Promise<boolean> {
    if (!rawCandidate || rawCandidate.includes('\0')) return false
    if (!isAbsolute(rawCandidate)) return false
    try {
      const metadata = await lstat(rawCandidate)
      if (metadata.isSymbolicLink()) return false
      return metadata.isFile() || metadata.isDirectory()
    } catch (error) {
      if (this.isMissingPathError(error)) return false
      throw error
    }
  }

  private async resolveCitationPath(root: string, rawCandidate: string): Promise<string | null> {
    if (rawCandidate.length === 0 || rawCandidate.length > MAX_RELATIVE_PATH_LENGTH) return null
    if (rawCandidate.includes('\0') || rawCandidate.includes('\\')) return null

    let candidate = rawCandidate
    if (candidate.startsWith('file://')) {
      try {
        candidate = decodeURIComponent(new URL(candidate).pathname)
      } catch {
        return null
      }
    }
    while (candidate.startsWith('./')) candidate = candidate.slice(2)

    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
    if (!isWithinRoot(root, absolute)) return null

    const relativePath = toPosixPath(relative(root, absolute))
    if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) return null

    const segments = relativePath.split('/').filter(Boolean)
    if (segments.some((segment) => segment === '.' || segment === '..')) return null

    try {
      let current = root
      for (const segment of segments) {
        current = resolve(current, segment)
        if (!isWithinRoot(root, current)) return null
        const metadata = await lstat(current)
        if (metadata.isSymbolicLink()) return null
      }
      const metadata = await lstat(current)
      if (!metadata.isFile() && !metadata.isDirectory()) return null
      return relativePath
    } catch (error) {
      if (this.isMissingPathError(error)) return null
      throw error
    }
  }

  /**
   * Resolve untrusted prompt references against their project root and return
   * canonical display metadata. Existing path resolution rejects traversal,
   * absolute paths, symlinks, and non-regular filesystem entries.
   */
  async validatePromptReferences(
    projectId: string,
    references: PromptProjectReference[],
    scopeBucketId?: string
  ): Promise<PromptProjectReference[]> {
    const root = await this.projectRoot(projectId, scopeBucketId)
    return Promise.all(
      references.map(async (reference) => {
        const entry = await this.resolveExistingEntry(root, reference.path)
        if (entry.kind !== reference.kind) {
          throw new Error(`Project reference kind does not match the path: ${reference.path}`)
        }
        const name = basename(reference.path)
        if (reference.name !== name) {
          throw new Error(`Project reference name does not match the path: ${reference.path}`)
        }
        return { ...reference, name, path: toPosixPath(reference.path), kind: entry.kind }
      })
    )
  }

  async readText(
    projectId: string,
    relativePath: string,
    scopeBucketId?: string
  ): Promise<ProjectTextFile> {
    const root = await this.projectRoot(projectId, scopeBucketId)
    const target = await this.resolveExistingPath(root, relativePath, false)
    return this.readResolvedText(target, relativePath)
  }

  async createFile(
    projectId: string,
    relativeDirectory: string,
    name: string,
    scopeBucketId?: string
  ): Promise<ProjectFileEntry> {
    return this.runMutationExclusive(async () => {
      const root = await this.projectRoot(projectId, scopeBucketId)
      const target = await this.resolveNewPath(root, relativeDirectory, name)
      const file = await open(
        target.absolutePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      await file.close()
      this.invalidateProject(projectId, scopeBucketId)
      return { name, path: target.relativePath, kind: 'file' }
    })
  }

  async createDirectory(
    projectId: string,
    relativeDirectory: string,
    name: string,
    scopeBucketId?: string
  ): Promise<ProjectFileEntry> {
    return this.runMutationExclusive(async () => {
      const root = await this.projectRoot(projectId, scopeBucketId)
      const target = await this.resolveNewPath(root, relativeDirectory, name)
      await mkdir(target.absolutePath)
      this.invalidateProject(projectId, scopeBucketId)
      return { name, path: target.relativePath, kind: 'directory' }
    })
  }

  async renameEntry(
    projectId: string,
    relativePath: string,
    name: string,
    scopeBucketId?: string
  ): Promise<ProjectFileEntry> {
    return this.runMutationExclusive(async () => {
      const root = await this.projectRoot(projectId, scopeBucketId)
      const source = await this.resolveExistingEntry(root, relativePath)
      const target = await this.resolveNewPath(root, toPosixPath(dirname(relativePath)), name)
      if (source.kind === 'directory') {
        await rename(source.absolutePath, target.absolutePath)
      } else {
        await link(source.absolutePath, target.absolutePath)
        try {
          await rm(source.absolutePath)
        } catch (error) {
          await rm(target.absolutePath, { force: true }).catch(() => undefined)
          throw error
        }
      }
      this.invalidateProject(projectId, scopeBucketId)
      return { name, path: target.relativePath, kind: source.kind }
    })
  }

  async resolveForTrash(
    projectId: string,
    relativePath: string,
    scopeBucketId?: string
  ): Promise<string> {
    const root = await this.projectRoot(projectId, scopeBucketId)
    return (await this.resolveExistingEntry(root, relativePath)).absolutePath
  }

  async pasteEntry(
    sourceProjectId: string,
    sourcePath: string,
    destinationProjectId: string,
    destinationDirectory: string,
    mode: ProjectFileTransferMode,
    sourceScopeBucketId?: string,
    destinationScopeBucketId?: string
  ): Promise<ProjectFileEntry> {
    return this.runMutationExclusive(async () => {
      const sourceRoot = await this.projectRoot(sourceProjectId, sourceScopeBucketId)
      const destinationRoot = await this.projectRoot(destinationProjectId, destinationScopeBucketId)
      const source = await this.resolveExistingEntry(sourceRoot, sourcePath)
      if (sourceProjectId === destinationProjectId) {
        const destinationPosix = toPosixPath(destinationDirectory)
        if (destinationPosix === sourcePath || destinationPosix.startsWith(`${sourcePath}/`)) {
          throw new Error('A folder cannot be pasted into itself')
        }
      }
      const target = await this.resolveNewPath(
        destinationRoot,
        destinationDirectory,
        basename(sourcePath)
      )
      if (source.kind === 'directory') {
        await this.pasteDirectory(source.absolutePath, target.absolutePath, mode)
      } else if (mode === 'copy') {
        const temporaryPath = join(
          dirname(target.absolutePath),
          `.${basename(target.absolutePath)}.${process.pid}.${randomUUID()}.tmp`
        )
        try {
          await copyFile(source.absolutePath, temporaryPath, constants.COPYFILE_EXCL)
          await link(temporaryPath, target.absolutePath)
        } finally {
          await rm(temporaryPath, { force: true }).catch(() => undefined)
        }
      } else {
        await link(source.absolutePath, target.absolutePath)
        try {
          await rm(source.absolutePath)
        } catch (error) {
          await rm(target.absolutePath, { force: true }).catch(() => undefined)
          throw error
        }
      }
      this.invalidateProject(destinationProjectId, destinationScopeBucketId)
      if (
        sourceProjectId !== destinationProjectId ||
        sourceScopeBucketId !== destinationScopeBucketId
      ) {
        this.invalidateProject(sourceProjectId, sourceScopeBucketId)
      }
      return { name: basename(sourcePath), path: target.relativePath, kind: source.kind }
    })
  }

  /** Copy a directory tree, or move it (rename, falling back to copy + delete across volumes). */
  private async pasteDirectory(
    source: string,
    target: string,
    mode: ProjectFileTransferMode
  ): Promise<void> {
    if (mode === 'copy') {
      await this.copyDirectory(source, target)
      return
    }
    try {
      await rename(source, target)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EXDEV') {
        throw error
      }
      try {
        await this.copyDirectory(source, target)
      } catch (copyError) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined)
        throw copyError
      }
      await rm(source, { recursive: true, force: true })
    }
  }

  /**
   * Copy one or more absolute filesystem paths (files or folders) from outside the
   * project into a destination directory inside it. Folders are copied recursively.
   * Rejects symbolic links, path traversal, absolute project paths, and non-regular
   * entries. Collisions are resolved by appending a numeric suffix (e.g. "name (2).txt").
   */
  async importPaths(
    projectId: string,
    sourcePaths: string[],
    destinationDirectory: string,
    scopeBucketId?: string
  ): Promise<ProjectFileEntry[]> {
    return this.runMutationExclusive(async () => {
      const root = await this.projectRoot(projectId, scopeBucketId)
      const destination = await this.resolveExistingPath(root, destinationDirectory, true)
      const imported: ProjectFileEntry[] = []
      for (const sourcePath of sourcePaths) {
        imported.push(await this.importOne(root, destination, sourcePath))
      }
      this.invalidateProject(projectId, scopeBucketId)
      return imported
    })
  }

  /**
   * Handle native filesystem paths dropped on the project tree. Entries that
   * already belong to this project are moved; paths from elsewhere are copied in.
   */
  async dropPaths(
    projectId: string,
    sourcePaths: string[],
    destinationDirectory: string,
    scopeBucketId?: string
  ): Promise<ProjectFileDropResult[]> {
    return this.runMutationExclusive(async () => {
      const root = await this.projectRoot(projectId, scopeBucketId)
      const destination = await this.resolveExistingPath(root, destinationDirectory, true)
      const dropped: ProjectFileDropResult[] = []
      const candidates: string[] = []

      for (const sourcePath of sourcePaths) {
        if (!isAbsolute(sourcePath)) throw new Error('Dropped paths must be absolute')
        const metadata = await lstat(sourcePath)
        if (metadata.isSymbolicLink()) throw new Error('Symbolic links cannot be dropped')
        const source = await realpath(sourcePath)
        if (!candidates.includes(source)) candidates.push(source)
      }

      const sources = candidates.filter(
        (candidate) =>
          !candidates.some((other) => other !== candidate && isWithinRoot(other, candidate))
      )

      for (const source of sources) {
        if (isWithinRoot(root, source) && source !== root) {
          const relativePath = toPosixPath(relative(root, source))
          dropped.push({
            entry: await this.moveWithinProject(root, relativePath, destinationDirectory),
            movedFrom: relativePath
          })
        } else {
          dropped.push({ entry: await this.importOne(root, destination, source) })
        }
      }

      this.invalidateProject(projectId, scopeBucketId)
      return dropped
    })
  }

  resolveForDragSync(projectId: string, relativePaths: string[], scopeBucketId?: string): string[] {
    const root = this.projectRoots.get(scopedKey(projectId, scopeBucketId))
    if (!root) throw new Error('Project files must be loaded before they can be dragged')
    const resolved: string[] = []
    const uniquePaths = [...new Set(relativePaths)].filter(
      (candidate) =>
        !relativePaths.some((other) => other !== candidate && candidate.startsWith(`${other}/`))
    )
    for (const relativePath of uniquePaths) {
      const segments = this.validateRelativePath(relativePath, false)
      let current = root
      for (const segment of segments) {
        current = resolve(current, segment)
        if (!isWithinRoot(root, current))
          throw new Error('Project file path escapes the project root')
        const metadata = lstatSync(current)
        if (metadata.isSymbolicLink()) {
          throw new Error('Symbolic links are not available in the sidebar')
        }
      }
      const metadata = lstatSync(current)
      if (!metadata.isFile() && !metadata.isDirectory()) {
        throw new Error('Project path is not a regular file or directory')
      }
      const canonical = realpathSync(current)
      if (!isWithinRoot(root, canonical))
        throw new Error('Project file path escapes the project root')
      resolved.push(canonical)
    }
    return resolved
  }

  private async moveWithinProject(
    root: string,
    sourcePath: string,
    destinationDirectory: string
  ): Promise<ProjectFileEntry> {
    const source = await this.resolveExistingEntry(root, sourcePath)
    const sourceDirectory = toPosixPath(dirname(sourcePath))
    if ((sourceDirectory === '.' ? '' : sourceDirectory) === destinationDirectory) {
      return { name: basename(sourcePath), path: sourcePath, kind: source.kind }
    }
    if (source.kind === 'directory') {
      const destination = toPosixPath(destinationDirectory)
      if (destination === sourcePath || destination.startsWith(`${sourcePath}/`)) {
        throw new Error('A folder cannot be moved into itself')
      }
    }

    const target = await this.resolveNewPath(root, destinationDirectory, basename(sourcePath))
    if (source.kind === 'directory') {
      await this.pasteDirectory(source.absolutePath, target.absolutePath, 'move')
    } else {
      await link(source.absolutePath, target.absolutePath)
      try {
        await rm(source.absolutePath)
      } catch (error) {
        await rm(target.absolutePath, { force: true }).catch(() => undefined)
        throw error
      }
    }
    return { name: basename(sourcePath), path: target.relativePath, kind: source.kind }
  }

  private async importOne(
    root: string,
    destination: string,
    sourcePath: string
  ): Promise<ProjectFileEntry> {
    if (!isAbsolute(sourcePath)) {
      throw new Error('Import source must be an absolute filesystem path')
    }
    const rawMetadata = await lstat(sourcePath)
    if (rawMetadata.isSymbolicLink()) {
      throw new Error('Symbolic links cannot be imported')
    }
    const source = await realpath(sourcePath)
    const metadata = await lstat(source)
    if (!metadata.isDirectory() && !metadata.isFile()) {
      throw new Error('Only files and folders can be imported')
    }
    if (metadata.isDirectory() && isWithinRoot(source, destination)) {
      throw new Error('A folder cannot be imported into itself')
    }

    const name = basename(source)
    const target = await this.resolveImportTarget(destination, name, metadata.isDirectory())
    const relativePath = toPosixPath(relative(root, target))
    this.validateRelativePath(relativePath, false)

    if (metadata.isDirectory()) {
      await this.copyDirectory(source, target)
    } else {
      await this.copyFileWithTemp(source, target)
    }
    return {
      name: basename(target),
      path: relativePath,
      kind: metadata.isDirectory() ? 'directory' : 'file'
    }
  }

  private async resolveImportTarget(
    destination: string,
    name: string,
    isDirectory: boolean
  ): Promise<string> {
    const extension = isDirectory ? '' : extname(name)
    const stem = isDirectory ? name : basename(name, extension)
    let target = resolve(destination, name)
    let index = 1
    while (await this.pathExists(target)) {
      const suffix = ` (${index})`
      target = resolve(
        destination,
        isDirectory ? `${stem}${suffix}` : `${stem}${suffix}${extension}`
      )
      index += 1
    }
    return target
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (error) {
      if (this.isMissingPathError(error)) return false
      throw error
    }
  }

  private async copyDirectory(source: string, target: string): Promise<void> {
    await mkdir(target)
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error('Symbolic links cannot be copied')
      }
      const sourceEntry = join(source, entry.name)
      const targetEntry = join(target, entry.name)
      if (entry.isDirectory()) {
        await this.copyDirectory(sourceEntry, targetEntry)
      } else if (entry.isFile()) {
        await this.copyFileWithTemp(sourceEntry, targetEntry)
      }
    }
  }

  private async copyFileWithTemp(source: string, target: string): Promise<void> {
    const temporaryPath = join(
      dirname(target),
      `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`
    )
    try {
      await copyFile(source, temporaryPath, constants.COPYFILE_EXCL)
      await link(temporaryPath, target)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  async getInfo(
    projectId: string,
    relativePath: string,
    scopeBucketId?: string
  ): Promise<ProjectFileInfo> {
    const root = await this.projectRoot(projectId, scopeBucketId)
    const entry = await this.resolveExistingEntry(root, relativePath)
    const metadata = await lstat(entry.absolutePath)
    return {
      name: basename(relativePath),
      path: toPosixPath(relativePath),
      absolutePath: entry.absolutePath,
      kind: entry.kind,
      size: entry.kind === 'file' ? metadata.size : undefined,
      createdAt: metadata.birthtimeMs,
      modifiedAt: metadata.mtimeMs,
      mode: metadata.mode
    }
  }

  async resolveForExternalEditor(
    projectId: string,
    relativePath: string,
    scopeBucketId?: string
  ): Promise<string> {
    const root = await this.projectRoot(projectId, scopeBucketId)
    return this.resolveExistingPath(root, relativePath, false)
  }

  async writeText(
    projectId: string,
    relativePath: string,
    content: string,
    expectedRevision: string,
    scopeBucketId?: string
  ): Promise<ProjectTextFile> {
    const key = `${projectId}:${scopeBucketId ?? ''}:${relativePath}`
    return this.runMutationExclusive(() =>
      this.runWriteExclusive(key, async () => {
        const root = await this.projectRoot(projectId, scopeBucketId)
        const target = await this.resolveExistingPath(root, relativePath, false)
        const current = await this.readResolvedText(target, relativePath)
        if (current.revision !== expectedRevision) {
          throw new Error('This file changed on disk. Reload it before saving your draft.')
        }

        const nextContent = new TextEncoder().encode(content)
        if (nextContent.byteLength > MAX_TEXT_FILE_BYTES) {
          throw new Error('Text files larger than 2 MiB cannot be edited here')
        }
        decodeText(nextContent)

        const metadata = await lstat(target)
        const parent = await realpath(dirname(target))
        if (!isWithinRoot(root, parent)) {
          throw new Error('Project file path escapes the project root')
        }

        const temporaryPath = join(
          parent,
          `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`
        )
        try {
          const temporaryFile = await open(
            temporaryPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            metadata.mode
          )
          try {
            await temporaryFile.chmod(metadata.mode)
            await temporaryFile.writeFile(nextContent)
            await temporaryFile.sync()
          } finally {
            await temporaryFile.close()
          }

          const latest = await this.readResolvedText(target, relativePath)
          if (latest.revision !== expectedRevision) {
            throw new Error('This file changed on disk. Reload it before saving your draft.')
          }
          await rename(temporaryPath, target)
        } catch (error) {
          await rm(temporaryPath, { force: true }).catch(() => undefined)
          throw error
        }

        return this.readResolvedText(target, relativePath)
      })
    )
  }

  private async projectRoot(projectId: string, scopeBucketId?: string): Promise<string> {
    const cacheKey = scopedKey(projectId, scopeBucketId)
    const cached = this.projectRoots.get(cacheKey)
    if (cached) return cached

    // A managed scope's worktree is the authoritative root for the call and is
    // resolved fail-closed: an unhealthy managed scope throws instead of
    // silently operating on the project directory.
    if (scopeBucketId) {
      if (!this.scopeRoots) {
        throw new Error('Managed scope resolution is unavailable for project files')
      }
      const scopedRoot = await this.scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
      if (!scopedRoot) {
        throw new Error(`Scope root unavailable: ${projectId}:${scopeBucketId}`)
      }
      const root = await realpath(scopedRoot)
      const metadata = await lstat(root)
      if (!metadata.isDirectory()) {
        throw new Error('Project root is not a directory')
      }
      this.projectRoots.set(cacheKey, root)
      return root
    }

    const project = await this.projects.getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    if (project.source !== 'local') {
      throw new Error('Sidebar file editing is not available for remote projects')
    }
    if (!project.path.trim()) {
      throw new Error('This project does not have a local filesystem root')
    }
    const root = await realpath(resolve(project.path))
    const metadata = await lstat(root)
    if (!metadata.isDirectory()) {
      throw new Error('Project root is not a directory')
    }
    this.projectRoots.set(cacheKey, root)
    return root
  }

  private validateRelativePath(path: string, allowEmpty: boolean): string[] {
    if (path.length > MAX_RELATIVE_PATH_LENGTH) {
      throw new Error('Project file path is too long')
    }
    if (path.includes('\0') || path.includes('\\')) {
      throw new Error('Project file path contains unsupported characters')
    }
    if (isAbsolute(path) || /^[a-zA-Z]:/u.test(path)) {
      throw new Error('Project file path must be relative')
    }
    if (!allowEmpty && path.length === 0) {
      throw new Error('Project file path is required')
    }

    const segments = path.split('/').filter(Boolean)
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      throw new Error('Project file path is not available in the sidebar')
    }
    if (segments.join('/') !== path && path !== '') {
      throw new Error('Project file path must use normalized relative segments')
    }
    return segments
  }

  private validateEntryName(name: string): void {
    if (
      name.length === 0 ||
      name.length > 255 ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      name.includes('\\') ||
      name.includes('\0')
    ) {
      throw new Error('File name must be one valid path segment')
    }
  }

  private async resolveNewPath(
    root: string,
    relativeDirectory: string,
    name: string
  ): Promise<{ absolutePath: string; relativePath: string }> {
    this.validateEntryName(name)
    const normalizedDirectory = relativeDirectory === '.' ? '' : relativeDirectory
    const directory = await this.resolveExistingPath(root, normalizedDirectory, true)
    const relativePath = normalizedDirectory ? `${normalizedDirectory}/${name}` : name
    this.validateRelativePath(relativePath, false)
    const absolutePath = resolve(directory, name)
    if (!isWithinRoot(root, absolutePath)) {
      throw new Error('Project file path escapes the project root')
    }
    try {
      await lstat(absolutePath)
    } catch (error) {
      if (this.isMissingPathError(error)) return { absolutePath, relativePath }
      throw error
    }
    throw new Error(`A file or directory named "${name}" already exists`)
  }

  private async resolveExistingEntry(
    root: string,
    relativePath: string
  ): Promise<{ absolutePath: string; kind: ProjectFileEntry['kind'] }> {
    const segments = this.validateRelativePath(relativePath, false)
    let current = root
    for (const segment of segments) {
      current = resolve(current, segment)
      if (!isWithinRoot(root, current)) {
        throw new Error('Project file path escapes the project root')
      }
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink()) {
        throw new Error('Symbolic links are not available in the sidebar')
      }
    }
    const metadata = await lstat(current)
    const kind = metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : null
    if (!kind) throw new Error('Project path is not a regular file or directory')
    const canonical = await realpath(current)
    if (!isWithinRoot(root, canonical)) {
      throw new Error('Project file path escapes the project root')
    }
    return { absolutePath: canonical, kind }
  }

  private isMissingPathError(error: unknown): boolean {
    return (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code === 'ENOENT'
    )
  }

  private async resolveExistingPath(
    root: string,
    relativePath: string,
    expectDirectory: boolean
  ): Promise<string> {
    const segments = this.validateRelativePath(relativePath, expectDirectory)
    let current = root
    for (const segment of segments) {
      current = resolve(current, segment)
      if (!isWithinRoot(root, current)) {
        throw new Error('Project file path escapes the project root')
      }
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink()) {
        throw new Error('Symbolic links are not available in the sidebar')
      }
    }

    const metadata = await lstat(current)
    if (expectDirectory ? !metadata.isDirectory() : !metadata.isFile()) {
      throw new Error(
        expectDirectory
          ? 'Project file path is not a directory'
          : 'Project file path is not a regular file'
      )
    }
    const canonical = await realpath(current)
    if (!isWithinRoot(root, canonical)) {
      throw new Error('Project file path escapes the project root')
    }
    return canonical
  }

  private async readResolvedText(target: string, relativePath: string): Promise<ProjectTextFile> {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await file.stat()
      if (!metadata.isFile()) {
        throw new Error('Project file path is not a regular file')
      }
      if (metadata.size > MAX_TEXT_FILE_BYTES) {
        throw new Error('Text files larger than 2 MiB cannot be edited here')
      }
      const content = await file.readFile()
      return {
        path: toPosixPath(relativePath),
        content: decodeText(content),
        size: content.byteLength,
        modifiedAt: metadata.mtimeMs,
        revision: revisionOf(content)
      }
    } finally {
      await file.close()
    }
  }

  private async runWriteExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    const queued = previous.then(() => gate)
    this.writeQueues.set(key, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.writeQueues.get(key) === queued) this.writeQueues.delete(key)
    }
  }

  private async runMutationExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue
    let release = (): void => undefined
    this.mutationQueue = new Promise<void>((resolveMutation) => {
      release = resolveMutation
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
