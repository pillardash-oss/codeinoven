import { rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { runGit, runGitChecked } from '../scope-worktree-process'
import type { WorktreeRegistration } from '../../workspaces/scope-root-resolver'
import { ensureParentDir } from './scope-worktree-environment'
import { parseWorktreePorcelain } from './scope-worktree-porcelain'

/** Implement `ManagedWorktreeInspector` for the shared scope resolver. */
export async function listWorktreeRegistrations(repoPath: string): Promise<WorktreeRegistration[]> {
  const output = await runGit(['worktree', 'list', '--porcelain', '-z'], { cwd: repoPath })
  return parseWorktreePorcelain(output).entries.map((entry) => ({
    path: entry.path,
    head: entry.head,
    locked: entry.locked,
    prunable: entry.prunable
  }))
}

/**
 * Detect tracked submodules: the index stores submodules as gitlink entries
 * with mode 160000. `.gitmodules` alone is not authoritative (a stale file
 * can outlive its gitlinks), so we read the staged index instead.
 */
export async function hasTrackedSubmodules(repoPath: string): Promise<boolean> {
  try {
    const output = await runGit(['ls-files', '--stage', '-z'], { cwd: repoPath })
    return output
      .split('\0')
      .some((record) => record.startsWith('160000 ') || record.split(':')[1]?.startsWith('160000 '))
  } catch {
    return false
  }
}

export async function currentBranchAndCommit(repoPath: string): Promise<{
  branch: string
  commit: string
}> {
  const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath })).trim()
  if (branch === 'HEAD') {
    throw new Error('Managed worktrees require a named current branch (detached HEAD)')
  }
  const commit = (await runGit(['rev-parse', 'HEAD'], { cwd: repoPath })).trim()
  return { branch, commit }
}

export async function distinctExistingNames(
  repoPath: string
): Promise<{ branches: Set<string>; paths: Set<string> }> {
  const branches = new Set<string>()
  const paths = new Set<string>()
  const output = await runGit(['worktree', 'list', '--porcelain', '-z'], { cwd: repoPath })
  for (const entry of parseWorktreePorcelain(output).entries) {
    paths.add(entry.path)
    if (entry.head) branches.add(entry.head)
  }
  return { branches, paths }
}

/** Resolve a named source branch to its checked-out commit, or fail loudly. */
export async function branchToCommit(
  repoPath: string,
  branch: string
): Promise<{ branch: string; commit: string }> {
  const ref = /^refs\//u.test(branch) ? branch : `refs/heads/${branch}`
  const commit = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repoPath
  })
    .catch(() => {
      throw new Error(`Source branch does not exist: ${branch}`)
    })
    .then((output) => output.trim())
  if (!/^[0-9a-f]{7,64}$/iu.test(commit)) {
    throw new Error(`Source branch does not exist: ${branch}`)
  }
  return { branch, commit }
}

/**
 * Informational fork metadata for an adopted branch: merge-base with the
 * repository's current branch when one exists, otherwise the branch root.
 */
export async function adoptionMetadata(
  repoPath: string,
  branch: string
): Promise<{ baseBranch: string; baseCommit: string }> {
  const current = await currentBranchAndCommit(repoPath)
  const ref = `refs/heads/${branch}`
  const mergeBase = await runGit(['merge-base', ref, 'HEAD'], { cwd: repoPath })
    .then((output) => output.trim())
    .catch(() => '')
  if (/^[0-9a-f]{7,64}$/iu.test(mergeBase)) {
    return { baseBranch: current.branch, baseCommit: mergeBase }
  }
  const root = await runGit(['rev-list', '--max-parents=0', '-n', '1', ref], {
    cwd: repoPath
  })
    .then((output) => output.trim())
    .catch(() => '')
  if (/^[0-9a-f]{7,64}$/iu.test(root)) return { baseBranch: current.branch, baseCommit: root }
  throw new Error(`Could not derive adoption metadata for ${branch}`)
}

