import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { basename, join } from 'node:path'
import type { ProjectFileEntry } from '../../lib/types'

const MAX_SEARCH_RESULTS = 60
const MAX_INDEX_ENTRIES = 500_000
const MAX_GIT_INDEX_BYTES = 128 * 1024 * 1024
const INDEX_MAX_AGE_MS = 5_000
const MAX_CACHED_INDEXES = 8
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
  entries: IndexedProjectEntry[]
  builtAt: number
}

interface RankedProjectEntry extends ProjectFileEntry {
  score: number
}

export class ProjectFileIndexService {
  private readonly indexes = new Map<string, ProjectFileIndex>()
  private readonly indexBuilds = new Map<string, Promise<ProjectFileIndex>>()
  private readonly indexVersions = new Map<string, number>()

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

    for (const indexed of index.entries) {
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

  invalidate(projectId: string): void {
    this.indexes.delete(projectId)
    this.indexBuilds.delete(projectId)
    this.indexVersions.set(projectId, (this.indexVersions.get(projectId) ?? 0) + 1)
  }

  private async indexForProject(projectId: string, root: string): Promise<ProjectFileIndex> {
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

    return {
      root,
      entries: entries.map((entry) => {
        const normalizedPath = entry.path.toLocaleLowerCase()
        return {
          entry,
          normalizedPath,
          normalizedName: entry.name.toLocaleLowerCase(),
          ruleScore: entry.kind === 'file' ? this.rulePathScore(normalizedPath) : 0
        }
      }),
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
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
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
