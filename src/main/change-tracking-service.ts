import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { APP_SLUG } from '../lib/brand'
import { PROJECT_DATA_DIRECTORY } from '../lib/project-artifacts'

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  PROJECT_DATA_DIRECTORY,
  'node_modules',
  'out',
  'dist',
  'build',
  '.svelte-kit',
  `.${APP_SLUG}`,
  `.${APP_SLUG}-temp`,
  `${APP_SLUG}-temp`
])

export interface CheckpointBlobStore {
  put(hash: string, content: Uint8Array): Promise<void>
  get(hash: string): Promise<Uint8Array | null>
}

export interface CheckpointLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

export interface GitCheckpointMetadata {
  repositoryRoot: string
  head: string | null
  porcelainStatus: string
}

export interface CheckpointFile {
  path: string
  hash: string
  size: number
  binary: boolean
}

export interface ProjectCheckpoint {
  id: string
  projectRoot: string
  createdAt: number
  files: Record<string, CheckpointFile>
  git?: GitCheckpointMetadata
}

export type CheckpointChangeKind = 'created' | 'modified' | 'deleted'

export interface CheckpointChange {
  path: string
  kind: CheckpointChangeKind
  before?: CheckpointFile
  after?: CheckpointFile
}

export class CheckpointLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckpointLimitError'
  }
}

export class CheckpointSafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckpointSafetyError'
  }
}

export interface ChangeTrackingOptions {
  limits?: Partial<CheckpointLimits>
  excludedDirectoryNames?: Iterable<string>
}

export interface SnapshotOptions {
  includeGitMetadata?: boolean
}

interface CachedCheckpointFile {
  signature: string
  file: CheckpointFile
}

/**
 * A stat-only view of the project used to attribute mutations to the window in
 * which a tool ran. It stores no content, so it is cheap enough to take around
 * every shell command instead of only at turn boundaries.
 */
export interface ProjectFingerprint {
  projectRoot: string
  capturedAt: number
  /** Project-relative path → `${mtimeMs}:${size}`. */
  files: Record<string, string>
}

const DEFAULT_LIMITS: CheckpointLimits = {
  maxFiles: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024
}

/**
 * Captures content-addressed local-project checkpoints. It never follows symlinks
 * and restores only paths derived from the comparison supplied by the caller.
 */
export class ChangeTrackingService {
  private readonly limits: CheckpointLimits
  private readonly excludedDirectoryNames: Set<string>
  private cachedProjectRoot: string | undefined
  private snapshotCache = new Map<string, CachedCheckpointFile>()

  constructor(
    private readonly blobs: CheckpointBlobStore,
    options: ChangeTrackingOptions = {}
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.validateLimits(this.limits)
    this.excludedDirectoryNames = new Set(DEFAULT_EXCLUDED_DIRECTORIES)
    for (const directory of options.excludedDirectoryNames ?? []) {
      this.excludedDirectoryNames.add(directory)
    }
  }

