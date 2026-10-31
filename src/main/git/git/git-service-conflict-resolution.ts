import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, relative, resolve } from 'path'
import { toPosixPath } from '../../../lib/paths'
import { DEFAULT_MAX_CONFLICT_FILE_BYTES } from '../../../lib/types'
import type {
  GitConflictAnalysis,
  GitConflictSide,
  GitConflictWorkFile,
  GitStatus
} from '../../../lib/types'
import type { GitServiceCore } from './git-service-core'
import type { ConflictWorkMetadata } from './git-service-conflicts'
import {
  buildInitialConflictWorkFile,
  conflictSourceHash,
  hasConflictMarkers,
  parseConflictHunks,
  parseConflictWorkMetadata,
  parseConflictWorkState
} from './git-service-conflicts'

/**
 * Conflict resolution: one conflicted path at a time, or every side wholesale.
 *
 * A conflicted file is never staged on a guess. Each write here checks the
 * markers it is about to replace, so a half-resolved file stays unmerged and the
 * merge editor's scratch document is the only place partial progress lives
 * until the user commits to it.
 */
export class GitServiceConflictResolution {
  private readonly conflictFileLimit: () => Promise<number>

  constructor(
    private readonly core: GitServiceCore,
    conflictFileLimit: () => Promise<number>
  ) {
    this.conflictFileLimit = conflictFileLimit
  }

