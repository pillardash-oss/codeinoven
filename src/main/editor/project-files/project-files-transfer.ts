/**
 * Transfer operations for project files: paste, import, drop and the recursive
 * copy helpers they share. Every mutation runs in the service's mutation queue
 * and reports the invalidated (project, scope) root back to it.
 */

import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { toPosixPath } from '../../../lib/paths'
import type {
  ProjectFileDropResult,
  ProjectFileEntry,
  ProjectFileTransferMode
} from '../../../lib/types'
import { isMissingPathError, isWithinRoot, validateRelativePath } from './project-files-paths'
import type { ProjectFilesRootResolver } from './project-files-roots'

export interface ProjectFilesTransferDeps {
  roots: ProjectFilesRootResolver
  runExclusive: <T>(operation: () => Promise<T>) => Promise<T>
  invalidate: (projectId: string, scopeBucketId?: string) => void
}

export class ProjectFilesTransfer {
  constructor(private readonly deps: ProjectFilesTransferDeps) {}

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
    return this.deps.runExclusive(async () => {
      const sourceRoot = await this.deps.roots.projectRoot(
        sourceProjectId,
        sourceScopeBucketId,
        sourceThreadId
      )
      const destinationRoot = await this.deps.roots.projectRoot(
        destinationProjectId,
        destinationScopeBucketId,
        destinationThreadId
      )
      const source = await this.deps.roots.resolveExistingEntry(sourceRoot, sourcePath)
      if (sourceProjectId === destinationProjectId) {
        const destinationPosix = toPosixPath(destinationDirectory)
        if (destinationPosix === sourcePath || destinationPosix.startsWith(`${sourcePath}/`)) {
          throw new Error('A folder cannot be pasted into itself')
        }
      }
      const target = await this.deps.roots.resolveNewPath(
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
      this.deps.invalidate(destinationProjectId, destinationScopeBucketId)
      if (
        sourceProjectId !== destinationProjectId ||
        sourceScopeBucketId !== destinationScopeBucketId
      ) {
        this.deps.invalidate(sourceProjectId, sourceScopeBucketId)
      }
      return { name: basename(sourcePath), path: target.relativePath, kind: source.kind }
    })
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
    return this.deps.runExclusive(async () => {
      const root = await this.deps.roots.projectRoot(projectId, scopeBucketId, threadId)
      const destination = await this.deps.roots.resolveExistingPath(
        root,
        destinationDirectory,
        true
      )
      const imported: ProjectFileEntry[] = []
      for (const sourcePath of sourcePaths) {
        imported.push(await this.importOne(root, destination, sourcePath))
      }
      this.deps.invalidate(projectId, scopeBucketId)
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
    scopeBucketId?: string,
    threadId?: string
  ): Promise<ProjectFileDropResult[]> {
    return this.deps.runExclusive(async () => {
      const root = await this.deps.roots.projectRoot(projectId, scopeBucketId, threadId)
      const destination = await this.deps.roots.resolveExistingPath(
        root,
        destinationDirectory,
        true
      )
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

      this.deps.invalidate(projectId, scopeBucketId)
      return dropped
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

  private async moveWithinProject(
    root: string,
    sourcePath: string,
    destinationDirectory: string
  ): Promise<ProjectFileEntry> {
    const source = await this.deps.roots.resolveExistingEntry(root, sourcePath)
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

    const target = await this.deps.roots.resolveNewPath(
      root,
      destinationDirectory,
      basename(sourcePath)
    )
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
    validateRelativePath(relativePath, false)

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
      if (isMissingPathError(error)) return false
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
}