  async snapshot(projectPath: string, options: SnapshotOptions = {}): Promise<ProjectCheckpoint> {
    const projectRoot = await this.resolveProjectRoot(projectPath)
    if (this.cachedProjectRoot !== projectRoot) {
      this.cachedProjectRoot = projectRoot
      this.snapshotCache.clear()
    }
    const git = options.includeGitMetadata ? await this.readGitMetadata(projectRoot) : undefined
    const gitPaths = git
      ? await this.readGitCheckpointPaths(projectRoot, git).catch(() => undefined)
      : undefined
    const files: Record<string, CheckpointFile> = {}
    const nextCache = new Map<string, CachedCheckpointFile>()
    let fileCount = 0
    let totalBytes = 0

    const captureFile = async (absolutePath: string): Promise<void> => {
      let metadata
      try {
        metadata = await lstat(absolutePath)
      } catch (error) {
        if (isMissing(error)) return
        throw error
      }
      if (!metadata.isFile()) return
      const resolvedFile = await realpath(absolutePath)
      this.assertWithinRoot(projectRoot, resolvedFile)
      const relativePath = this.relativePath(projectRoot, resolvedFile)
      const size = metadata.size

      if (size > this.limits.maxFileBytes) {
        throw new CheckpointLimitError(
          `Checkpoint file limit exceeded: ${relativePath} is ${size} bytes (maximum ${this.limits.maxFileBytes})`
        )
      }
      if (fileCount >= this.limits.maxFiles) {
        throw new CheckpointLimitError(
          `Checkpoint file limit exceeded: maximum ${this.limits.maxFiles} files`
        )
      }
      totalBytes += size
      if (totalBytes > this.limits.maxTotalBytes) {
        throw new CheckpointLimitError(
          `Checkpoint total size limit exceeded: ${totalBytes} bytes (maximum ${this.limits.maxTotalBytes})`
        )
      }

      const signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`
      const cached = this.snapshotCache.get(relativePath)
      if (cached?.signature === signature) {
        files[relativePath] = cached.file
        nextCache.set(relativePath, cached)
        fileCount += 1
        return
      }

      const content = await readFile(resolvedFile)
      const hash = createHash('sha256').update(content).digest('hex')
      await this.blobs.put(hash, content)
      const file = { path: relativePath, hash, size, binary: isBinary(content) }
      files[relativePath] = file
      nextCache.set(relativePath, { signature, file })
      fileCount += 1
    }

    for (const path of await this.listCandidateFiles(projectRoot, gitPaths)) {
      await captureFile(path)
    }
    this.snapshotCache = nextCache
    return {
      id: randomUUID(),
      projectRoot,
      createdAt: Date.now(),
      files,
      ...(git ? { git } : {})
    }
  }

  /**
   * Records path, size, and modification time for every tracked file without
   * reading or storing content. Used to bound an unbounded tool (a shell
   * command) to the files it touched while it was running.
   */
  async fingerprint(projectPath: string): Promise<ProjectFingerprint> {
    const projectRoot = await this.resolveProjectRoot(projectPath)
    const git = await this.readGitMetadata(projectRoot)
    const gitPaths = git
      ? await this.readGitCheckpointPaths(projectRoot, git).catch(() => undefined)
      : undefined
    const files: Record<string, string> = {}
    for (const absolutePath of await this.listCandidateFiles(projectRoot, gitPaths)) {
      let metadata
      try {
        metadata = await lstat(absolutePath)
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      if (!metadata.isFile()) continue
      const relativePath = relative(projectRoot, absolutePath)
      if (!relativePath || relativePath.startsWith(`..${sep}`)) continue
      files[relativePath] = `${metadata.mtimeMs}:${metadata.size}`
    }
    return { projectRoot, capturedAt: Date.now(), files }
  }

  /** Project-relative paths created, modified, or deleted between two fingerprints. */
  diffFingerprints(before: ProjectFingerprint, after: ProjectFingerprint): string[] {
    if (before.projectRoot !== after.projectRoot) {
      throw new CheckpointSafetyError('Cannot compare fingerprints from different project roots')
    }
    const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)])
    return [...paths].filter((path) => before.files[path] !== after.files[path]).sort()
  }

  private async listCandidateFiles(
    projectRoot: string,
    gitPaths: string[] | undefined
  ): Promise<string[]> {
    if (gitPaths) {
      return gitPaths.map((path) => this.resolveTrackedPath(projectRoot, path))
    }
    const paths: string[] = []
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!this.excludedDirectoryNames.has(entry.name)) {
            await visit(join(directory, entry.name))
          }
          continue
        }
        if (!entry.isFile()) continue
        paths.push(join(directory, entry.name))
      }
    }
    await visit(projectRoot)
    return paths
  }

  calculateChanges(before: ProjectCheckpoint, after: ProjectCheckpoint): CheckpointChange[] {
    if (before.projectRoot !== after.projectRoot) {
      throw new CheckpointSafetyError('Cannot compare checkpoints from different project roots')
    }
    const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)])
    return [...paths].sort().flatMap((path): CheckpointChange[] => {
      const beforeFile = before.files[path]
      const afterFile = after.files[path]
      if (!beforeFile && afterFile) return [{ path, kind: 'created', after: afterFile }]
      if (beforeFile && !afterFile) return [{ path, kind: 'deleted', before: beforeFile }]
      if (beforeFile && afterFile && beforeFile.hash !== afterFile.hash) {
        return [{ path, kind: 'modified', before: beforeFile, after: afterFile }]
      }
      return []
    })
  }

  async readBlob(hash: string): Promise<Uint8Array | null> {
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new CheckpointSafetyError('Invalid checkpoint blob hash')
    }
    return this.blobs.get(hash)
  }

  async restoreBefore(
    before: ProjectCheckpoint,
    after: ProjectCheckpoint,
    selectedPaths?: ReadonlySet<string>
  ): Promise<CheckpointChange[]> {
    const projectRoot = await this.resolveProjectRoot(before.projectRoot)
    if (projectRoot !== before.projectRoot || after.projectRoot !== before.projectRoot) {
      throw new CheckpointSafetyError(
        'Checkpoint project root does not match the current project root'
      )
    }
    const changes = this.calculateChanges(before, after).filter(
      (change) => !selectedPaths || selectedPaths.has(change.path)
    )
    for (const change of changes) {
      const target = this.resolveTrackedPath(projectRoot, change.path)
      if (change.kind === 'created') {
        await this.removeCreatedFile(target)
        continue
      }
      const source = change.before
      if (!source) throw new CheckpointSafetyError(`Missing before-state for ${change.path}`)
      const content = await this.blobs.get(source.hash)
      if (!content) throw new Error(`Checkpoint blob is unavailable: ${source.hash}`)
      await this.writeRestoredFile(projectRoot, target, content)
    }
    return changes
  }

  private async resolveProjectRoot(projectPath: string): Promise<string> {
    if (!projectPath.trim()) throw new CheckpointSafetyError('Project path is required')
    const absolutePath = resolve(projectPath)
    const metadata = await lstat(absolutePath)
    if (!metadata.isDirectory())
      throw new CheckpointSafetyError(`Project path is not a directory: ${absolutePath}`)
    return realpath(absolutePath)
  }

  private resolveTrackedPath(projectRoot: string, trackedPath: string): string {
    if (!trackedPath || isAbsolute(trackedPath) || trackedPath.split(/[\\/]/).includes('..')) {
      throw new CheckpointSafetyError(`Unsafe checkpoint path: ${trackedPath}`)
    }
    const target = resolve(projectRoot, trackedPath)
    this.assertWithinRoot(projectRoot, target)
    return target
  }

  private async removeCreatedFile(target: string): Promise<void> {
    try {
      const metadata = await lstat(target)
      if (metadata.isDirectory())
        throw new CheckpointSafetyError(`Refusing to remove directory: ${target}`)
      await unlink(target)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
  }

  private async writeRestoredFile(
    projectRoot: string,
    target: string,
    content: Uint8Array
  ): Promise<void> {
    const parent = dirname(target)
    await mkdir(parent, { recursive: true })
    const realParent = await realpath(parent)
    this.assertWithinRoot(projectRoot, realParent)
    try {
      const metadata = await lstat(target)
      if (metadata.isDirectory())
        throw new CheckpointSafetyError(`Refusing to overwrite directory: ${target}`)
      if (metadata.isSymbolicLink()) await unlink(target)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    await writeFile(target, content)
  }

  private relativePath(projectRoot: string, target: string): string {
    const relativePath = relative(projectRoot, target)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new CheckpointSafetyError(`Path escapes project root: ${target}`)
    }
    return relativePath
  }

  private assertWithinRoot(projectRoot: string, target: string): void {
    const relativePath = relative(projectRoot, target)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new CheckpointSafetyError(`Path escapes project root: ${target}`)
    }
  }

  private validateLimits(limits: CheckpointLimits): void {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new CheckpointLimitError('Checkpoint limits must be positive safe integers')
      }
    }
  }

  private readGitMetadata(projectRoot: string): Promise<GitCheckpointMetadata | undefined> {
    return runGit(['-C', projectRoot, 'rev-parse', '--show-toplevel'])
      .then(async (repositoryRoot) => {
        const [head, porcelainStatus] = await Promise.all([
          runGit(['-C', projectRoot, 'rev-parse', 'HEAD']).catch(() => ''),
          runGit(['-C', projectRoot, 'status', '--porcelain=v1']).catch(() => '')
        ])
        return { repositoryRoot: repositoryRoot.trim(), head: head.trim() || null, porcelainStatus }
      })
      .catch(() => undefined)
  }

  private async readGitCheckpointPaths(
    projectRoot: string,
    git: GitCheckpointMetadata
  ): Promise<string[]> {
    const repositoryRelativeRoot = relative(git.repositoryRoot, projectRoot).replaceAll(sep, '/')
    if (
      repositoryRelativeRoot === '..' ||
      repositoryRelativeRoot.startsWith('../') ||
      isAbsolute(repositoryRelativeRoot)
    ) {
      throw new CheckpointSafetyError('Git repository root does not contain the project root')
    }
    const scope = repositoryRelativeRoot || '.'
    const output = await runGit([
      '-C',
      git.repositoryRoot,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      scope
    ])
    const prefix = repositoryRelativeRoot ? `${repositoryRelativeRoot}/` : ''
    return output
      .split('\0')
      .filter(Boolean)
      .map((path) => {
        if (!prefix) return path
        if (!path.startsWith(prefix)) {
          throw new CheckpointSafetyError(`Git returned a path outside the project root: ${path}`)
        }
        return path.slice(prefix.length)
      })
      .filter(
        (path) => !path.split('/').some((segment) => this.excludedDirectoryNames.has(segment))
      )
  }
}

function isBinary(content: Uint8Array): boolean {
  const sampleSize = Math.min(content.length, 8_192)
  for (let index = 0; index < sampleSize; index += 1) {
    if (content[index] === 0) return true
  }
  return false
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile('git', args, { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        rejectCommand(new Error(stderr || error.message))
        return
      }
      resolveCommand(stdout)
    })
  })
}
