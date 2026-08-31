import { spawn } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { Logger } from '../system/logger'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import type { ProjectFileEntry } from '../../lib/types'

const MAX_SEARCH_RESULTS = 60
const MAX_INDEX_ENTRIES = 500_000
const MAX_GIT_INDEX_BYTES = 128 * 1024 * 1024
const MAX_RELATIVE_PATH_LENGTH = 4_096
/** How long a built index is trusted before it is rebuilt from disk. The index
 *  is normally kept fresh incrementally by the filesystem watcher; this is the
 *  fallback for projects that cannot be watched (e.g. unwatchable roots). */
const INDEX_MAX_AGE_MS = 60_000
const MAX_CACHED_INDEXES = 8
/** Events for the same project are coalesced for this long before the index is
 *  touched, so a burst of agent file writes costs one batched update. */
const WATCHER_BATCH_MS = 300
const INDEX_EXCLUDED_DIRECTORY_NAMES = [
  '.git',
  '.cache',
  '.gradle',
  '.next',
  '.nuxt',
  '.parcel-cache',
  '.svelte-kit',
  '.turbo',
  '.venv',
  '.vite',
  '__pycache__',
  'bower_components',
  'build',
  'coverage',
  'DerivedData',
  'dist',
  'node_modules',
  'out',
  'Pods',
  'target',
  'venv',
  'vendor'
] as const
const INDEX_EXCLUDED_DIRECTORIES = new Set<string>(INDEX_EXCLUDED_DIRECTORY_NAMES)
const GIT_EXCLUDED_DIRECTORY_PATHS = INDEX_EXCLUDED_DIRECTORY_NAMES.flatMap((directory) => [
  `:(exclude,glob)${directory}/**`,
  `:(exclude,glob)**/${directory}/**`
])

interface IndexedProjectEntry {
  entry: ProjectFileEntry
  normalizedPath: string
  normalizedName: string
  ruleScore: number
}

interface ProjectFileIndex {
  root: string
  /** Path -> entry. A Map (not an array) so incremental watcher updates can
   *  add and remove entries without rebuilding the whole project index. */
  entries: Map<string, IndexedProjectEntry>
  builtAt: number
}

interface RankedProjectEntry extends ProjectFileEntry {
  score: number
}

interface ProjectWatcher {
  watcher: FSWatcher
  root: string
  /** Whether the watcher has been closed. Node's FSWatcher exposes no public
   *  `closed` flag, so the service tracks it to avoid re-watching a dead root. */
  closed: boolean
}

/** Translate a watcher event path into a clean project-relative path, or null
 *  when it escapes the root or is malformed. */
function toProjectRelativePath(root: string, absolutePath: string): string | null {
  const relativePath = relative(root, absolutePath)
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null
  }
  const posixPath = relativePath.split(sep).join('/')
  if (
    posixPath.includes('\\') ||
    posixPath.length === 0 ||
    posixPath.length > MAX_RELATIVE_PATH_LENGTH
  ) {
    return null
  }
  const segments = posixPath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return posixPath
}

export class ProjectFileIndexService {
  private readonly indexes = new Map<string, ProjectFileIndex>()
  private readonly indexBuilds = new Map<string, Promise<ProjectFileIndex>>()
  private readonly indexVersions = new Map<string, number>()
  private readonly watchers = new Map<string, ProjectWatcher>()
  private readonly pendingEventPaths = new Map<string, Set<string>>()
  private readonly eventTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly flushChains = new Map<string, Promise<void>>()

