/**
 * Root authority for project files: resolves and caches the (project, scope,
 * thread) mount root, and resolves individual entries beneath it fail-closed.
 * Every method keeps the original containment rules; the service owns the
 * higher-level operations built on top.
 */

import { realpathSync, statSync, type Stats } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ASSISTANT_SPACE_ID, usesThreadWorkspaceMount } from '../../../lib/types'
import type { Project, ProjectFileEntry } from '../../../lib/types'
import {
  isWithinRoot,
  isMissingPathError,
  scopedKey,
  validateEntryName,
  validateRelativePath
} from './project-files-paths'

export interface ProjectFilesProjectLookup {
  getProject(projectId: string): Promise<Project | null>
  listProjects(): Promise<Project[]>
}

/** Resolves a managed scope's filesystem root; unhealthy scopes fail closed. */
export interface ProjectFilesScopeRootLookup {
  resolveCompatibilityRoot(projectId: string, scopeBucketId: string): Promise<string | null>
}

/** Resolves (and creates) one chat thread's `chats-artifacts/<threadId>` root.
 *  Chat file trees mount here: the directory is app-owned per-thread scratch
 *  space, so resolution must not depend on a project record. */
export interface ProjectFilesChatArtifactRootLookup {
  resolve(threadId: string): Promise<string>
}

/** Resolves (and creates) one assistant task's `assistant-cwd/<routineId ??
 *  threadId>` root. Assistant file trees mount here: the directory is the
 *  task's own working directory, app-owned and shared by every task in the
 *  same routine, so resolution must not depend on a project record either. */
export interface ProjectFilesAssistantRootLookup {
  resolve(threadId: string): Promise<string>
}

/** App-owned thread workspace roots, both resolved lazily and created on
 *  demand so an empty conversation still has a browsable file tree. */
export interface ProjectFilesThreadWorkspaceRoots {
  chatArtifacts?: ProjectFilesChatArtifactRootLookup
  assistant?: ProjectFilesAssistantRootLookup
}

export class ProjectFilesRootResolver {
  private readonly projectRoots = new Map<string, string>()

  constructor(
    private readonly projects: ProjectFilesProjectLookup,
    private readonly scopeRoots?: ProjectFilesScopeRootLookup,
    private readonly threadWorkspaces: ProjectFilesThreadWorkspaceRoots = {}
  ) {}

