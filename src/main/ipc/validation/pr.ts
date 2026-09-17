import {
  assertEnum,
  assertRecord,
  rejectUnknownFields,
  validateBoundedInteger,
  validateBoundedString,
  validateBoolean,
  MAX_GITHUB_NUMERIC_ID
} from './primitives'
import { validateBranchName, validateRemoteName } from './git'

const MERGE_METHODS = new Set<import('../../../lib/types').PrMergeMethod>([
  'merge',
  'squash',
  'rebase'
])
const PULL_STRATEGIES = new Set<import('../../../lib/types').GitPullStrategy>([
  'merge',
  'rebase',
  'ff-only'
])
const PR_STATES = new Set<import('../../../lib/types').PrState>(['open', 'closed', 'all'])
const PR_REVIEW_EVENTS = new Set<import('../../../lib/types').PrReviewEvent>([
  'APPROVE',
  'REQUEST_CHANGES',
  'COMMENT'
])

/** Validate a PR merge method (merge|squash|rebase). */
export function validateMergeMethod(value: unknown): import('../../../lib/types').PrMergeMethod {
  return assertEnum(value, MERGE_METHODS, 'merge method')
}

/** Validate a PR draft create request. */
export function validatePrDraft(value: unknown): import('../../../lib/types').PrDraft {
  const input = assertRecord(value, 'Pull request draft')
  rejectUnknownFields(
    input,
    new Set(['owner', 'repo', 'title', 'body', 'head', 'base', 'draft']),
    'pull request draft'
  )
  const draft: import('../../../lib/types').PrDraft = {
    owner: validateBoundedString(input.owner, 'PR owner', 1, 128),
    repo: validateBoundedString(input.repo, 'PR repository', 1, 128),
    title: validateBoundedString(input.title, 'PR title', 1, 512),
    head: validateBranchName(input.head, 'PR head branch'),
    base: validateBranchName(input.base, 'PR base branch')
  }
  if (input.body !== undefined) {
    if (typeof input.body !== 'string' || input.body.length > 32_768 || input.body.includes('\0')) {
      throw new TypeError('PR body must be a string of at most 32768 characters')
    }
    draft.body = input.body
  }
  if (input.draft !== undefined) {
    draft.draft = validateBoolean(input.draft, 'PR draft')
  }
  return draft
}

/** Validate a PR create request (owner/repo resolved from the origin in main). */
export function validatePrCreateInput(value: unknown): import('../../../lib/types').PrCreateInput {
  const input = assertRecord(value, 'Pull request create input')
  rejectUnknownFields(
    input,
    new Set(['title', 'body', 'head', 'base', 'draft']),
    'pull request create input'
  )
  const draft: import('../../../lib/types').PrCreateInput = {
    title: validateBoundedString(input.title, 'PR title', 1, 512),
    head: validateBranchName(input.head, 'PR head branch'),
    base: validateBranchName(input.base, 'PR base branch')
  }
  if (input.body !== undefined) {
    if (typeof input.body !== 'string' || input.body.length > 32_768 || input.body.includes('\0')) {
      throw new TypeError('PR body must be a string of at most 32768 characters')
    }
    draft.body = input.body
  }
  if (input.draft !== undefined) {
    draft.draft = validateBoolean(input.draft, 'PR draft')
  }
  return draft
}

/** Validate a pull request number. */
export function validatePrNumber(value: unknown): number {
  return validateBoundedInteger(value, 'Pull request number', 1, MAX_GITHUB_NUMERIC_ID)
}

/** Validate a merge/rebase target branch or ref. */
export function validateMergeTarget(value: unknown): string {
  return validateBranchName(value, 'Merge target')
}

/** Validate push options passed to `git:push`. */
export function validatePushOptions(value: unknown): {
  setUpstream: boolean
  remote?: string
  branch?: string
} {
  const input = assertRecord(value, 'Push options')
  rejectUnknownFields(input, new Set(['setUpstream', 'remote', 'branch']), 'push options')
  const options: { setUpstream: boolean; remote?: string; branch?: string } = {
    setUpstream: validateBoolean(input.setUpstream, 'Set upstream')
  }
  if (input.remote !== undefined) {
    options.remote = validateRemoteName(input.remote)
  }
  if (input.branch !== undefined) {
    options.branch = validateBranchName(input.branch, 'Push branch')
  }
  return options
}