  async search(
    projectId: string,
    root: string,
    query: string,
    category: 'all' | 'rules',
    projectName?: string
  ): Promise<ProjectFileEntry[]> {
    const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    // A query term may match the project name too (e.g. "app.html codeinoven"),
    // so results surface across a project whose display name the user typed.
    const projectHaystack = projectName ? `${projectName.toLocaleLowerCase()} ` : ''
    const index = await this.indexForProject(projectId, root)
    const matches: RankedProjectEntry[] = []

    for (const indexed of index.entries.values()) {
      if (category === 'rules' && indexed.ruleScore === 0) continue
      if (!words.every((word) => `${projectHaystack}${indexed.normalizedPath}`.includes(word))) {
        continue
      }

      const queryScore = words.reduce(
        (score, word) =>
          score +
          (indexed.normalizedName === word
            ? 12
            : indexed.normalizedName.startsWith(word)
              ? 8
              : indexed.normalizedName.includes(word)
                ? 4
                : 1),
        0
      )
      this.insertRankedResult(matches, {
        ...indexed.entry,
        score:
          indexed.ruleScore +
          queryScore +
          (indexed.entry.kind === 'directory' && words.length > 0 ? 2 : 0)
      })
    }

    return matches.map(({ name, path, kind }) => ({ name, path, kind }))
  }

  /** Build the index for a project in the background and keep it fresh by
   *  watching the root. Fire-and-forget from callers; failures are swallowed
   *  here so an unwatchable project never breaks the app — `search` rebuilds
   *  on demand and surfaces real errors there. */
  async prewarm(projectId: string, root: string): Promise<void> {
    this.ensureWatcher(projectId, root)
    try {
      await this.indexForProject(projectId, root)
    } catch {
      // Background warm-up must never crash; search will surface failures.
    }
  }

  /** Drop the cached index after an in-app mutation. The watcher stays alive:
   *  it keeps a rebuilt index fresh, and `ensureWatcher` re-points it when the
   *  project's root path changes. */
  invalidate(projectId: string): void {
    this.indexes.delete(projectId)
    this.indexBuilds.delete(projectId)
    this.indexVersions.set(projectId, (this.indexVersions.get(projectId) ?? 0) + 1)
  }

  /** Live index keys so callers can sweep scoped variants during teardown. */
  indexKeys(): Iterable<string> {
    return this.indexes.keys()
  }

  /** Tear down everything for a removed project: watcher, pending batches, and
   *  the cached index. */
  dispose(projectId: string): void {
    const existing = this.watchers.get(projectId)
    if (existing) {
      existing.watcher.close()
      existing.closed = true
      this.watchers.delete(projectId)
    }
    const timer = this.eventTimers.get(projectId)
    if (timer) clearTimeout(timer)
    this.eventTimers.delete(projectId)
    this.pendingEventPaths.delete(projectId)
    this.indexes.delete(projectId)
    this.indexBuilds.delete(projectId)
    this.indexVersions.delete(projectId)
  }

  private async indexForProject(projectId: string, root: string): Promise<ProjectFileIndex> {
    this.ensureWatcher(projectId, root)
    const cached = this.indexes.get(projectId)
    if (cached?.root === root && Date.now() - cached.builtAt <= INDEX_MAX_AGE_MS) {
      this.indexes.delete(projectId)
      this.indexes.set(projectId, cached)
      return cached
    }

    const existingBuild = this.indexBuilds.get(projectId)
    if (existingBuild) return existingBuild

    const version = this.indexVersions.get(projectId) ?? 0
    const build = this.buildProjectIndex(root).then((index) => {
      if ((this.indexVersions.get(projectId) ?? 0) === version) {
        this.indexes.delete(projectId)
        this.indexes.set(projectId, index)
        while (this.indexes.size > MAX_CACHED_INDEXES) {
          const oldestProjectId = this.indexes.keys().next().value
          if (typeof oldestProjectId !== 'string') break
          this.indexes.delete(oldestProjectId)
          // Stop watching evicted projects; their watcher is re-established on
          // the next search/prewarm that uses the index again.
          const evictedWatcher = this.watchers.get(oldestProjectId)
          if (evictedWatcher) {
            evictedWatcher.watcher.close()
            evictedWatcher.closed = true
            this.watchers.delete(oldestProjectId)
          }
        }
      }
      return index
    })
    this.indexBuilds.set(projectId, build)
    try {
      return await build
    } finally {
      if (this.indexBuilds.get(projectId) === build) {
        this.indexBuilds.delete(projectId)
      }
    }
  }

