import { constants } from 'node:fs'
import { mkdir, link, lstat, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { toPosixPath } from '../../lib/paths'
import { INBOX_PROJECT_ID } from '../../lib/types'
import { ProjectFileIndexService } from './project-file-index-service'
import type {
  ProjectFileDropResult,
  ProjectFileEntry,
  ProjectFileInfo,
  ProjectFileTransferMode,
  ProjectTextFile,
  PromptProjectReference
} from '../../lib/types'
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_TEXT_FILE_BYTES,
  decodeText,
  isSymlinkedDirectoryInsideRoot,
  isWithinRoot,
  revisionOf,
  scopedKey
} from './project-files/project-files-paths'
import { ProjectFilesRootResolver } from './project-files/project-files-roots'
import type {
  ProjectFilesAssistantRootLookup,
  ProjectFilesChatArtifactRootLookup,
  ProjectFilesProjectLookup,
  ProjectFilesScopeRootLookup,
  ProjectFilesThreadWorkspaceRoots
} from './project-files/project-files-roots'
import { ProjectFilesTransfer } from './project-files/project-files-transfer'
import {
  externalCitationPathExists,
  resolveCitationPath
} from './project-files/project-files-citations'

export type {
  ProjectFilesProjectLookup,
  ProjectFilesScopeRootLookup,
  ProjectFilesChatArtifactRootLookup,
  ProjectFilesAssistantRootLookup
}

export class ProjectFilesService {
  private readonly writeQueues = new Map<string, Promise<void>>()
  private readonly fileIndex = new ProjectFileIndexService()
  private mutationQueue: Promise<void> = Promise.resolve()
  /** Mount-root authority: resolves and caches (project, scope, thread) roots. */
  private readonly roots: ProjectFilesRootResolver
  /** Paste/import/drop operations, serialized through this service's queue. */
  private readonly transfer: ProjectFilesTransfer
  private readonly projects: ProjectFilesProjectLookup

  constructor(
    projects: ProjectFilesProjectLookup,
    scopeRoots?: ProjectFilesScopeRootLookup,
    threadWorkspaces: ProjectFilesThreadWorkspaceRoots = {}
  ) {
    this.projects = projects
    this.roots = new ProjectFilesRootResolver(projects, scopeRoots, threadWorkspaces)
    this.transfer = new ProjectFilesTransfer({
      roots: this.roots,
      runExclusive: (operation) => this.runMutationExclusive(operation),
      invalidate: (projectId, scopeBucketId) => this.invalidateProject(projectId, scopeBucketId)
    })
  }

