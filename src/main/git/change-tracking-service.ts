import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { APP_SLUG } from '../../lib/brand'
import { PROJECT_DATA_DIRECTORY } from '../../lib/project-artifacts'
import { toPosixPath } from '../../lib/paths'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import {
  CHECKPOINT_ROOT_MISMATCH,
  diffCheckpointFiles
} from '../storage/checkpoint/checkpoint-summary'

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
  /** Changes whenever external maintenance may invalidate cached blob references. */
  revision?(): Promise<string>
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
  /** Paths skipped because they exceeded the per-file size limit. They are
   *  absent from `files` (their content is never read or stored), so rollback
   *  cannot restore them; recording them keeps the limitation visible instead
   *  of failing the whole snapshot. */
  skippedFiles?: string[]
  /** Paths whose metadata/hash was captured but whose content blob could not be persisted. */
  unavailableFiles?: string[]
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

/** What one candidate path turned out to be, before the limits are applied. */
type ObservedFile =
  | { kind: 'absent' }
  | { kind: 'oversize'; relativePath: string }
  | {
      kind: 'captured'
      relativePath: string
      size: number
      signature: string
      file: CheckpointFile
      /** False when the content could not be stored; the hash is still recorded. */
      stored: boolean
    }

/**
 * Files one snapshot examines at a time.
 *
 * The walk used to `await` a single file at a time, so a 3 000-file repository
 * paid 3 000 sequential `lstat`/`realpath`/`readFile` round trips through the
 * main process's four-thread libuv pool and held the turn's prompt for
 * seconds before the model was even asked. Bounded waves keep the pool busy
 * without pointing an unbounded number of descriptors at the disk.
 */