  private async buildProjectIndex(root: string): Promise<ProjectFileIndex> {
    const gitPaths = await this.readGitProjectPaths(root)
    const entries =
      gitPaths === null ? await this.walkProjectEntries(root) : this.entriesFromGitPaths(gitPaths)

    const entriesByPath = new Map<string, IndexedProjectEntry>()
    for (const entry of entries) {
      const normalizedPath = entry.path.toLocaleLowerCase()
      entriesByPath.set(entry.path, {
        entry,
        normalizedPath,
        normalizedName: entry.name.toLocaleLowerCase(),
        ruleScore: entry.kind === 'file' ? this.rulePathScore(normalizedPath) : 0
      })
    }
    return {
      root,
      entries: entriesByPath,
      builtAt: Date.now()
    }
  }

  /**
   * Ask Git for tracked and untracked files, including useful ignored files.
   * Explicit pathspecs prune dependency, cache, and build directories without
   * allowing a broad .gitignore rule to hide files that users may want to tag.
   * NUL parsing preserves newlines.
   */
  private readGitProjectPaths(root: string): Promise<string[] | null> {
    return new Promise((resolvePaths, rejectPaths) => {
      const child = spawn(
        'git',
        [
          '-C',
          root,
          'ls-files',
          '--cached',
          '--others',
          '-z',
          '--',
          '.',
          ...GIT_EXCLUDED_DIRECTORY_PATHS
        ],
        {
          windowsHide: true,
          env: buildProcessEnvironment(),
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      const decoder = new StringDecoder('utf8')
      const paths: string[] = []
      let pending = ''
      let stderr = ''
      let receivedBytes = 0
      let overflowed = false
      let settled = false

      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        rejectPaths(error)
      }

      child.stdout.on('data', (chunk: Buffer) => {
        if (overflowed) return
        receivedBytes += chunk.byteLength
        if (receivedBytes > MAX_GIT_INDEX_BYTES) {
          overflowed = true
          child.kill()
          return
        }

        pending += decoder.write(chunk)
        const values = pending.split('\0')
        pending = values.pop() ?? ''
        for (const value of values) {
          if (!value) continue
          paths.push(value)
          if (paths.length > MAX_INDEX_ENTRIES) {
            overflowed = true
            child.kill()
            return
          }
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        if (error.message.includes('ENOENT')) {
          if (!settled) {
            settled = true
            resolvePaths(null)
          }
          return
        }
        fail(error)
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        if (overflowed) {
          rejectPaths(
            new Error(
              `Project index exceeds the ${MAX_INDEX_ENTRIES.toLocaleString()}-entry or 128 MiB safety limit`
            )
          )
          return
        }
        pending += decoder.end()
        if (pending) paths.push(pending)
        if (code === 0) {
          resolvePaths(paths)
          return
        }
        if (stderr.toLocaleLowerCase().includes('not a git repository')) {
          resolvePaths(null)
          return
        }
        rejectPaths(
          new Error(`Git could not index this project: ${stderr.trim() || `exit ${code}`}`)
        )
      })
    })
  }

  private entriesFromGitPaths(paths: string[]): ProjectFileEntry[] {
    const entries = new Map<string, ProjectFileEntry>()
    for (const rawPath of paths) {
      const path = rawPath.replace(/^\.\//u, '')
      if (!path || path.length > 4_096 || path.includes('\\')) continue
      const segments = path.split('/')
      if (segments.some((segment) => !segment || segment === '.' || segment === '..')) continue

      let directoryPath = ''
      for (const segment of segments.slice(0, -1)) {
        directoryPath = directoryPath ? `${directoryPath}/${segment}` : segment
        entries.set(directoryPath, {
          name: segment,
          path: directoryPath,
          kind: 'directory'
        })
      }
      entries.set(path, {
        name: segments.at(-1) ?? path,
        path,
        kind: 'file'
      })
      if (entries.size > MAX_INDEX_ENTRIES) {
        throw new Error(
          `Project index exceeds the ${MAX_INDEX_ENTRIES.toLocaleString()}-entry safety limit`
        )
      }
    }
    return [...entries.values()]
  }

  private async walkProjectEntries(root: string): Promise<ProjectFileEntry[]> {
    const entries: ProjectFileEntry[] = []
    const pending: Array<{ absolutePath: string; relativePath: string }> = [
      { absolutePath: root, relativePath: '' }
    ]
    let pendingIndex = 0

    while (pendingIndex < pending.length) {
      const directory = pending[pendingIndex]
      pendingIndex += 1
      if (!directory) break
      const children = await readdir(directory.absolutePath, { withFileTypes: true })
      for (const child of children) {
        if (child.isSymbolicLink()) continue
        if (child.isDirectory() && INDEX_EXCLUDED_DIRECTORIES.has(child.name)) continue
        if (!child.isDirectory() && !child.isFile()) continue
        const path = directory.relativePath ? `${directory.relativePath}/${child.name}` : child.name
        entries.push({
          name: child.name,
          path,
          kind: child.isDirectory() ? 'directory' : 'file'
        })
        if (entries.length > MAX_INDEX_ENTRIES) {
          throw new Error(
            `Project index exceeds the ${MAX_INDEX_ENTRIES.toLocaleString()}-entry safety limit`
          )
        }
        if (child.isDirectory()) {
          pending.push({
            absolutePath: join(directory.absolutePath, child.name),
            relativePath: path
          })
        }
      }
    }
    return entries
  }

  /** Start watching a project root, re-pointing the watcher when the root
   *  changed. Failure to watch is never fatal: the index still works and is
   *  refreshed by its age limit.
   *
   *  Uses the platform's native recursive watcher (FSEvents on macOS,
   *  ReadDirectoryChangesW on Windows, inotify on Linux) instead of a
   *  per-path watcher library: chokidar 5 opens one `fs.watch` handle per
   *  path, which exhausted the process file-descriptor table on large
   *  projects (ENFILE) and made every later `spawn` fail with EBADF. */
  private ensureWatcher(projectId: string, root: string): void {
    const existing = this.watchers.get(projectId)
    if (existing && existing.root === root && !existing.closed) return
    if (existing) {
      existing.watcher.close()
      existing.closed = true
      this.watchers.delete(projectId)
    }
    try {
      // Node's recursive fs.watch is kernel-backed (FSEvents/inotify) and uses
      // one file descriptor per watched root regardless of tree size.
      const watcher = watch(root, { recursive: true, persistent: true })
      watcher.on('change', (event, eventPath) => {
        // Content writes to indexed files are no-ops: the index only stores
        // names and paths, so only structural events need handling. The native
        // watcher reports relative paths; resolve them against the root.
        if (event === 'change') return
        const path = typeof eventPath === 'string' ? eventPath : eventPath?.toString()
        const absolutePath = path ? join(root, path) : root
        if (this.isIgnoredWatchPath(root, absolutePath)) return
        this.queueEvent(projectId, absolutePath)
      })
      watcher.on('error', (error) => {
        Logger.info('Project file watcher error', {
          projectId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
      watcher.on('close', () => {
        const tracked = this.watchers.get(projectId)
        if (tracked && tracked.watcher === watcher) tracked.closed = true
      })
      this.watchers.set(projectId, { watcher, root, closed: false })
    } catch (error) {
      Logger.info('Project file watcher could not be started', {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Ignore any path nested inside an excluded directory (dependencies, build
   *  output, VCS internals) without ever ignoring the watched root itself. */
  private isIgnoredWatchPath(root: string, candidate: string): boolean {
    const relativePath = relative(root, candidate)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      return false
    }
    return relativePath.split(/[\\/]/u).some((segment) => INDEX_EXCLUDED_DIRECTORIES.has(segment))
  }

  private queueEvent(projectId: string, absolutePath: string): void {
    let paths = this.pendingEventPaths.get(projectId)
    if (!paths) {
      paths = new Set<string>()
      this.pendingEventPaths.set(projectId, paths)
    }
    paths.add(absolutePath)
    const existing = this.eventTimers.get(projectId)
    if (existing) clearTimeout(existing)
    this.eventTimers.set(
      projectId,
      setTimeout(() => {
        this.eventTimers.delete(projectId)
        const batch = this.pendingEventPaths.get(projectId)
        this.pendingEventPaths.delete(projectId)
        if (!batch || batch.size === 0) return
        const pathsSnapshot = [...batch]
        const previous = this.flushChains.get(projectId) ?? Promise.resolve()
        const flush = previous
          .catch(() => undefined)
          .then(() => this.flushProjectEvents(projectId, pathsSnapshot))
        this.flushChains.set(projectId, flush)
      }, WATCHER_BATCH_MS)
    )
  }

  /** Apply a batch of external filesystem changes to the live index. When no
   *  index is live (evicted or being rebuilt), the version is bumped so the
   *  in-flight build is discarded and the next build re-reads the disk,
   *  capturing the changes that raced the build. */
  private async flushProjectEvents(projectId: string, absolutePaths: string[]): Promise<void> {
    const index = this.indexes.get(projectId)
    if (!index) {
      this.indexVersions.set(projectId, (this.indexVersions.get(projectId) ?? 0) + 1)
      return
    }
    for (const absolutePath of absolutePaths) {
      const path = toProjectRelativePath(index.root, absolutePath)
      if (!path) continue
      let kind: ProjectFileEntry['kind'] | null = null
      try {
        const metadata = await lstat(absolutePath)
        if (metadata.isDirectory()) kind = 'directory'
        else if (metadata.isFile()) kind = 'file'
      } catch {
        kind = null
      }
      if (kind) {
        this.addPathToIndex(index, path, kind)
      } else {
        this.removePathFromIndex(index, path)
      }
    }
  }

  /** Insert a path into the live index (with its ancestor directories when
   *  they are missing). Entries whose kind changed on disk are replaced. */
  private addPathToIndex(
    index: ProjectFileIndex,
    path: string,
    kind: ProjectFileEntry['kind']
  ): void {
    const existing = index.entries.get(path)
    if (existing && existing.entry.kind === kind) return
    if (index.entries.size >= MAX_INDEX_ENTRIES) return
    const name = basename(path)
    const normalizedPath = path.toLocaleLowerCase()
    index.entries.set(path, {
      entry: { name, path, kind },
      normalizedPath,
      normalizedName: name.toLocaleLowerCase(),
      ruleScore: kind === 'file' ? this.rulePathScore(normalizedPath) : 0
    })
    const segments = path.split('/')
    let directory = ''
    for (const segment of segments.slice(0, -1)) {
      directory = directory ? `${directory}/${segment}` : segment
      if (index.entries.has(directory)) continue
      if (index.entries.size >= MAX_INDEX_ENTRIES) return
      const directoryPath = directory.toLocaleLowerCase()
      index.entries.set(directory, {
        entry: { name: segment, path: directory, kind: 'directory' },
        normalizedPath: directoryPath,
        normalizedName: segment.toLocaleLowerCase(),
        ruleScore: 0
      })
    }
  }

  /** Remove a path from the live index together with everything below it. */
  private removePathFromIndex(index: ProjectFileIndex, path: string): void {
    const toDelete: string[] = []
    for (const key of index.entries.keys()) {
      if (key === path || key.startsWith(`${path}/`)) toDelete.push(key)
    }
    for (const key of toDelete) index.entries.delete(key)
  }

  private insertRankedResult(results: RankedProjectEntry[], candidate: RankedProjectEntry): void {
    let low = 0
    let high = results.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const current = results[middle]
      if (!current || this.compareRanked(candidate, current) < 0) {
        high = middle
      } else {
        low = middle + 1
      }
    }
    if (low >= MAX_SEARCH_RESULTS) return
    results.splice(low, 0, candidate)
    if (results.length > MAX_SEARCH_RESULTS) results.pop()
  }

  private compareRanked(left: RankedProjectEntry, right: RankedProjectEntry): number {
    return right.score - left.score || left.path.localeCompare(right.path)
  }

  private rulePathScore(path: string): number {
    const name = basename(path)
    if (name === 'agents.md' || name === 'claude.md' || name === 'skill.md') return 40
    if (name === 'copilot-instructions.md') return 36
    if (path.includes('/skills/') || path.startsWith('skills/')) return 28
    if (path.includes('/rules/') || path.startsWith('rules/')) return 24
    if (name.endsWith('.mdc') || name.includes('instructions') || name.includes('rules')) return 16
    return 0
  }
}