/** Options for an explicit, conflict-aware pull. */
export function validatePullIntegrateOptions(value: unknown): {
  remote?: string
  branch?: string
  strategy: import('../../../lib/types').GitPullStrategy
} {
  const input = assertRecord(value, 'Pull integrate options')
  rejectUnknownFields(input, new Set(['remote', 'branch', 'strategy']), 'pull integrate options')
  const options: {
    remote?: string
    branch?: string
    strategy: import('../../../lib/types').GitPullStrategy
  } = {
    strategy: assertEnum(input.strategy, PULL_STRATEGIES, 'pull strategy')
  }
  if (input.remote !== undefined) {
    options.remote = validateRemoteName(input.remote)
  }
  if (input.branch !== undefined) {
    options.branch = validateBranchName(input.branch, 'Pull branch')
  }
  return options
}

/** Options for syncing a worktree checkout with the project's main worktree. */
export function validateMainSyncOptions(value: unknown): {
  strategy: import('../../../lib/types').GitPullStrategy
} {
  const input = assertRecord(value, 'Sync options')
  rejectUnknownFields(input, new Set(['strategy']), 'sync options')
  return {
    strategy: assertEnum(input.strategy, PULL_STRATEGIES, 'sync strategy')
  }
}

/** Validate options for preparing a local PR conflict resolution. */
export function validatePrResolveOptions(value: unknown): {
  remote: string
  pullNumber: number
  baseBranch: string
  headBranch: string
  returnBranch: string
} {
  const input = assertRecord(value, 'PR resolve options')
  rejectUnknownFields(
    input,
    new Set(['remote', 'pullNumber', 'baseBranch', 'headBranch', 'returnBranch']),
    'PR resolve options'
  )
  return {
    remote: validateRemoteName(input.remote),
    pullNumber: validateBoundedInteger(input.pullNumber, 'Pull request number', 1, 1_000_000_000),
    baseBranch: validateBranchName(input.baseBranch, 'PR base branch'),
    headBranch: validateBranchName(input.headBranch, 'PR head branch'),
    returnBranch: validateBranchName(input.returnBranch, 'Branch to return to')
  }
}

/** Validate a PR list state filter. */
export function validatePrState(value: unknown): import('../../../lib/types').PrState {
  return assertEnum(value, PR_STATES, 'PR state')
}

/** Validate a PR review verdict. */
export function validatePrReviewEvent(value: unknown): import('../../../lib/types').PrReviewEvent {
  return assertEnum(value, PR_REVIEW_EVENTS, 'PR review event')
}

/** Validate a 1-based PR listing page number. */
export function validatePrPage(value: unknown): number {
  return validateBoundedInteger(value, 'Pull request page', 1, 1000)
}

/** Validate a PR comment or review body (GitHub caps bodies around 64k). */
export function validatePrCommentBody(value: unknown, allowEmpty = false): string {
  const body = validateBoundedString(value, 'Comment body', allowEmpty ? 0 : 1, 65_536)
  return body
}

/** Validate an optional merge commit title (single line, GitHub-capped). */
export function validateMergeCommitTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return validateBoundedString(value, 'Merge commit title', 1, 256)
}

/** Validate an optional merge commit message (like a comment on the merge). */
export function validateMergeCommitMessage(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return validateBoundedString(value, 'Merge commit message', 1, 65_536)
}

/** Validate an optional stash message. */
export function validateStashMessage(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 256 || value.includes('\0')) {
    throw new TypeError('Stash message must be a string of at most 256 characters')
  }
  return value.trim() || undefined
}

/** Validate an optional stash selector, e.g. `stash@{0}`. */
export function validateStashId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 64) {
    throw new TypeError('Stash id must be a string of at most 64 characters')
  }
  const trimmed = value.trim()
  if (!/^stash@\{[0-9]+\}$/u.test(trimmed)) {
    throw new TypeError('Stash id must look like stash@{0}')
  }
  return trimmed
}
