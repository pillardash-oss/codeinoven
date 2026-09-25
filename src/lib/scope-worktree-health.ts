import type { ScopeWorktreeHealth, ScopeWorktreeHealthCategory } from './types'

/**
 * Single source of truth for what each managed-worktree health category means
 * and which action resolves it.
 *
 * The main process embeds these strings in the errors it throws when a scope
 * root cannot be resolved, so a surface that can only render an error message
 * still tells the user which action fixes the problem. The renderer renders the
 * same copy next to the repair action, so the guidance can never drift between
 * an error toast and the button that resolves it.
 */

/** Categories the app's guided "Repair worktree" action resolves on its own. */
export const REPAIRABLE_SCOPE_WORKTREE_CATEGORIES: readonly ScopeWorktreeHealthCategory[] = [
  'missing',
  'unregistered',
  'locked',
  'prunable',
  'branch-mismatch',
  'path-mismatch'
]

/** Whether the guided repair action addresses this health result. */
export function isScopeWorktreeHealthRepairable(health: ScopeWorktreeHealth | undefined): boolean {
  return health !== undefined && REPAIRABLE_SCOPE_WORKTREE_CATEGORIES.includes(health.category)
}

export interface ScopeWorktreeHealthGuidance {
  /** What is wrong, in the user's terms. */
  cause: string
  /** The action that resolves it, including where to find it in the app. */
  fix: string
  /** Whether the in-app repair action resolves this category. */
  repairable: boolean
}

const REPAIR_HINT = 'Run "Repair worktree" from the scope\'s actions menu on the project board.'

const GUIDANCE: Record<ScopeWorktreeHealthCategory, ScopeWorktreeHealthGuidance> = {
  healthy: {
    cause: 'The managed checkout is healthy',
    fix: 'Nothing to fix.',
    repairable: false
  },
  missing: {
    cause: 'The managed checkout directory is gone',
    fix: `${REPAIR_HINT} It restores the branch exactly as it was committed, so work that was never committed is not recovered.`,
    repairable: true
  },
  unregistered: {
    cause: 'Git does not register this checkout as a worktree',
    fix: `${REPAIR_HINT} It relinks the Git registration for the directory.`,
    repairable: true
  },
  locked: {
    cause: 'Git has this worktree locked',
    fix: `${REPAIR_HINT} It releases the lock.`,
    repairable: true
  },
  prunable: {
    cause: 'Git reports a stale worktree registration',
    fix: `${REPAIR_HINT} It prunes the dead registration and re-creates the checkout when the directory is gone.`,
    repairable: true
  },
  'branch-mismatch': {
    cause: 'The checkout is on a different branch than its managed branch',
    fix: `${REPAIR_HINT} It checks the managed branch out again, so commit or discard work on the other branch first.`,
    repairable: true
  },
  'path-mismatch': {
    cause: 'The checkout was moved away from its managed location',
    fix: `${REPAIR_HINT} It moves the checkout back under the app's project directory.`,
    repairable: true
  },
  'repository-unavailable': {
    cause: 'The project repository is unavailable',
    fix: "Restore the project's local Git repository (or point the project at it again), then reload the project. Repairing the worktree cannot help until Git can read the repository.",
    repairable: false
  }
}

/**
 * Cause and fix for one health result. The reported detail wins over the
 * category default, so a message that names the expected path or the branch Git
 * actually reports is preserved.
 */
export function scopeWorktreeHealthGuidance(
  health: ScopeWorktreeHealth
): ScopeWorktreeHealthGuidance {
  const guidance = GUIDANCE[health.category]
  const detail = health.detail?.trim()
  return detail ? { ...guidance, cause: detail } : guidance
}

/**
 * One-line, actionable message for a scope whose root cannot be resolved right
 * now. Kept in this form so the fix travels with every error surface that has
 * no room for a banner.
 */
export function scopeWorktreeUnavailableMessage(health: ScopeWorktreeHealth): string {
  const guidance = scopeWorktreeHealthGuidance(health)
  return `Managed scope root unavailable (${health.category}): ${guidance.cause}. ${guidance.fix}`
}
