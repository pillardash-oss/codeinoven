/**
 * Root authority for project files: resolves and caches the (project, scope,
 * thread) mount root, and resolves individual entries beneath it fail-closed.
 * Every method keeps the original containment rules; the service owns the
 * higher-level operations built on top.
 */

import { realpathSync, statSync } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { INBOX_PROJECT_ID } from '../../../lib/types'
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

export class ProjectFilesRootResolver {
  private readonly projectRoots = new Map<string, string>()

  constructor(
    private readonly projects: ProjectFilesProjectLookup,
    private readonly scopeRoots?: ProjectFilesScopeRootLookup,
    private readonly chatArtifactRoots?: ProjectFilesChatArtifactRootLookup
  ) {}

  async projectRoot(projectId: string, scopeBucketId?: string, threadId?: string): Promise<string> {
    // A chat thread's artifact directory is its own mount root: per-thread,
    // app-owned, created on demand, and independent of any project record.
    if (threadId !== undefined && projectId === INBOX_PROJECT_ID && this.chatArtifactRoots) {
      const cacheKey = `${projectId}::thread:${threadId}`
      const cached = this.projectRoots.get(cacheKey)
      if (cached) return cached
      const root = await realpath(await this.chatArtifactRoots.resolve(threadId))
      const metadata = await lstat(root)
      if (!metadata.isDirectory()) {
        throw new Error('Chat artifact root is not a directory')
      }
      this.projectRoots.set(cacheKey, root)
      return root
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

  async resolveExistingEntry(
    root: string,
    relativePath: string
  ): Promise<{ absolutePath: string; kind: ProjectFileEntry['kind'] }> {
    const segments = validateRelativePath(relativePath, false)
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