  /**
   * Complete resolution of a single conflicted path.
   *
   * A merge/rebase leaves the path in an unmerged index state until `git add`
   * is run on it. Editing the working file (the editor's Save) removes the
   * conflict markers on disk, but git still reports the path as conflicted. This
   * stages the path so git marks it resolved   but only when the working file no
   * longer contains conflict markers, so a partially-resolved file is never
   * staged. Returns fresh status so the renderer can clear the conflicted list.
   */
  async resolveConflicted(projectPath: string, path: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const safePath = this.core.assertRelativePath(directory, path)
      const status = await this.core.client(directory).status()
      if (!status.conflicted.includes(safePath)) return this.core.readStatus(directory)
      const file = await this.core.workingFileContent(
        directory,
        safePath,
        await this.conflictFileBytes()
      )
      if (!file || file.binary || file.truncated) return this.core.readStatus(directory)
      if (hasConflictMarkers(file.content)) return this.core.readStatus(directory)
      await this.core.wrapError(directory, 'mutation', async () => {
        await this.core.client(directory).add([safePath])
      })
      return this.core.readStatus(directory)
    })
  }

  /**
   * Take one side of every unresolved conflict wholesale and stage it.
   *
   * `incoming` keeps the theirs side (stage 3, the branch being integrated),
   * `current` keeps the ours side (stage 2, what HEAD had)   the same two sides
   * the per-hunk merge editor names. Each path is written and staged so git
   * clears its unmerged entry, and the merge editor's scratch document for that
   * path is removed because it now describes a file that no longer conflicts.
   *
   * Refused while no conflict is open, and the whole set is touched in one
   * queued task so a partial accept can never be observed.
   */
  async acceptConflictSide(projectPath: string, side: GitConflictSide): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const status = await this.core.client(directory).status()
      const safePaths = status.conflicted.map((path) =>
        this.core.assertRelativePath(directory, path)
      )
      if (safePaths.length === 0) return this.core.readStatus(directory)
      const scratch = await Promise.all(
        safePaths.map((path) => this.conflictWorkPaths(directory, path))
      )
      await this.core.wrapError(directory, 'mutation', async () => {
        const git = this.core.client(directory)
        await git.raw(['checkout', side === 'incoming' ? '--theirs' : '--ours', '--', ...safePaths])
        await git.add(safePaths)
        await Promise.all(
          scratch.flatMap(({ document, metadata }) => [
            rm(document, { force: true }),
            rm(metadata, { force: true })
          ])
        )
      })
      return this.core.readStatus(directory)
    })
  }

  /**
   * Parse a conflicted working file into its conflict hunks so the resolution
   * panel can offer ours/theirs side-by-side editing. Binary and oversized
   * files report their state without parsing (the user resolves those in the
   * editor instead).
   */
  async analyzeConflict(projectPath: string, relativePath: string): Promise<GitConflictAnalysis> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const safePath = this.core.assertRelativePath(directory, relativePath)
      return this.core.wrapError(projectPath, 'read', async () => {
        const working = await this.core.workingFileContent(
          directory,
          safePath,
          await this.conflictFileBytes()
        )
        if (!working)
          return { path: safePath, binary: false, truncated: true, content: '', hunks: [] }
        if (working.binary) {
          return { path: safePath, binary: true, truncated: false, content: '', hunks: [] }
        }
        const hunks = parseConflictHunks(working.content)
        return {
          path: safePath,
          binary: false,
          truncated: working.truncated,
          content: working.content,
          hunks
        }
      })
    })
  }

  /**
   * Open (or initialize) the marker-free scratch document used by the merge
   * editor. The original conflicted working-tree file is only read here. On the
   * each editor session, an explicitly saved draft is restored when it still
   * matches the original conflict. Otherwise, every marker block is replaced
   * with its current/HEAD side so the scratch file retains the original
   * extension and parses normally for syntax highlighting.
   */
  async prepareConflictWorkFile(
    projectPath: string,
    relativePath: string
  ): Promise<GitConflictWorkFile> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const safePath = this.core.assertRelativePath(directory, relativePath)
      return this.core.wrapError(directory, 'mutation', async () => {
        const working = await this.core.workingFileContent(
          directory,
          safePath,
          await this.conflictFileBytes()
        )
        const analysis: GitConflictAnalysis = !working
          ? { path: safePath, binary: false, truncated: true, content: '', hunks: [] }
          : working.binary
            ? { path: safePath, binary: true, truncated: false, content: '', hunks: [] }
            : {
                path: safePath,
                binary: false,
                truncated: working.truncated,
                content: working.content,
                hunks: parseConflictHunks(working.content)
              }
        const paths = await this.conflictWorkPaths(directory, safePath)
        const sourceHash = conflictSourceHash(analysis.content)
        try {
          const [content, metadataText] = await Promise.all([
            readFile(paths.document, 'utf-8'),
            readFile(paths.metadata, 'utf-8')
          ])
          const metadata = parseConflictWorkMetadata(
            metadataText,
            sourceHash,
            analysis.hunks.length,
            content.length
          )
          if (metadata?.draftSaved) {
            return {
              analysis,
              scratchPath: toPosixPath(relative(directory, paths.document)),
              content,
              hunks: metadata.hunks
            }
          }
        } catch {
          // Missing or invalid scratch state is initialized below.
        }
        const initial = buildInitialConflictWorkFile(analysis)
        await this.writeConflictScratch(paths, initial.content, {
          version: 1,
          sourceHash,
          draftSaved: false,
          hunks: initial.hunks
        })
        return {
          analysis,
          scratchPath: toPosixPath(relative(directory, paths.document)),
          content: initial.content,
          hunks: initial.hunks
        }
      })
    })
  }

  /** Persist partial conflict progress without changing or staging the original file. */
  async saveConflictDraft(
    projectPath: string,
    relativePath: string,
    content: string,
    stateJson: string
  ): Promise<void> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const safePath = this.core.assertRelativePath(directory, relativePath)
      await this.core.wrapError(directory, 'mutation', async () => {
        const working = await this.core.workingFileContent(
          directory,
          safePath,
          await this.conflictFileBytes()
        )
        const source = working?.binary ? '' : (working?.content ?? '')
        const hunks = parseConflictWorkState(stateJson, content.length)
        const paths = await this.conflictWorkPaths(directory, safePath)
        await this.writeConflictScratch(paths, content, {
          version: 1,
          sourceHash: conflictSourceHash(source),
          draftSaved: true,
          hunks
        })
      })
    })
  }

  /**
   * Persist a fully-resolved conflict file: replace the working copy with the
   * user's merged content and stage it so git clears the unmerged entry. The
   * content must contain no remaining conflict markers, otherwise resolution is
   * incomplete and the write is refused (a partially-resolved file is never
   * staged).
   */
  async saveConflictResolution(
    projectPath: string,
    relativePath: string,
    content: string
  ): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const safePath = this.core.assertRelativePath(directory, relativePath)
      const status = await this.core.client(directory).status()
      if (!status.conflicted.includes(safePath)) return this.core.readStatus(directory)
      await this.core.wrapError(directory, 'mutation', async () => {
        if (hasConflictMarkers(content)) {
          throw new Error(
            'This file still has unresolved conflict markers   resolve every conflict first.'
          )
        }
        const target = resolve(directory, safePath)
        // Atomic write: same directory + rename, so the working file can never be
        // observed half-written.
        const temp = `${target}.resolve-tmp`
        await writeFile(temp, content, 'utf-8')
        await rename(temp, target)
        await this.core.client(directory).add([safePath])
        const scratch = await this.conflictWorkPaths(directory, safePath)
        await Promise.all([
          rm(scratch.document, { force: true }),
          rm(scratch.metadata, { force: true })
        ])
      })
      return this.core.readStatus(directory)
    })
  }

  private async conflictWorkPaths(
    directory: string,
    safePath: string
  ): Promise<{ document: string; metadata: string }> {
    let branch = 'HEAD'
    try {
      branch =
        (await this.core.client(directory).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() ||
        'HEAD'
    } catch {
      // Detached or unborn HEAD   fall back to a generic folder.
    }
    const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
    const document = resolve(
      directory,
      '.cio',
      'git',
      'merge-conflict',
      safeBranch || 'HEAD',
      ...safePath.split('/')
    )
    return { document, metadata: `${document}.merge.json` }
  }

  private async writeConflictScratch(
    paths: { document: string; metadata: string },
    content: string,
    metadata: ConflictWorkMetadata
  ): Promise<void> {
    await mkdir(dirname(paths.document), { recursive: true })
    const documentTemp = `${paths.document}.resolve-tmp`
    const metadataTemp = `${paths.metadata}.resolve-tmp`
    await Promise.all([
      writeFile(documentTemp, content, 'utf-8'),
      writeFile(metadataTemp, JSON.stringify(metadata), 'utf-8')
    ])
    await Promise.all([rename(documentTemp, paths.document), rename(metadataTemp, paths.metadata)])
  }

  /**
   * The configured byte cap on a conflicted file, resolved per call so a
   * settings change applies without a restart. A missing or nonsensical
   * provider value falls back to the shipped default rather than refusing every
   * conflict the app can still handle.
   */
  private async conflictFileBytes(): Promise<number> {
    const limit = await this.conflictFileLimit().catch(() => DEFAULT_MAX_CONFLICT_FILE_BYTES)
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_MAX_CONFLICT_FILE_BYTES
  }
}
