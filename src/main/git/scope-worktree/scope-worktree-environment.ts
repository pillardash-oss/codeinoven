import { copyFile, mkdir, readdir, realpath, rename, rm } from 'fs/promises'
import { existsSync, realpathSync } from 'fs'
import { isAbsolute, join } from 'path'
import { randomBytes } from 'crypto'
import type { ScopeEnvironmentMode, ScopeWorktreeProgress } from '../../../lib/types'
import type { ProjectManager } from '../../../lib/engines/project-manager'
import { runGit } from '../scope-worktree-process'

export function ensureParentDir(path: string): Promise<void> {
  return mkdir(join(path, '..'), { recursive: true }).then(() => undefined)
}

/** Normalize a renderer-supplied worktree path for registration comparison. */
export function normalizeAdoptSourcePath(sourcePath: string): string {
  const trimmed = sourcePath.trim()
  if (!isAbsolute(trimmed)) {
    throw new Error('Worktree paths must be absolute')
  }
  if (trimmed.includes('\0')) {
    throw new Error('Worktree path must not contain control characters')
  }
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/u, '')
  // Git registers symlink-resolved absolute paths (`/var` → `/private/var` on
  // macOS), so compare against the resolved checkout directory.
  try {
    return realpathSync.native(withoutTrailingSeparators)
  } catch {
    return withoutTrailingSeparators
  }
}

/** Strip the `refs/heads/` prefix from a full HEAD ref. */
export function branchNameOf(head: string): string {
  return head.replace(/^refs\/heads\//u, '')
}

/** Symlink-resolved repository root so main-checkout detection survives macOS `/var` aliasing. */
export function resolveRepositoryRoot(repoPath: string): string {
  try {
    return realpathSync.native(repoPath)
  } catch {
    return repoPath
  }
}

/**
 * Discover untracked, regular, root-level `.env` and `.env.*` files.
 *
 * Candidates found on disk are classified through `git ls-files`: anything
 * tracked is excluded so only genuinely untracked environment files propagate,
 * matching the documented contract. Template files never propagate. A Git
 * failure fails closed (no propagation) rather than risking a worktree that
 * silently misses its environment.
 */
export async function discoverEnvironmentFiles(repoPath: string): Promise<string[]> {
  const entries = await readdir(repoPath, { withFileTypes: true })
  const excluded = new Set(['.env.example', '.env.sample', '.env.template'])
  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (excluded.has(name)) continue
    if (name === '.env' || name.startsWith('.env.')) candidates.push(name)
  }
  if (candidates.length === 0) return []
  let trackedOutput: string
  try {
    trackedOutput = await runGit(['ls-files', '-z', '--', ...candidates], { cwd: repoPath })
  } catch (cause) {
    throw new Error(
      `Environment discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
  }
  const tracked = new Set(trackedOutput.split('\0').filter(Boolean))
  return candidates.filter((name) => !tracked.has(name)).sort()
}

/** Copy through a temporary file then rename (atomic, never overwrite). */
async function copyFileAtomic(source: string, target: string): Promise<void> {
  const tmpPath = `${target}.cio-${process.pid}-${randomBytes(6).toString('hex')}.tmp`
  await copyFile(source, tmpPath)
  await rename(tmpPath, target).catch(async (error) => {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  })
}

async function symlinkFile(source: string, target: string): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error('Environment symlinks are not supported on Windows')
  }
  const realSource = await realpath(source)
  const { symlink } = await import('fs/promises')
  await symlink(realSource, target)
}

/** Copy or symlink eligible root-level environment files into the worktree. */
export async function propagateEnvironment(
  projects: Pick<ProjectManager, 'getProject'>,
  projectId: string,
  worktreePath: string,
  mode: ScopeEnvironmentMode,
  progress?: (event: ScopeWorktreeProgress) => void
): Promise<void> {
  const project = await projects.getProject(projectId)
  if (!project || project.source !== 'local') return
  progress?.({ stage: 'environment' })
  const files = await discoverEnvironmentFiles(project.path)
  for (const filename of files) {
    const source = join(project.path, filename)
    const target = join(worktreePath, filename)
    if (existsSync(target)) continue
    if (mode === 'symlink') {
      await symlinkFile(source, target)
    } else {
      await copyFileAtomic(source, target)
    }
  }
}