/** Whether the project repository still has the scope's local branch. */
export async function managedBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await runGitChecked(['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: repoPath,
      timeoutMs: 30_000
    })
    return true
  } catch {
    return false
  }
}

/**
 * Re-create the checkout at `expectedPath` from an existing managed branch.
 * A branch that no longer exists is the one case repair cannot resolve on its
 * own, so it fails with the recovery instead of leaving the scope silently
 * broken.
 */
export async function restoreCheckout(
  repoPath: string,
  expectedPath: string,
  branch: string
): Promise<void> {
  if (!(await managedBranchExists(repoPath, branch))) {
    throw new Error(
      `The managed branch ${branch} no longer exists, so its checkout cannot be restored. Delete the scope to clear its record, or restore the branch from the remote and then run "Repair worktree" again.`
    )
  }
  await runGitChecked(['worktree', 'prune'], { cwd: repoPath, timeoutMs: 120_000 }).catch(
    () => undefined
  )
  await ensureParentDir(expectedPath)
  try {
    await runGitChecked(['worktree', 'add', expectedPath, branch], {
      cwd: repoPath,
      timeoutMs: 120_000
    })
  } catch (cause) {
    await rm(expectedPath, { recursive: true, force: true }).catch(() => undefined)
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`The checkout could not be restored from ${branch}: ${detail}`, { cause })
  }
}

/** Run one repair step, turning a Git refusal into an actionable error. */
export async function runRepairStep(
  args: string[],
  cwd: string,
  failure: string,
  timeoutMs?: number
): Promise<void> {
  try {
    await runGitChecked(args, { cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`${failure} (${detail})`, { cause })
  }
}

/** Conflicted (unmerged) file paths in a working tree. */
export async function unmergedFiles(root: string): Promise<string[]> {
  try {
    const output = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: root })
    return output
      .split('\n')
      .map((path) => path.trim())
      .filter((path) => path.length > 0)
  } catch {
    return []
  }
}

export async function dirtyFiles(
  repoPath: string | undefined,
  worktreePath: string
): Promise<string[]> {
  if (!repoPath) return []
  try {
    const output = await runGit(['status', '--porcelain', '-z'], { cwd: worktreePath })
    const files: string[] = []
    const records = output.split('\0')
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      if (!record) continue
      const code = record.slice(0, 2)
      const rest = record.slice(3)
      if (code === '??') files.push(`untracked: ${rest}`)
      else files.push(rest)
    }
    return files.slice(0, 200)
  } catch {
    return []
  }
}

/**
 * Count commits on the managed branch that are not reachable from any
 * remote-tracking ref. Scoped to the branch so unrelated local branches in
 * the shared repository never block this scope's lifecycle.
 */
export async function unpushedCount(
  repoPath: string | undefined,
  branch: string,
  worktreeFallback?: string
): Promise<number> {
  const cwd = repoPath ?? worktreeFallback
  if (!cwd) return 0
  try {
    const output = await runGit(
      ['rev-list', '--count', `refs/heads/${branch}`, '--not', '--remotes'],
      { cwd, timeoutMs: 60_000 }
    )
    const count = Number.parseInt(output.trim(), 10)
    return Number.isSafeInteger(count) && count > 0 ? count : 0
  } catch {
    // A missing branch or unavailable repository must not invent risk here;
    // the dirty-file check and health checks cover those cases separately.
    return 0
  }
}

/** Whether Git registers the managed branch at the expected worktree path. */
export async function managedBranchRegisteredAt(
  listWorktrees: (repoPath: string) => Promise<WorktreeRegistration[]>,
  discoveryCwd: string,
  expectedPath: string,
  branch: string
): Promise<boolean> {
  try {
    const registrations = await listWorktrees(discoveryCwd)
    return registrations.some(
      (registration) =>
        registration.path === expectedPath && registration.head === `refs/heads/${branch}`
    )
  } catch {
    return false
  }
}

/** True when the path is a Git repository root. */
export function isGitRepository(path: string): boolean {
  return existsSync(join(path, '.git')) || existsSync(join(path, '.git', 'HEAD'))
}