  async projectRoot(projectId: string, scopeBucketId?: string, threadId?: string): Promise<string> {
    // App-owned thread workspaces are their own mount roots: per-conversation,
    // created on demand, and independent of any project record. A thread mount
    // outranks any scope bucket the caller passed along with it, because the
    // conversation's own directory is the authoritative root for the call.
    if (threadId !== undefined && usesThreadWorkspaceMount(projectId)) {
      const lookup =
        projectId === ASSISTANT_SPACE_ID
          ? this.threadWorkspaces.assistant
          : this.threadWorkspaces.chatArtifacts
      if (lookup) {
        const cacheKey = `${projectId}::thread:${threadId}`
        const cached = this.projectRoots.get(cacheKey)
        if (cached) return cached
        const root = await realpath(await lookup.resolve(threadId))
        const metadata = await lstat(root)
        if (!metadata.isDirectory()) {
          throw new Error('Thread workspace root is not a directory')
        }
        this.projectRoots.set(cacheKey, root)
        return root
      }
    }

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

  async resolveNewPath(
    root: string,
    relativeDirectory: string,
    name: string
  ): Promise<{ absolutePath: string; relativePath: string }> {
    validateEntryName(name)
    const normalizedDirectory = relativeDirectory === '.' ? '' : relativeDirectory
    const directory = await this.resolveExistingPath(root, normalizedDirectory, true)
    const relativePath = normalizedDirectory ? `${normalizedDirectory}/${name}` : name
    validateRelativePath(relativePath, false)
    const absolutePath = resolve(directory, name)
    if (!isWithinRoot(root, absolutePath)) {
      throw new Error('Project file path escapes the project root')
    }
    try {
      await lstat(absolutePath)
    } catch (error) {
      if (isMissingPathError(error)) return { absolutePath, relativePath }
      throw error
    }
    throw new Error(`A file or directory named "${name}" already exists`)
  }

  /**
   * Resolve one existing entry inside the root.
   *
   * Resolution is strict by default: every segment must be a real filesystem
   * entry, so a symlink in any position is rejected. Mutating callers
   * (`renameEntry`, `resolveForTrash`, paste/move) and untrusted prompt
   * references rely on that: resolving through a link would rename or trash the
   * link's target, or vouch for a path the tree never showed.
   *
   * `followSymlinks` opts a metadata-only caller into the same policy
   * `resolveExistingPath` applies: the entry may be (or pass through) a symlink,
   * the target decides the returned `kind`, and the realpath containment check
   * below stays the safety gate, so a link resolving outside the root still
   * fails.
   */
  async resolveExistingEntry(
    root: string,
    relativePath: string,
    options: { followSymlinks?: boolean } = {}
  ): Promise<{ absolutePath: string; kind: ProjectFileEntry['kind'] }> {
    const segments = validateRelativePath(relativePath, false)
    const followSymlinks = options.followSymlinks === true
    let current = root
    for (const segment of segments) {
      current = resolve(current, segment)
      if (!isWithinRoot(root, current)) {
        throw new Error('Project file path escapes the project root')
      }
      // Strict mode rejects a symlink in any position, so its callers always
      // act on the entry itself rather than on whatever a link points at.
      if (!followSymlinks && (await lstat(current)).isSymbolicLink()) {
        throw new Error('Symbolic links are not available in the sidebar')
      }
    }
    if (followSymlinks) return await this.resolveFollowedEntry(root, segments, relativePath)

    const metadata = await lstat(current)
    const kind = metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : null
    if (!kind) throw new Error('Project path is not a regular file or directory')
    const canonical = await realpath(current)
    if (!isWithinRoot(root, canonical)) {
      throw new Error('Project file path escapes the project root')
    }
    return { absolutePath: canonical, kind }
  }

  /**
   * Follow one already-validated relative entry to its canonical target, the
   * way `resolveExistingPath` does. `stat` follows the link so the target picks
   * the returned `kind`, and the realpath containment check is the safety gate.
   * Failures name the link when the entry (or an ancestor) is one, so a broken
   * or escaping link never surfaces as a raw `ENOENT`/`EINVAL` from `realpath`.
   */
  private async resolveFollowedEntry(
    root: string,
    segments: string[],
    relativePath: string
  ): Promise<{ absolutePath: string; kind: ProjectFileEntry['kind'] }> {
    const current = segments.reduce((parent, segment) => resolve(parent, segment), root)
    let metadata: Stats
    try {
      metadata = await stat(current)
    } catch (error) {
      if (await this.hasBrokenSymbolicLinkSegment(root, segments)) {
        throw new Error(`Project symbolic link is broken: ${relativePath}`, { cause: error })
      }
      if (isMissingPathError(error)) {
        throw new Error(`Project path does not exist: ${relativePath}`, { cause: error })
      }
      throw error
    }
    const kind = metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : null
    if (!kind) throw new Error('Project path is not a regular file or directory')
    let canonical: string
    try {
      canonical = await realpath(current)
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new Error(`Project path no longer resolves to an entry: ${relativePath}`, {
          cause: error
        })
      }
      throw new Error(`Project path could not be resolved: ${relativePath}`, { cause: error })
    }
    if (!isWithinRoot(root, canonical)) {
      throw new Error(`Project symbolic link resolves outside the project root: ${relativePath}`)
    }
    return { absolutePath: canonical, kind }
  }

  /** Whether any path segment is a symlink whose own target cannot be resolved
   *  (a broken link, or a link cycle). Checked without following the entry's
   *  full path, only to explain why a followed entry failed to resolve. */
  private async hasBrokenSymbolicLinkSegment(root: string, segments: string[]): Promise<boolean> {
    let current = root
    for (const segment of segments) {
      current = resolve(current, segment)
      try {
        if (!(await lstat(current)).isSymbolicLink()) continue
      } catch {
        return false
      }
      try {
        await stat(current)
      } catch {
        return true
      }
    }
    return false
  }

  async resolveExistingPath(
    root: string,
    relativePath: string,
    expectDirectory: boolean
  ): Promise<string> {
    const segments = validateRelativePath(relativePath, expectDirectory)
    let current = root
    for (const segment of segments) {
      current = resolve(current, segment)
      if (!isWithinRoot(root, current)) {
        throw new Error('Project file path escapes the project root')
      }
    }

    // Symlinks are followed so linked files and directories listed in the
    // tree can also be opened. Safety relies on the realpath containment
    // check below: only links resolving inside the project pass.
    const metadata = await stat(current)
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

  resolveForDragSync(projectId: string, relativePaths: string[], scopeBucketId?: string): string[] {
    const root = this.projectRoots.get(scopedKey(projectId, scopeBucketId))
    if (!root) throw new Error('Project files must be loaded before they can be dragged')
    const resolved: string[] = []
    const uniquePaths = [...new Set(relativePaths)].filter(
      (candidate) =>
        !relativePaths.some((other) => other !== candidate && candidate.startsWith(`${other}/`))
    )
    for (const relativePath of uniquePaths) {
      const segments = validateRelativePath(relativePath, false)
      let current = root
      for (const segment of segments) {
        current = resolve(current, segment)
        if (!isWithinRoot(root, current))
          throw new Error('Project file path escapes the project root')
      }
      // Symlinks are followed; the realpath containment check below is the
      // safety gate, so links resolving outside the project still fail.
      const metadata = statSync(current)
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
}
