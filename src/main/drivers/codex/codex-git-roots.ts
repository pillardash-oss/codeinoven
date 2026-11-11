import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'

/**
 * The directories Codex's `workspace-write` sandbox has to treat as writable
 * for ordinary git work to run inside it.
 *
 * Codex refuses writes to `.git` inside the workspace, so `git add` and
 * `git commit` fail with `Operation not permitted` on `.git/index.lock` and
 * Codex escalates the command to an approval request. Auto Review answers that
 * request the moment it arrives, so the only thing the refusal buys is a stall
 * and an agent that reports being blocked. Naming the repository's git
 * directory (or the gitdir a worktree records) as a writable root keeps the
 * command inside the sandbox, which is what the same session would have been
 * granted a second later anyway.
 *
 * Nothing here throws: a path that cannot be read simply adds no root, and the
 * ordinary approval path keeps working.
 */
export function codexGitWritableRoots(projectPath: string): string[] {
  const gitPath = join(projectPath, '.git')
  const roots: string[] = []
  try {
    if (!existsSync(gitPath)) return roots
    if (statSync(gitPath).isDirectory()) return [resolve(gitPath)]
    const target = recordedGitDir(readFileSync(gitPath, 'utf8'))
    if (!target) return roots
    const gitDir = resolve(dirname(gitPath), target)
    if (!existsSync(gitDir)) return roots
    roots.push(gitDir)
    // A worktree's gitdir lives under `<common>/.git/worktrees/<name>`, while
    // objects and refs a commit touches live in the common directory.
    const common = commonGitDir(gitDir)
    if (common !== undefined && common !== gitDir && existsSync(common)) roots.push(common)
  } catch {
    return roots
  }
  return roots
}

/** The absolute path a `.git` file points at, or undefined for anything else. */
function recordedGitDir(contents: string): string | undefined {
  const match = /^\s*gitdir:\s*(.+?)\s*$/mu.exec(contents)
  return match?.[1]
}

/** `<common>/.git/worktrees/<name>` resolves to `<common>/.git`. */
function commonGitDir(gitDir: string): string | undefined {
  const match = /^(.*[/\\]\.git)[/\\]worktrees[/\\][^/\\]+$/u.exec(gitDir)
  return match?.[1]
}