const SNAPSHOT_CONCURRENCY = 32

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
  private cachedBlobRevision: string | undefined
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
    const blobRevision = await this.blobs.revision?.()
    if (
      blobRevision !== undefined &&
      this.cachedBlobRevision !== undefined &&
      blobRevision !== this.cachedBlobRevision
    ) {
      this.snapshotCache.clear()
    }
    this.cachedBlobRevision = blobRevision
    const git = options.includeGitMetadata ? await this.readGitMetadata(projectRoot) : undefined
    const gitPaths = git
      ? await this.readGitCheckpointPaths(projectRoot, git).catch(() => undefined)
      : undefined
    const files: Record<string, CheckpointFile> = {}
    const skippedFiles: string[] = []
    const unavailableFiles: string[] = []
    const nextCache = new Map<string, CachedCheckpointFile>()
    const resolvedDirectories = new Map<string, string>()
    let fileCount = 0
    let totalBytes = 0

    const observed = await mapBounded(
      await this.listCandidateFiles(projectRoot, gitPaths),
      SNAPSHOT_CONCURRENCY,
      (absolutePath) => this.observeFile(projectRoot, absolutePath, resolvedDirectories)
    )

    // The limits are applied in candidate order, after the reads, so which file
    // trips a limit and how the skipped list is ordered never depends on the
    // order the disk answered in.
    for (const entry of observed) {
      if (entry.kind === 'absent') continue
      if (entry.kind === 'oversize') {
        // A single oversized file must never disable rollback for the whole
        // project: skip its content (never read/hash/store it) and keep
        // snapshotting everything else. The skipped path is recorded so the
        // limitation stays visible instead of failing the entire snapshot.
        skippedFiles.push(entry.relativePath)
        continue
      }
      if (fileCount >= this.limits.maxFiles) {
        throw new CheckpointLimitError(
          `Checkpoint file limit exceeded: maximum ${this.limits.maxFiles} files`
        )
      }
      totalBytes += entry.size
      if (totalBytes > this.limits.maxTotalBytes) {
        throw new CheckpointLimitError(
          `Checkpoint total size limit exceeded: ${totalBytes} bytes (maximum ${this.limits.maxTotalBytes})`
        )
      }
      // Path attribution must survive a full/unavailable checkpoint store. The
      // hash still identifies the observed state, while completion records a
      // visible warning that diff/rollback content is incomplete.
      if (!entry.stored) unavailableFiles.push(entry.relativePath)
      files[entry.relativePath] = entry.file
      nextCache.set(entry.relativePath, { signature: entry.signature, file: entry.file })
      fileCount += 1
    }
    this.snapshotCache = nextCache
    return {
      id: randomUUID(),
      projectRoot,
      createdAt: Date.now(),
      files,
      ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
      ...(unavailableFiles.length > 0 ? { unavailableFiles } : {}),
      ...(git ? { git } : {})
    }
  }

  /**
   * Read one candidate path, reusing the cached hash when its stat signature is
   * unchanged so a warm snapshot never touches the file's content again.
   *
   * The containment check resolves the containing directory, not the file: a
   * final symlink is already refused by the non-following stat above, so the one
   * way a candidate can point outside the project is a symlinked parent   and
   * that is per directory, not per file. Memoizing it per snapshot keeps the
   * safety check without paying a `realpath` for every file in the repository.
   */
  private async observeFile(
    projectRoot: string,
    absolutePath: string,
    resolvedDirectories: Map<string, string>
  ): Promise<ObservedFile> {
    let metadata
    try {
      metadata = await lstat(absolutePath)
    } catch (error) {
      if (isMissing(error)) return { kind: 'absent' }
      throw error
    }
    if (!metadata.isFile()) return { kind: 'absent' }
    const parent = dirname(absolutePath)
    let resolvedParent = resolvedDirectories.get(parent)
    if (resolvedParent === undefined) {
      resolvedParent = await realpath(parent)
      this.assertWithinRoot(projectRoot, resolvedParent)
      resolvedDirectories.set(parent, resolvedParent)
    }
    const relativePath = this.relativePath(
      projectRoot,
      join(resolvedParent, basename(absolutePath))
    )
    const size = metadata.size
    if (size > this.limits.maxFileBytes) return { kind: 'oversize', relativePath }

    const signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`
    const cached = this.snapshotCache.get(relativePath)
    if (cached?.signature === signature) {
      return { kind: 'captured', relativePath, size, signature, file: cached.file, stored: true }
    }

    const content = await readFile(absolutePath)
    const hash = createHash('sha256').update(content).digest('hex')
    let stored = true
    try {
      await this.blobs.put(hash, content)
    } catch {
      stored = false
    }
    return {
      kind: 'captured',
      relativePath,
      size,
      signature,
      file: { path: relativePath, hash, size, binary: isBinary(content) },
      stored
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
      files[relativePath] =
        `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`
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
    try {
      return diffCheckpointFiles(before, after)
    } catch (error) {
      // The diff is shared with the database worker, which cannot depend on this
      // module's error types, so the safety error is re-raised here.
      if (error instanceof Error && error.message === CHECKPOINT_ROOT_MISMATCH) {
        throw new CheckpointSafetyError(error.message)
      }
      throw error
    }
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

  /** Re-applies the captured `after`-state (inverse of `restoreBefore`) for
   *  the selected paths, so an undone turn can be redone from its snapshot. */
  async restoreAfter(
    before: ProjectCheckpoint,
    after: ProjectCheckpoint,
    selectedPaths?: ReadonlySet<string>
  ): Promise<CheckpointChange[]> {
    const projectRoot = await this.resolveProjectRoot(after.projectRoot)
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
      if (change.kind === 'deleted') {
        await this.removeCreatedFile(target)
        continue
      }
      const source = change.after
      if (!source) throw new CheckpointSafetyError(`Missing after-state for ${change.path}`)
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
    const repositoryRelativeRoot = toPosixPath(relative(git.repositoryRoot, projectRoot))
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

/** Heuristic binary detection: a NUL byte in the first 8 KB marks binary content. */
export function isBinary(content: Uint8Array): boolean {
  const sampleSize = Math.min(content.length, 8_192)
  for (let index = 0; index < sampleSize; index += 1) {
    if (content[index] === 0) return true
  }
  return false
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Run one async operation per item with bounded concurrency, keeping the
 *  results in input order so callers stay deterministic. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      const item = items[index]
      if (item === undefined) return
      results[index] = await run(item)
    }
  })
  await Promise.all(workers)
  return results
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      'git',
      args,
      { encoding: 'utf8', windowsHide: true, env: buildProcessEnvironment() },
      (error, stdout, stderr) => {
        if (error) {
          rejectCommand(new Error(stderr || error.message))
          return
        }
        resolveCommand(stdout)
      }
    )
  })
}