  async listDirectory(
    projectId: string,
    relativeDirectory: string,
    scopeBucketId?: string,
    threadId?: string
  ): Promise<ProjectFileEntry[]> {
    const root = await this.roots.projectRoot(projectId, scopeBucketId, threadId)
    const directory = await this.roots.resolveExistingPath(root, relativeDirectory, true)
    const entries = await readdir(directory, { withFileTypes: true })
    // Symlinked entries are followed so linked files and directories appear in
    // the tree. A symlinked directory is only kept when its target stays inside
    // the project root after resolving symlinks, so links escaping the project
    // or cycling back up the tree are never listed.
    const visible: Array<{ name: string; isDirectory: boolean }> = []
    for (const entry of entries) {
      if (entry.isFile()) {
        visible.push({ name: entry.name, isDirectory: false })
        continue
      }
      if (entry.isDirectory()) {
        visible.push({ name: entry.name, isDirectory: true })
        continue
      }
      if (!entry.isSymbolicLink()) continue
      const linkPath = join(directory, entry.name)
      let target: import('node:fs').Stats
      try {
        target = await stat(linkPath)
      } catch {
        // Broken symlink: no target to list.
        continue
      }
      if (target.isFile()) {
        visible.push({ name: entry.name, isDirectory: false })
        continue
      }
      if (target.isDirectory() && (await isSymlinkedDirectoryInsideRoot(root, linkPath))) {
        visible.push({ name: entry.name, isDirectory: true })
      }
    }
    visible.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1
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
      results.push({
        name: entry.name,
        path: entryPath,
        kind: entry.isDirectory ? 'directory' : 'file'
      })
    }
    return results
  }

  async searchFiles(
    projectId: string,
    query: string,
    category: 'all' | 'rules',
    scopeBucketId?: string,
    threadId?: string
  ): Promise<ProjectFileEntry[]> {
    const root = await this.roots.projectRoot(projectId, scopeBucketId, threadId)
    const project = await this.projects.getProject(projectId)
    // Scoped searches index their own root: a worktree checkout must never
    // share (or poison) the project-root index. Chat thread mounts get their
    // own index key for the same reason.
    return this.fileIndex.search(
      threadId !== undefined
        ? `${projectId}::thread:${threadId}`
        : scopedKey(projectId, scopeBucketId),
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
  async prewarmProject(projectId: string, threadId?: string): Promise<void> {
    try {
      const root = await this.roots.projectRoot(projectId, undefined, threadId)
      await this.fileIndex.prewarm(
        threadId !== undefined ? `${projectId}::thread:${threadId}` : projectId,
        root
      )
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
   * symbolic link resolves to `null`   such citations must never become links.
   *
   * A candidate that runs through a regular file does not exist either, which is
   * the normal shape of a linked worktree's `.git`: it is a file, so `.git/heads`
   * has nothing under it. That resolves to `null` like any other missing entry.
   * It must not reject the call, because the resolver runs over agent-authored
   * text and one odd candidate would take the whole message's citations with it.
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
    const root = await this.roots.projectRoot(projectId, scopeBucketId)
    const results: Record<string, string | null> = {}
    for (const rawCandidate of candidates) {
      results[rawCandidate] = await resolveCitationPath(root, rawCandidate)
    }
    return results
  }

  /**
   * Existence probe for absolute citation paths that live outside the project
   * root (e.g. Codex `:codex-file-citation` tokens). Returns whether each path
   * exists on disk as a regular file or directory (symlinks resolve to false).
   * Purely an existence check   no content is read or returned.
   */
  async resolveExternalCitationPaths(absolutePaths: string[]): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {}
    for (const candidate of absolutePaths) {
      results[candidate] = await externalCitationPathExists(candidate)
    }
    return results
  }

  /**
   * Resolve untrusted prompt references against their project root and return
   * canonical display metadata. This deliberately keeps strict entry resolution:
   * traversal, absolute paths, symlinks, and non-regular filesystem entries are
   * rejected, so a reference can only name an entry the tree itself shows.
   */
  async validatePromptReferences(
    projectId: string,
    references: PromptProjectReference[],
    scopeBucketId?: string
  ): Promise<PromptProjectReference[]> {
    const root = await this.roots.projectRoot(projectId, scopeBucketId)
    return Promise.all(
      references.map(async (reference) => {
        const entry = await this.roots.resolveExistingEntry(root, reference.path)
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
    scopeBucketId?: string,
    threadId?: string
  ): Promise<ProjectTextFile> {
    const root = await this.roots.projectRoot(projectId, scopeBucketId, threadId)
    const target = await this.roots.resolveExistingPath(root, relativePath, false)
    return this.readResolvedText(target, relativePath)
  }

  /**
   * Read a text file at an absolute path that main has already authorized
   * (a file the user opened through the operating system). Scope checks stay at
   * the IPC boundary; this only enforces the shared text rules: a regular file,
   * within the 2 MiB editing cap, and decodable UTF-8.
   */
  async readAbsoluteText(absolutePath: string): Promise<ProjectTextFile> {
    const target = await realpath(absolutePath)
    return this.readResolvedText(target, toPosixPath(target))
  }

  /**
   * Write text to an already-authorized absolute path (a file the operating
   * system handed over, or one the user picked in a dialog). The privileged IPC
   * boundary resolves the scope before calling this, so the writer itself only
   * has to guarantee that the bytes land atomically and that a concurrent change
   * is never overwritten: the same revision check and temp-file swap the project
   * writer uses, minus the project-root containment (there is no project here).
   */
  async writeAbsoluteText(
    absolutePath: string,
    content: string,
    expectedRevision: string
  ): Promise<ProjectTextFile> {
    const target = await realpath(absolutePath)
    return this.runMutationExclusive(() =>
      this.runWriteExclusive(target, () =>
        this.writeResolvedText(target, toPosixPath(target), content, expectedRevision)
      )
    )
  }

  /**
   * The project whose root contains an absolute file path, with the path made
   * relative to that root. An OS hand-off of a file that already lives inside a
   * project opens in that project's own editor (file tree, scopes, save flow)
   * instead of the standalone viewer.
   *
   * The deepest matching root wins, so a project nested inside another project
   * claims its own files. Files outside every project, and paths that are not
   * regular files, resolve to `null`; the check is existence-based, so a path
   * that no longer resolves never matches.
   */
  async findProjectOwner(
    absolutePath: string
  ): Promise<{ projectId: string; relativePath: string } | null> {
    if (typeof absolutePath !== 'string' || absolutePath.length === 0) return null
    if (absolutePath.includes('\0')) return null
    let canonical: string
    try {
      canonical = await realpath(absolutePath)
      // Only regular files are ever routed into a project's editor; a directory
      // hand-off stays with the project registration path.
      if (!(await stat(canonical)).isFile()) return null
    } catch {
      return null
    }

    let owner: { projectId: string; root: string } | null = null
    for (const project of await this.projects.listProjects()) {
      if (project.id === INBOX_PROJECT_ID) continue
      if (project.source !== 'local' || !project.path.trim()) continue
      let root: string
      try {
        root = await realpath(resolve(project.path))
      } catch {
        // A project whose folder is gone can never own a live file.
        continue
      }
      if (root === canonical || !isWithinRoot(root, canonical)) continue
      if (!owner || root.length > owner.root.length) owner = { projectId: project.id, root }
    }
    if (!owner) return null
    return {
      projectId: owner.projectId,
      relativePath: toPosixPath(relative(owner.root, canonical))
    }
  }

  async createFile(
    projectId: string,
    relativeDirectory: string,
    name: string,
    scopeBucketId?: string,
    threadId?: string
  ): Promise<ProjectFileEntry> {
    return this.runMutationExclusive(async () => {
      const root = await this.roots.projectRoot(projectId, scopeBucketId, threadId)
      const target = await this.roots.resolveNewPath(root, relativeDirectory, name)
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
    scopeBucketId?: string,
    threadId?: string
  ): Promise<ProjectFileEntry> {
    return this.runMutationExclusive(async () => {
      const root = await this.roots.projectRoot(projectId, scopeBucketId, threadId)
      const target = await this.roots.resolveNewPath(root, relativeDirectory, name)
      await mkdir(target.absolutePath)
      this.invalidateProject(projectId, scopeBucketId)
      return { name, path: target.relativePath, kind: 'directory' }
    })
  }

  async renameEntry(
    projectId: string,
    relativePath: string,
    name: string,
    scopeBucketId?: string,
    threadId?: string
  ): Promise<ProjectFileEntry> {
    return this.runMutationExclusive(async () => {
      const root = await this.roots.projectRoot(projectId, scopeBucketId, threadId)
      const source = await this.roots.resolveExistingEntry(root, relativePath)
      const target = await this.roots.resolveNewPath(root, toPosixPath(dirname(relativePath)), name)
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
    scopeBucketId?: string,
    threadId?: string
  ): Promise<string> {
    const root = await this.roots.projectRoot(projectId, scopeBucketId, threadId)
    return (await this.roots.resolveExistingEntry(root, relativePath)).absolutePath
  }

  async pasteEntry(
    sourceProjectId: string,
    sourcePath: string,
    destinationProjectId: string,
    destinationDirectory: string,
    mode: ProjectFileTransferMode,
    sourceScopeBucketId?: string,
    destinationScopeBucketId?: string,
    sourceThreadId?: string,
    destinationThreadId?: string
  ): Promise<ProjectFileEntry> {
    return await this.transfer.pasteEntry(
      sourceProjectId,
      sourcePath,
      destinationProjectId,
      destinationDirectory,
      mode,
      sourceScopeBucketId,
      destinationScopeBucketId,
      sourceThreadId,
      destinationThreadId
    )
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
    scopeBucketId?: string,
    threadId?: string
  ): Promise<ProjectFileEntry[]> {
    return await this.transfer.importPaths(
      projectId,
      sourcePaths,
      destinationDirectory,
      scopeBucketId,
      threadId
    )
  }

  /**
   * Handle native filesystem paths dropped on the project tree. Entries that
   * already belong to this project are moved; paths from elsewhere are copied in.
   */
  async dropPaths(
    projectId: string,
    sourcePaths: string[],
    destinationDirectory: string,
    scopeBucketId?: string,
    threadId?: string
  ): Promise<ProjectFileDropResult[]> {
    return await this.transfer.dropPaths(
      projectId,
      sourcePaths,
      destinationDirectory,
      scopeBucketId,
      threadId
    )
  }

  resolveForDragSync(projectId: string, relativePaths: string[], scopeBucketId?: string): string[] {
    return this.roots.resolveForDragSync(projectId, relativePaths, scopeBucketId)
  }

  async getInfo(
    projectId: string,
    relativePath: string,
    scopeBucketId?: string,
    threadId?: string
  ): Promise<ProjectFileInfo> {
    const root = await this.roots.projectRoot(projectId, scopeBucketId, threadId)
    // Metadata intentionally follows symlinks, matching what `listDirectory`
    // shows and what the read path opens: a linked file or directory is an
    // entry the user can click, so copy-path/reveal/details must work on it.
    const entry = await this.roots.resolveExistingEntry(root, relativePath, {
      followSymlinks: true
    })
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
    scopeBucketId?: string,
    threadId?: string
  ): Promise<string> {
    const root = await this.roots.projectRoot(projectId, scopeBucketId, threadId)
    return this.roots.resolveExistingPath(root, relativePath, false)
  }

  /**
   * Canonical root of a (project, scope, thread) mount.
   *
   * `getInfo` resolves an entry *inside* a mount and rejects an empty path, so
   * callers that need the mount root itself (the directory preview server)
   * resolve it here instead of re-deriving scope authority.
   */
  async resolveMountRoot(
    projectId: string,
    scopeBucketId?: string,
    threadId?: string
  ): Promise<string> {
    return this.roots.projectRoot(projectId, scopeBucketId, threadId)
  }

  async writeText(
    projectId: string,
    relativePath: string,
    content: string,
    expectedRevision: string,
    scopeBucketId?: string,
    threadId?: string
  ): Promise<ProjectTextFile> {
    const key = `${projectId}:${scopeBucketId ?? ''}:${threadId ?? ''}:${relativePath}`
    return this.runMutationExclusive(() =>
      this.runWriteExclusive(key, async () => {
        const root = await this.roots.projectRoot(projectId, scopeBucketId, threadId)
        const target = await this.roots.resolveExistingPath(root, relativePath, false)
        const parent = await realpath(dirname(target))
        if (!isWithinRoot(root, parent)) {
          throw new Error('Project file path escapes the project root')
        }
        return this.writeResolvedText(target, relativePath, content, expectedRevision, parent)
      })
    )
  }

  /**
   * Revision-checked, UTF-8-validated, size-bounded atomic write of one text
   * file. Shared by the project writer and the standalone (project-less) writer
   * so a file opened straight from the operating system is saved with exactly the
   * same guarantees as a project file. `parent` is the already-resolved
   * directory to place the temp file in; a caller that checked containment
   * passes it so the check and the write cannot race on a swapped directory.
   */
  private async writeResolvedText(
    target: string,
    displayPath: string,
    content: string,
    expectedRevision: string,
    parent?: string
  ): Promise<ProjectTextFile> {
    const current = await this.readResolvedText(target, displayPath)
    if (current.revision !== expectedRevision) {
      throw new Error('This file changed on disk. Reload it before saving your draft.')
    }

    const nextContent = new TextEncoder().encode(content)
    if (nextContent.byteLength > MAX_TEXT_FILE_BYTES) {
      throw new Error('Text files larger than 2 MiB cannot be edited here')
    }
    decodeText(nextContent)

    const metadata = await lstat(target)
    const directory = parent ?? (await realpath(dirname(target)))
    const temporaryPath = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
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

      const latest = await this.readResolvedText(target, displayPath)
      if (latest.revision !== expectedRevision) {
        throw new Error('This file changed on disk. Reload it before saving your draft.')
      }
      await rename(temporaryPath, target)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }

    return this.readResolvedText(target, displayPath)
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
