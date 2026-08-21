import { fileURLToPath } from 'url'
import { realpath } from 'fs/promises'
import { isAbsolute, relative, resolve, sep, win32 } from 'path'
import type { WebFrameMain } from 'electron'
import type {
  ChecklistItemStatus,
  CreateProjectInput,
  CreateThreadInput,
  HistoryRole,
  InferenceMode,
  ScopeBoard,
  ScopeSlice,
  ThreadSettings,
  ThreadStatus,
  ThreadTitleSource
} from '../../lib/types'

/** GitHub's opaque numeric IDs are not constrained to signed 32-bit integers. */
export const MAX_GITHUB_NUMERIC_ID = Number.MAX_SAFE_INTEGER

const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const THREAD_STATUSES = new Set<ThreadStatus>([
  'created',
  'planning',
  'awaiting_approval',
  'spec',
  'executing',
  'working-paused',
  'interrupted',
  'completed',
  'failed'
])
const HISTORY_ROLES = new Set<HistoryRole>(['user', 'assistant', 'system', 'tool'])
const CHECKLIST_ITEM_STATUSES = new Set<ChecklistItemStatus>([
  'pending',
  'in_progress',
  'complete',
  'failed'
])
const THINKING_LEVELS = new Set<ThreadSettings['thinkingLevel']>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])
const INFERENCE_MODES = new Set<InferenceMode>(['normal', 'fast'])
const TITLE_MODES = new Set<NonNullable<ThreadSettings['titleMode']>>(['model', 'deterministic'])
const PERMISSION_LEVELS = new Set<ThreadSettings['permissionLevel']>(['auto_review', 'full_access'])
const PROJECT_SOURCES = new Set<NonNullable<CreateProjectInput['source']>>(['local', 'ssh'])
const CHANGE_TRACKING_MODES = new Set<NonNullable<CreateProjectInput['changeTrackingMode']>>([
  'git',
  'manual'
])
const THREAD_TITLE_SOURCES = new Set<ThreadTitleSource>(['default', 'auto', 'manual'])

const THREAD_SETTINGS_FIELDS = new Set([
  'harnessId',
  'providerId',
  'modelId',
  'titleMode',
  'thinkingLevel',
  'inferenceMode',
  'permissionLevel',
  'engineeringMode',
  'assignmentMode',
  'loopMode',
  'fileSystemMode',
  'loopAuditor',
  'imageDescriptor'
])
const AGENT_MODEL_SELECTION_FIELDS = new Set([
  'harnessId',
  'providerId',
  'modelId',
  'thinkingLevel'
])
const CREATE_PROJECT_FIELDS = new Set([
  'name',
  'path',
  'source',
  'host',
  'providerId',
  'workflowId',
  'threadLimit',
  'hidden',
  'color',
  'iconType',
  'changeTrackingMode'
])
const CREATE_THREAD_FIELDS = new Set([
  'projectId',
  'providerId',
  'title',
  'workingDirectory',
  'settings',
  'titleSource',
  'scopeBucketId'
])

const SCOPE_SLICES = new Set<ScopeSlice>([
  'todo',
  'working',
  'spec',
  'issue',
  'unread',
  'done',
  'pinned'
])

const SCOPE_DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SCOPE_ENVIRONMENT_MODES = new Set<import('../../lib/types').ScopeEnvironmentMode>([
  'copy',
  'symlink'
])
const SCOPE_SETUP_STATES = new Set<import('../../lib/types').ScopeSetupStatusState>([
  'not_run',
  'running',
  'succeeded',
  'failed',
  'interrupted'
])
const SCOPE_SETUP_COMMAND_STATES = new Set<import('../../lib/types').ScopeSetupCommandState>([
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'interrupted'
])

/** Validate a managed-scope directory name: one path-safe relative segment. */
export function validateScopeDirectoryName(value: unknown): string {
  const name = validateBoundedString(value, 'Scope directory name', 1, 128)
  if (
    isAbsolute(name) ||
    win32.isAbsolute(name) ||
    !SCOPE_DIRECTORY_PATTERN.test(name) ||
    name.split(/[\\/]+/u).includes('..')
  ) {
    throw new TypeError('Scope directory name must be a single path-safe segment')
  }
  return name
}

/** Validate a scope target ({ projectId, scopeBucketId }). */
export function validateScopeTarget(value: unknown): import('../../lib/types').ScopeTarget {
  const input = assertRecord(value, 'Scope target')
  rejectUnknownFields(input, new Set(['projectId', 'scopeBucketId']), 'scope target')
  return {
    projectId: validateEntityId(input.projectId, 'Project ID'),
    scopeBucketId: validateEntityId(input.scopeBucketId, 'Scope bucket ID')
  }
}

/** Validate one structured setup command (executable + argument array). */
export function validateSetupCommandSpec(
  value: unknown
): import('../../lib/types').ScopeSetupCommandSpec {
  const input = assertRecord(value, 'Setup command')
  rejectUnknownFields(input, new Set(['executable', 'args']), 'setup command')
  const executable = validateBoundedString(input.executable, 'Setup command executable', 1, 1024)
  if (!Array.isArray(input.args) || input.args.length > 256) {
    throw new TypeError('Setup command args must be an array of at most 256 strings')
  }
  const args = input.args.map((arg, index) =>
    validateBoundedString(arg, `Setup command arg ${index}`, 0, 4096)
  )
  return { executable, args }
}

export function validateSetupCommandSpecs(
  value: unknown
): import('../../lib/types').ScopeSetupCommandSpec[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError('Setup commands must be an array of at most 64 entries')
  }
  return value.map((entry) => validateSetupCommandSpec(entry))
}

export function validateEnvironmentMode(
  value: unknown
): import('../../lib/types').ScopeEnvironmentMode {
  return assertEnum(value, SCOPE_ENVIRONMENT_MODES, 'environment mode')
}

/** Validate a bounded array of plain string identifiers. */
export function validateStringArray(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number,
  maximumEntries = 512
): string[] {
  if (!Array.isArray(value) || value.length < minimumLength || value.length > maximumEntries) {
    throw new TypeError(`${label} must be an array of ${minimumLength}–${maximumEntries} entries`)
  }
  return value.map((entry, index) =>
    validateBoundedString(entry, `${label}[${index}]`, 0, maximumLength)
  )
}

/** Validate a full scope ordering for the layout operation. */
export function validateScopeOrderIds(value: unknown): string[] {
  return validateStringArray(value, 'Scope order', 1, 256, 256)
}

/** Validate a display-metadata patch for one scope bucket. */
export function validateScopeAppearancePatch(
  value: unknown
): import('../../lib/types').ScopeAppearancePatch {
  const input = assertRecord(value, 'Scope appearance patch')
  rejectUnknownFields(input, new Set(['name', 'color', 'iconType']), 'scope appearance patch')
  const patch: import('../../lib/types').ScopeAppearancePatch = {}
  if (input.name !== undefined) {
    patch.name = validateBoundedString(input.name, 'Scope name', 1, 120)
  }
  if (input.color === null) {
    patch.color = null
  } else if (input.color !== undefined) {
    if (typeof input.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(input.color)) {
      throw new TypeError('Scope color must be a hex colour string (e.g. #ef4444)')
    }
    patch.color = input.color
  }
  if (input.iconType === null) {
    patch.iconType = null
  } else if (input.iconType !== undefined) {
    patch.iconType = validateBoundedString(input.iconType, 'Scope icon type', 1, 50)
  }
  return patch
}

/** Validate a collapse-state patch for one scope bucket. */
export function validateScopeCollapsePatch(
  value: unknown
): import('../../lib/types').ScopeCollapsePatch {
  const input = assertRecord(value, 'Scope collapse patch')
  rejectUnknownFields(input, new Set(['collapsed', 'collapsedSlices']), 'scope collapse patch')
  const patch: import('../../lib/types').ScopeCollapsePatch = {}
  if (input.collapsed !== undefined) {
    patch.collapsed = validateBoolean(input.collapsed, 'Scope collapsed')
  }
  if (input.collapsedSlices !== undefined) {
    if (!Array.isArray(input.collapsedSlices)) {
      throw new TypeError('Collapsed scope slices must be an array')
    }
    const slices = input.collapsedSlices.flatMap((slice): ScopeSlice[] => {
      if (slice === 'stale') return []
      if (typeof slice !== 'string' || !SCOPE_SLICES.has(slice as ScopeSlice)) {
        throw new TypeError(`Unsupported scope slice: ${String(slice)}`)
      }
      return [slice as ScopeSlice]
    })
    if (new Set(slices).size !== slices.length) {
      throw new TypeError('Collapsed scope slices must be unique')
    }
    patch.collapsedSlices = slices
  }
  return patch
}

/** Validate renderer input for creating a project-rooted custom scope. */
export function validateScopeCreateInput(
  value: unknown
): import('../../lib/types').ScopeCreateInput {
  const input = assertRecord(value, 'Scope create input')
  rejectUnknownFields(input, new Set(['name', 'color', 'iconType']), 'scope create input')
  const sanitized: import('../../lib/types').ScopeCreateInput = {
    name: validateBoundedString(input.name, 'Scope name', 1, 120)
  }
  if (input.color !== undefined) {
    if (typeof input.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(input.color)) {
      throw new TypeError('Scope color must be a hex colour string (e.g. #ef4444)')
    }
    sanitized.color = input.color
  }
  if (input.iconType !== undefined) {
    sanitized.iconType = validateBoundedString(input.iconType, 'Scope icon type', 1, 50)
  }
  return sanitized
}

export function validateWorktreeDefaults(
  value: unknown
): import('../../lib/types').ScopeWorktreeDefaults {
  const input = assertRecord(value, 'Worktree defaults')
  rejectUnknownFields(
    input,
    new Set(['setupCommands', 'runSetupByDefault', 'environmentMode']),
    'worktree defaults'
  )
  return {
    setupCommands: validateSetupCommandSpecs(input.setupCommands),
    runSetupByDefault: validateBoolean(input.runSetupByDefault, 'Run setup by default'),
    environmentMode: validateEnvironmentMode(input.environmentMode)
  }
}

function validateSetupStatus(value: unknown): import('../../lib/types').ScopeSetupStatus {
  const input = assertRecord(value, 'Setup status')
  rejectUnknownFields(
    input,
    new Set(['state', 'commands', 'startedAt', 'finishedAt']),
    'setup status'
  )
  const state = assertEnum(input.state, SCOPE_SETUP_STATES, 'setup state')
  if (!Array.isArray(input.commands)) {
    throw new TypeError('Setup status commands must be an array')
  }
  const commands = input.commands.map(
    (entry, index): import('../../lib/types').ScopeSetupCommandRecord => {
      const record = assertRecord(entry, `Setup command record ${index}`)
      rejectUnknownFields(
        record,
        new Set(['index', 'executable', 'args', 'state', 'exitCode', 'startedAt', 'finishedAt']),
        'setup command record'
      )
      const commandState = assertEnum(
        record.state,
        SCOPE_SETUP_COMMAND_STATES,
        'setup command state'
      )
      const result: import('../../lib/types').ScopeSetupCommandRecord = {
        index: validateBoundedInteger(record.index, 'Setup command index', 0, 4096),
        executable: validateBoundedString(record.executable, 'Setup executable', 1, 1024),
        args: (Array.isArray(record.args) ? record.args : []).map((arg, argIndex) =>
          validateBoundedString(arg, `Setup arg ${argIndex}`, 0, 4096)
        ),
        state: commandState
      }
      if (record.exitCode !== undefined) {
        result.exitCode = validateBoundedInteger(record.exitCode, 'Setup exit code', -1, 4096)
      }
      if (record.startedAt !== undefined) {
        result.startedAt = validateBoundedInteger(
          record.startedAt,
          'Setup startedAt',
          0,
          Number.MAX_SAFE_INTEGER
        )
      }
      if (record.finishedAt !== undefined) {
        result.finishedAt = validateBoundedInteger(
          record.finishedAt,
          'Setup finishedAt',
          0,
          Number.MAX_SAFE_INTEGER
        )
      }
      return result
    }
  )
  const status: import('../../lib/types').ScopeSetupStatus = { state, commands }
  if (input.startedAt !== undefined) {
    status.startedAt = validateBoundedInteger(
      input.startedAt,
      'Setup startedAt',
      0,
      Number.MAX_SAFE_INTEGER
    )
  }
  if (input.finishedAt !== undefined) {
    status.finishedAt = validateBoundedInteger(
      input.finishedAt,
      'Setup finishedAt',
      0,
      Number.MAX_SAFE_INTEGER
    )
  }
  return status
}

function validateRootDescriptor(value: unknown): import('../../lib/types').ScopeRootDescriptor {
  const input = assertRecord(value, 'Scope root descriptor')
  if (input.kind === 'project') {
    rejectUnknownFields(input, new Set(['kind']), 'scope root descriptor')
    return { kind: 'project' } satisfies import('../../lib/types').ProjectRootDescriptor
  }
  if (input.kind === 'worktree') {
    rejectUnknownFields(
      input,
      new Set([
        'kind',
        'directoryName',
        'branch',
        'baseBranch',
        'baseCommit',
        'createdAt',
        'environmentMode',
        'setup'
      ]),
      'scope root descriptor'
    )
    return {
      kind: 'worktree',
      directoryName: validateScopeDirectoryName(input.directoryName),
      branch: validateBranchName(input.branch, 'Managed branch'),
      baseBranch: validateBranchName(input.baseBranch, 'Managed base branch'),
      baseCommit: validateBoundedString(input.baseCommit, 'Managed base commit', 1, 64),
      createdAt: validateBoundedInteger(
        input.createdAt,
        'Managed creation time',
        0,
        Number.MAX_SAFE_INTEGER
      ),
      environmentMode: validateEnvironmentMode(input.environmentMode),
      setup: validateSetupStatus(input.setup)
    } satisfies import('../../lib/types').ManagedWorktreeDescriptor
  }
  throw new TypeError(`Unsupported scope root kind: ${String(input.kind)}`)
}

export function validateScopeSlice(value: unknown): ScopeSlice {
  if (typeof value !== 'string' || !SCOPE_SLICES.has(value as ScopeSlice)) {
    throw new TypeError('Invalid scope slice')
  }
  return value as ScopeSlice
}

const GIT_PATH_PATTERN = /^[^\0]*$/u
const GIT_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
const GIT_REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const GIT_URL_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'file'])
const GIT_COMMIT_MESSAGE_MAX = 4096
/** Upper bound on one assembled conflict-resolution payload (child of MAX_DIFF_BYTES). */
const GIT_CONFLICT_RESOLUTION_MAX = 500 * 1024
const GIT_RESET_MODES = new Set(['soft', 'mixed', 'hard'])

/**
 * Validate a project-relative git path: must be non-empty, bounded, free of
 * control characters, and must not contain `..` segments (path traversal).
 */
export function validateGitRelativePath(value: unknown, label = 'Git file path'): string {
  const path = validateBoundedString(value, label, 1, 4096)
  if (!GIT_PATH_PATTERN.test(path)) {
    throw new TypeError(`${label} must not contain control characters`)
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new TypeError(`${label} must not escape the repository root`)
  }
  return path
}

/** Validate a list of project-relative git paths. */
export function validateGitPathArray(value: unknown, label = 'Git file paths'): string[] {
  if (!Array.isArray(value) || value.length > 2000) {
    throw new TypeError(`${label} must be an array of at most 2000 paths`)
  }
  return value.map((entry, index) => validateGitRelativePath(entry, `${label}[${index}]`))
}

/** Validate a branch name (letters, numbers, dots, underscores, hyphens, slashes). */
export function validateBranchName(value: unknown, label = 'Git branch'): string {
  const branch = validateBoundedString(value, label, 1, 256)
  if (!GIT_BRANCH_PATTERN.test(branch) || branch.endsWith('/') || branch.endsWith('.')) {
    throw new TypeError(`${label} is not a valid git branch name`)
  }
  return branch
}

/** Validate a commit message, allowing free-form multi-line text. */
export function validateCommitMessage(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Commit message must be a string')
  if (value.length === 0 || value.length > GIT_COMMIT_MESSAGE_MAX || value.includes('\0')) {
    throw new TypeError(`Commit message must be between 1 and ${GIT_COMMIT_MESSAGE_MAX} characters`)
  }
  return value.replace(/\r\n/gu, '\n')
}

/**
 * Validate assembled conflict-resolution content: free-form multi-line text up
 * to the diff bounded cap, without NUL control characters.
 */
export function validateConflictResolutionContent(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TypeError('Conflict resolution must be a string without NUL characters')
  }
  if (value.length > GIT_CONFLICT_RESOLUTION_MAX) {
    throw new TypeError(
      `Conflict resolution must be at most ${GIT_CONFLICT_RESOLUTION_MAX} characters`
    )
  }
  return value.replace(/\r\n/gu, '\n')
}

/** Validate a git reset severity mode (soft / mixed / hard). */
export function validateGitResetMode(value: unknown): 'soft' | 'mixed' | 'hard' {
  if (typeof value !== 'string' || !GIT_RESET_MODES.has(value)) {
    throw new TypeError('Reset mode must be one of: soft, mixed, hard')
  }
  return value as 'soft' | 'mixed' | 'hard'
}

/** Validate a git identity name/email pair. */
export function validateGitIdentity(value: unknown): { name: string; email: string } {
  const input = assertRecord(value, 'Git identity')
  rejectUnknownFields(input, new Set(['name', 'email']), 'git identity')
  return {
    name: validateBoundedString(input.name, 'Git identity name', 1, 256),
    email: validateBoundedString(input.email, 'Git identity email', 1, 256)
  }
}

/** Validate a remote name (single path-safe segment). */
export function validateRemoteName(value: unknown): string {
  const name = validateBoundedString(value, 'Remote name', 1, 128)
  if (!GIT_REMOTE_NAME_PATTERN.test(name)) {
    throw new TypeError(
      'Remote name must contain only letters, numbers, dots, underscores, and hyphens'
    )
  }
  return name
}

/** Validate a remote URL (scheme-constrained, bounded length). */
export function validateRemoteUrl(value: unknown): string {
  const url = validateBoundedString(value, 'Remote URL', 1, 4096)
  if (!url.includes(':') && !url.startsWith('/')) {
    throw new TypeError('Remote URL must be a valid git remote URL')
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/iu.exec(url)
  if (schemeMatch && !GIT_URL_SCHEMES.has(schemeMatch[1]!.toLowerCase())) {
    throw new TypeError(`Remote URL scheme "${schemeMatch[1]}" is not supported`)
  }
  if (url.includes('\n') || url.includes('\r') || url.includes('\0')) {
    throw new TypeError('Remote URL must not contain control characters')
  }
  return url
}

const MERGE_METHODS = new Set<import('../../lib/types').PrMergeMethod>([
  'merge',
  'squash',
  'rebase'
])
const PULL_STRATEGIES = new Set<import('../../lib/types').GitPullStrategy>([
  'merge',
  'rebase',
  'ff-only'
])
const PR_STATES = new Set<import('../../lib/types').PrState>(['open', 'closed', 'all'])
const PR_REVIEW_EVENTS = new Set<import('../../lib/types').PrReviewEvent>([
  'APPROVE',
  'REQUEST_CHANGES',
  'COMMENT'
])

/** Validate a PR merge method (merge|squash|rebase). */
export function validateMergeMethod(value: unknown): import('../../lib/types').PrMergeMethod {
  return assertEnum(value, MERGE_METHODS, 'merge method')
}

/** Validate a PR draft create request. */
export function validatePrDraft(value: unknown): import('../../lib/types').PrDraft {
  const input = assertRecord(value, 'Pull request draft')
  rejectUnknownFields(
    input,
    new Set(['owner', 'repo', 'title', 'body', 'head', 'base', 'draft']),
    'pull request draft'
  )
  const draft: import('../../lib/types').PrDraft = {
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
export function validatePrCreateInput(value: unknown): import('../../lib/types').PrCreateInput {
  const input = assertRecord(value, 'Pull request create input')
  rejectUnknownFields(
    input,
    new Set(['title', 'body', 'head', 'base', 'draft']),
    'pull request create input'
  )
  const draft: import('../../lib/types').PrCreateInput = {
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
  strategy: import('../../lib/types').GitPullStrategy
} {
  const input = assertRecord(value, 'Pull integrate options')
  rejectUnknownFields(input, new Set(['remote', 'branch', 'strategy']), 'pull integrate options')
  const options: {
    remote?: string
    branch?: string
    strategy: import('../../lib/types').GitPullStrategy
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

/** Validate options for preparing a local PR conflict resolution. */
export function validatePrResolveOptions(value: unknown): {
  remote: string
  pullNumber: number
  baseBranch: string
} {
  const input = assertRecord(value, 'PR resolve options')
  rejectUnknownFields(input, new Set(['remote', 'pullNumber', 'baseBranch']), 'PR resolve options')
  return {
    remote: validateRemoteName(input.remote),
    pullNumber: validateBoundedInteger(input.pullNumber, 'Pull request number', 1, 1_000_000_000),
    baseBranch: validateBranchName(input.baseBranch, 'PR base branch')
  }
}

/** Validate a PR list state filter. */
export function validatePrState(value: unknown): import('../../lib/types').PrState {
  return assertEnum(value, PR_STATES, 'PR state')
}

/** Validate a PR review verdict. */
export function validatePrReviewEvent(value: unknown): import('../../lib/types').PrReviewEvent {
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

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  label: string
): void {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new TypeError(`Unsupported ${label} field: ${field}`)
    }
  }
}

function assertEnum<T extends string>(
  value: unknown,
  allowedValues: ReadonlySet<T>,
  label: string
): T {
  if (typeof value !== 'string' || !allowedValues.has(value as T)) {
    throw new TypeError(`Invalid ${label}`)
  }
  return value as T
}

/** Validate an identifier that is safe to use as one filesystem path segment. */
export function validateEntityId(value: unknown, label = 'Entity ID', maximumLength = 128): string {
  const id = validateBoundedString(value, label, 1, maximumLength)
  if (id === '.' || id === '..' || !SAFE_ENTITY_ID.test(id)) {
    throw new TypeError(
      `${label} must contain only letters, numbers, dots, underscores, and hyphens`
    )
  }
  return id
}

export function validateBoolean(value: unknown, label = 'Value'): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be a boolean`)
  }
  return value
}

export function validateBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

/** A manual drag-reorder anchor: a finite, non-negative epoch timestamp (may be fractional). */
export function validateSortOrder(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError('Sort order must be a finite non-negative number')
  }
  return value
}

export function validateBoundedString(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number
): string {
  if (typeof value !== 'string' || minimumLength < 0 || maximumLength < minimumLength) {
    throw new TypeError(
      `${label} must be a string between ${minimumLength} and ${maximumLength} characters`
    )
  }

  const sanitized = value.trim()
  if (
    sanitized.length < minimumLength ||
    sanitized.length > maximumLength ||
    sanitized.includes('\0')
  ) {
    throw new TypeError(
      `${label} must be a string between ${minimumLength} and ${maximumLength} characters`
    )
  }
  return sanitized
}

export function validateThreadStatus(value: unknown): ThreadStatus {
  return assertEnum(value, THREAD_STATUSES, 'thread status')
}

export function validateThreadTitleSource(value: unknown): ThreadTitleSource {
  return assertEnum(value, THREAD_TITLE_SOURCES, 'thread title source')
}

export function validateHistoryRole(value: unknown): HistoryRole {
  return assertEnum(value, HISTORY_ROLES, 'history role')
}

export function validateChecklistItemStatus(value: unknown): ChecklistItemStatus {
  return assertEnum(value, CHECKLIST_ITEM_STATUSES, 'checklist item status')
}

export function validateThreadSettings(value: unknown): ThreadSettings {
  const input = assertRecord(value, 'Thread settings')
  rejectUnknownFields(input, THREAD_SETTINGS_FIELDS, 'thread settings')

  const settings: ThreadSettings = {
    harnessId: validateEntityId(input.harnessId, 'Harness ID'),
    providerId: validateBoundedString(input.providerId, 'Provider ID', 0, 128),
    modelId: validateBoundedString(input.modelId, 'Model ID', 0, 256),
    thinkingLevel: assertEnum(input.thinkingLevel, THINKING_LEVELS, 'thinking level'),
    permissionLevel: assertEnum(input.permissionLevel, PERMISSION_LEVELS, 'permission level'),
    engineeringMode: validateBoolean(input.engineeringMode, 'Engineering'),
    assignmentMode:
      input.assignmentMode === undefined
        ? false
        : validateBoolean(input.assignmentMode, 'Assignment'),
    loopMode: input.loopMode === undefined ? false : validateBoolean(input.loopMode, 'Achievement')
  }
  if (input.inferenceMode !== undefined) {
    settings.inferenceMode = assertEnum(input.inferenceMode, INFERENCE_MODES, 'inference mode')
  }
  if (input.titleMode !== undefined) {
    settings.titleMode = assertEnum(input.titleMode, TITLE_MODES, 'title mode')
  }
  if (input.fileSystemMode !== undefined) {
    settings.fileSystemMode = validateBoolean(input.fileSystemMode, 'File System')
  }
  if (input.loopAuditor !== undefined) {
    const auditor = assertRecord(input.loopAuditor, 'Achievement auditor')
    rejectUnknownFields(auditor, AGENT_MODEL_SELECTION_FIELDS, 'Achievement auditor')
    settings.loopAuditor = {
      harnessId: validateEntityId(auditor.harnessId, 'Achievement auditor harness ID'),
      providerId: validateBoundedString(
        auditor.providerId,
        'Achievement auditor provider ID',
        1,
        128
      ),
      modelId: validateBoundedString(auditor.modelId, 'Achievement auditor model ID', 1, 256),
      ...(auditor.thinkingLevel === undefined
        ? {}
        : {
            thinkingLevel: assertEnum(
              auditor.thinkingLevel,
              THINKING_LEVELS,
              'Achievement auditor thinking level'
            )
          })
    }
  }
  if (input.imageDescriptor !== undefined) {
    const descriptor = assertRecord(input.imageDescriptor, 'Image descriptor')
    rejectUnknownFields(descriptor, AGENT_MODEL_SELECTION_FIELDS, 'image descriptor')
    settings.imageDescriptor = {
      harnessId: validateEntityId(descriptor.harnessId, 'Image descriptor harness ID'),
      providerId: validateBoundedString(
        descriptor.providerId,
        'Image descriptor provider ID',
        1,
        128
      ),
      modelId: validateBoundedString(descriptor.modelId, 'Image descriptor model ID', 1, 256),
      ...(descriptor.thinkingLevel === undefined
        ? {}
        : {
            thinkingLevel: assertEnum(
              descriptor.thinkingLevel,
              THINKING_LEVELS,
              'image descriptor thinking level'
            )
          })
    }
  }
  return settings
}

export function validateCreateProjectInput(value: unknown): CreateProjectInput {
  const input = assertRecord(value, 'Create project input')
  rejectUnknownFields(input, CREATE_PROJECT_FIELDS, 'create project')

  const sanitized: CreateProjectInput = {
    name: validateBoundedString(input.name, 'Project name', 1, 120),
    path: validateBoundedString(input.path, 'Project path', 1, 4096)
  }

  if (input.source !== undefined) {
    sanitized.source = assertEnum(input.source, PROJECT_SOURCES, 'project source')
  }
  if (input.host !== undefined) {
    sanitized.host = validateBoundedString(input.host, 'SSH host', 1, 255)
  }
  if (input.providerId !== undefined) {
    sanitized.providerId = validateEntityId(input.providerId, 'Provider ID')
  }
  if (input.workflowId !== undefined) {
    sanitized.workflowId = validateEntityId(input.workflowId, 'Workflow ID')
  }
  if (input.threadLimit !== undefined) {
    sanitized.threadLimit = validateBoundedInteger(input.threadLimit, 'Thread limit', 1, 1000)
  }
  if (input.hidden !== undefined) {
    sanitized.hidden = validateBoolean(input.hidden, 'Hidden')
  }
  if (input.changeTrackingMode !== undefined) {
    sanitized.changeTrackingMode = assertEnum(
      input.changeTrackingMode,
      CHANGE_TRACKING_MODES,
      'change tracking mode'
    )
  }
  if (input.color !== undefined) {
    if (typeof input.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(input.color)) {
      throw new TypeError('Project color must be a hex colour string (e.g. #ef4444)')
    }
    sanitized.color = input.color
  }
  if (input.iconType !== undefined) {
    sanitized.iconType = validateBoundedString(input.iconType, 'Project icon type', 1, 50)
  }

  return sanitized
}

export function validateCreateThreadInput(value: unknown): CreateThreadInput {
  const input = assertRecord(value, 'Create thread input')
  rejectUnknownFields(input, CREATE_THREAD_FIELDS, 'create thread')

  const sanitized: CreateThreadInput = {
    projectId: validateEntityId(input.projectId, 'Project ID'),
    providerId: validateEntityId(input.providerId, 'Provider ID'),
    title: validateBoundedString(input.title, 'Thread title', 1, 240)
  }

  if (input.workingDirectory !== undefined) {
    sanitized.workingDirectory = validateBoundedString(
      input.workingDirectory,
      'Working directory',
      0,
      4096
    )
  }
  if (input.settings !== undefined) {
    sanitized.settings = validateThreadSettings(input.settings)
  }
  if (input.titleSource !== undefined) {
    sanitized.titleSource = validateThreadTitleSource(input.titleSource)
  }

  if (input.scopeBucketId !== undefined) {
    sanitized.scopeBucketId = validateEntityId(input.scopeBucketId, 'Scope bucket ID')
  }
  return sanitized
}

const UPDATE_THREAD_FIELDS = new Set([
  'title',
  'titleSource',
  'providerId',
  'workingDirectory',
  'scopeBucketId',
  'lastActivity',
  'read'
])

export function validateThreadUpdateInput(
  value: unknown
): Partial<
  Pick<
    import('../../lib/types').Thread,
    | 'title'
    | 'titleSource'
    | 'providerId'
    | 'workingDirectory'
    | 'scopeBucketId'
    | 'lastActivity'
    | 'read'
  >
> {
  const input = assertRecord(value, 'Thread update input')
  rejectUnknownFields(input, UPDATE_THREAD_FIELDS, 'thread update')

  const sanitized: Partial<
    Pick<
      import('../../lib/types').Thread,
      | 'title'
      | 'titleSource'
      | 'providerId'
      | 'workingDirectory'
      | 'scopeBucketId'
      | 'lastActivity'
      | 'read'
    >
  > = {}

  if (input.title !== undefined) {
    sanitized.title = validateBoundedString(input.title, 'Thread title', 1, 240)
  }
  if (input.scopeBucketId !== undefined) {
    sanitized.scopeBucketId = validateEntityId(input.scopeBucketId, 'Scope bucket ID')
  }
  if (input.titleSource !== undefined) {
    sanitized.titleSource = validateThreadTitleSource(input.titleSource)
  }
  if (input.providerId !== undefined) {
    sanitized.providerId = validateEntityId(input.providerId, 'Provider ID')
  }
  if (input.workingDirectory !== undefined) {
    sanitized.workingDirectory = validateBoundedString(
      input.workingDirectory,
      'Working directory',
      0,
      4096
    )
  }
  if (input.lastActivity !== undefined) {
    sanitized.lastActivity = validateBoundedInteger(
      input.lastActivity,
      'Last activity',
      1,
      Date.now() + 86_400_000
    )
  }
  if (input.read !== undefined) {
    sanitized.read = validateBoolean(input.read, 'Read')
  }

  return sanitized
}

export function validateScopeBoard(value: unknown): ScopeBoard {
  const board = assertRecord(value, 'Scope board')
  rejectUnknownFields(board, new Set(['version', 'buckets', 'worktreeDefaults']), 'scope board')
  if (board.version !== 2) {
    throw new TypeError('Scope board version must be 2')
  }
  if (!Array.isArray(board.buckets)) {
    throw new TypeError('Scope board buckets must be an array')
  }

  const ids = new Set<string>()
  const buckets = board.buckets.map((value, index) => {
    const bucket = assertRecord(value, `Scope bucket ${index + 1}`)
    rejectUnknownFields(
      bucket,
      new Set([
        'id',
        'name',
        'color',
        'iconType',
        'sortOrder',
        'collapsed',
        'collapsedSlices',
        'root',
        'archivedAt'
      ]),
      'scope bucket'
    )
    const id = validateEntityId(bucket.id, 'Scope bucket ID')
    if (ids.has(id)) throw new TypeError(`Duplicate scope bucket ID: ${id}`)
    ids.add(id)
    const name = validateBoundedString(bucket.name, 'Scope bucket name', 1, 120)
    let color: string | undefined
    if (bucket.color !== undefined) {
      if (typeof bucket.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(bucket.color)) {
        throw new TypeError('Scope color must be a hex colour string (e.g. #ef4444)')
      }
      color = bucket.color
    }
    const iconType =
      bucket.iconType === undefined
        ? undefined
        : validateBoundedString(bucket.iconType, 'Scope icon type', 1, 50)
    if (
      typeof bucket.sortOrder !== 'number' ||
      !Number.isSafeInteger(bucket.sortOrder) ||
      bucket.sortOrder < 0
    ) {
      throw new TypeError('Scope bucket sort order must be a non-negative integer')
    }
    const collapsed = validateBoolean(bucket.collapsed, 'Scope bucket collapsed')
    if (!Array.isArray(bucket.collapsedSlices)) {
      throw new TypeError('Collapsed scope slices must be an array')
    }
    const collapsedSlices = bucket.collapsedSlices.flatMap((slice): ScopeSlice[] => {
      if (slice === 'stale') return []
      if (typeof slice !== 'string' || !SCOPE_SLICES.has(slice as ScopeSlice)) {
        throw new TypeError(`Unsupported scope slice: ${String(slice)}`)
      }
      return [slice as ScopeSlice]
    })
    if (new Set(collapsedSlices).size !== collapsedSlices.length) {
      throw new TypeError('Collapsed scope slices must be unique')
    }
    const root = validateRootDescriptor(bucket.root)
    let archivedAt: number | undefined
    if (bucket.archivedAt !== undefined) {
      archivedAt = validateBoundedInteger(
        bucket.archivedAt,
        'Scope archived timestamp',
        0,
        Number.MAX_SAFE_INTEGER
      )
    }
    if (id === 'default') {
      if (root.kind !== 'project') {
        throw new TypeError('The Default scope must remain project-rooted')
      }
      if (archivedAt !== undefined) {
        throw new TypeError('The Default scope cannot be archived')
      }
    }
    return {
      id,
      name,
      ...(color ? { color } : {}),
      ...(iconType ? { iconType } : {}),
      sortOrder: bucket.sortOrder,
      collapsed,
      collapsedSlices,
      root,
      ...(archivedAt === undefined ? {} : { archivedAt })
    }
  })

  if (!ids.has('default')) {
    throw new TypeError('Scope board must contain the Default bucket')
  }

  return {
    version: 2,
    buckets,
    worktreeDefaults: validateWorktreeDefaults(board.worktreeDefaults)
  }
}

const HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu

/**
 * Validate a list of hostnames used for favicon resolution. Each entry must be
 * a bounded, hostname-shaped string with no scheme, path, port, or control
 * characters. Deduplicates preserving first occurrence.
 */
export function validateFaviconHostnames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('Favicon hostnames must be an array')
  if (value.length === 0 || value.length > 64) {
    throw new TypeError('Favicon hostnames must contain between 1 and 64 entries')
  }
  const hostnames: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > 253 ||
      entry.includes('\0') ||
      entry.includes('\n') ||
      entry.includes('\r') ||
      !HOSTNAME_PATTERN.test(entry)
    ) {
      throw new TypeError(`Favicon hostname at index ${index} is invalid`)
    }
    const normalized = entry.toLowerCase()
    if (!hostnames.includes(normalized)) hostnames.push(normalized)
  }
  return hostnames
}

// ─── Privileged-IPC validation wrapper ──────────────────────────────────────

const WEB_PROTOCOLS = new Set(['https:', 'http:'])
const MAX_EXTERNAL_URL_LENGTH = 8192
const MAX_SCOPED_PATH_LENGTH = 16_384

/** True when the string contains a control character (C0, DEL). */
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Resolve the origin of a URL, or null when it cannot be parsed. */
export function originOfUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    // The URL spec serializes `file:` origins as the literal string "null";
    // normalize them to the scheme so trusted-file origins can be matched.
    return parsed.protocol === 'file:' ? 'file://' : parsed.origin
  } catch {
    return null
  }
}

/** Whether a URL's origin is contained in the trusted set. */
export function isTrustedOrigin(url: string, trustedOrigins: ReadonlySet<string>): boolean {
  const origin = originOfUrl(url)
  return origin !== null && trustedOrigins.has(origin)
}

/** Resolvers for the local-file scopes that reveal/preview operations may target. */
export interface PrivilegedScopeResolvers {
  /** Registered local project root directories, resolved lazily. */
  projectRoots: () => Promise<readonly string[]> | readonly string[]
  /** Concrete app-owned artifact directories (per project) that reveal/preview
   *  may target — never the whole config root, which holds secrets. */
  appArtifactRoots: () => Promise<readonly string[]> | readonly string[]
  /** Exact canonical files previously persisted as user-authored attachments. */
  isApprovedFile?: (canonicalPath: string) => Promise<boolean> | boolean
}

export class ScopedPathError extends TypeError {
  constructor(
    readonly code: 'missing' | 'out_of_scope',
    message: string
  ) {
    super(message)
    this.name = 'ScopedPathError'
  }
}

export function isMissingScopedPathError(error: unknown): boolean {
  return error instanceof ScopedPathError && error.code === 'missing'
}

export interface PrivilegedIpcValidatorOptions {
  /** Exact URLs the app's own renderer document lives at. Privileged IPC and
   *  main-frame navigation are bound to these URLs, not to URL origins alone,
   *  so packaged foreign `file:` documents can never be reached. */
  navigationTargets?: Iterable<string>
  /** Resolvers for the file scopes reveal/preview operations may target. */
  scopes?: PrivilegedScopeResolvers
  /** Retained for compatibility with callers; HTTP external links are supported in all builds. */
  allowDevelopmentHttp?: boolean
}

/** Minimal structural view of a frame for identity checks. */
export interface FrameIdentity {
  url: string
  parent?: FrameIdentity | null
}

/** A frame that can be checked for a trusted main-frame identity. */
export type TrustedFrameCandidate = FrameIdentity | WebFrameMain

/**
 * Shared privileged-IPC validation wrapper. Every renderer-exposed operation
 * that can open the system browser, reveal files, or read local files goes
 * through this single boundary so sender frames, external URLs, and local
 * paths are validated consistently across the main process.
 */
export class PrivilegedIpcValidator {
  readonly #navigationTargets: ReadonlySet<string>
  readonly #scopes: PrivilegedScopeResolvers | undefined
  readonly #userSelectedFiles = new Set<string>()
  readonly #userSelectedRoots = new Set<string>()

  constructor(options: PrivilegedIpcValidatorOptions) {
    this.#navigationTargets = new Set(
      [...(options.navigationTargets ?? [])]
        .map((url) => this.#normalizeUrl(url))
        .filter((url): url is string => url !== null)
    )
    this.#scopes = options.scopes
  }

  /**
   * Whether the IPC sender frame is the app's own trusted main frame. Only the
   * top-level frame (no parent) may invoke privileged IPC, and its document URL
   * must exactly match one of the app's own renderer URLs — never a foreign or
   * arbitrary same-origin document.
   */
  isTrustedSenderFrame(frame: TrustedFrameCandidate | null | undefined): boolean {
    if (!frame || typeof frame.url !== 'string' || frame.url.length === 0) return false
    if (frame.parent != null) return false
    return this.#isTrustedRendererUrl(frame.url)
  }

  /** Reject a privileged IPC call whose sender frame is not trusted. */
  assertTrustedSender(
    event: { senderFrame?: TrustedFrameCandidate | null } | null | undefined
  ): void {
    if (!this.isTrustedSenderFrame(event?.senderFrame)) {
      throw new Error('Privileged IPC rejected: sender frame is not trusted')
    }
  }

  /**
   * Validate a URL for `shell.openExternal` / window-open. Parsed web URLs are
   * permitted over either `https:` or `http:`; credentials, control characters,
   * malformed input, and non-web schemes are rejected. Returns the normalized
   * URL.
   */
  validateExternalUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EXTERNAL_URL_LENGTH) {
      throw new TypeError('External URL must be a string of at most 8192 characters')
    }
    if (containsControlCharacter(value)) {
      throw new TypeError('External URL must not contain control characters')
    }
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new TypeError('External URL is malformed')
    }
    if (!WEB_PROTOCOLS.has(parsed.protocol)) {
      throw new TypeError(`External URL scheme "${parsed.protocol}" is not supported`)
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new TypeError('External URL must not contain credentials')
    }
    return parsed.toString()
  }

  /**
   * Whether the main frame may navigate to the given URL. Only the exact
   * canonical app renderer document is navigable, so arbitrary same-origin or
   * `file:` targets are never reachable.
   */
  isTrustedNavigation(url: string): boolean {
    return this.#isTrustedRendererUrl(url)
  }

  #isTrustedRendererUrl(url: string): boolean {
    const normalized = this.#normalizeUrl(url)
    return normalized !== null && this.#navigationTargets.has(normalized)
  }

  #normalizeUrl(url: string): string | null {
    try {
      return new URL(url).href
    } catch {
      return null
    }
  }

  /** Record a file the user explicitly selected through an OS dialog. The
   *  canonical (symlink-resolved) path is what grants preview/reveal, so a
   *  later swap to a symlink can never widen the grant. */
  async registerUserSelectedFile(path: string): Promise<void> {
    const canonical = await this.#canonicalizeIfExists(path)
    if (canonical) this.#userSelectedFiles.add(canonical)
  }

  /** Record a directory the user explicitly selected through an OS dialog. */
  async registerUserSelectedRoot(path: string): Promise<void> {
    const canonical = await this.#canonicalizeIfExists(path)
    if (canonical) this.#userSelectedRoots.add(canonical)
  }

  /**
   * Validate a local path for file preview/reveal. The candidate must be a
   * bounded absolute path (or `file://` URL) free of control characters that,
   * after symlink resolution, lives inside a registered project root, a
   * concrete app-owned artifact root, or a user-selected directory, or exactly
   * matches a user-selected file (by canonical path only). Returns the
   * canonical path.
   */
  async resolveScopedPath(value: unknown): Promise<string> {
    const candidate = this.#decodeCandidatePath(value)
    const canonical = await this.#canonicalize(candidate)
    if (this.#userSelectedFiles.has(canonical)) return canonical
    if (await this.#scopes?.isApprovedFile?.(canonical)) return canonical
    const scopes = await this.#resolveScopes()
    for (const scope of scopes) {
      if (isWithinRoot(scope, canonical)) return canonical
    }
    throw new ScopedPathError(
      'out_of_scope',
      'Path is outside the approved project or user-selected scopes'
    )
  }

  #decodeCandidatePath(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SCOPED_PATH_LENGTH) {
      throw new TypeError('Path must be a string of at most 16384 characters')
    }
    if (containsControlCharacter(value)) {
      throw new TypeError('Path must not contain control characters')
    }
    const decoded = value.startsWith('file://') ? this.#fileUrlToPath(value) : value
    if (!isAbsolute(decoded)) {
      throw new TypeError('Path must be absolute')
    }
    return resolve(decoded)
  }

  #fileUrlToPath(value: string): string {
    try {
      return fileURLToPath(value)
    } catch {
      throw new TypeError('Path is not a valid file URL')
    }
  }

  async #canonicalizeIfExists(path: string): Promise<string | null> {
    try {
      return await realpath(path)
    } catch {
      return null
    }
  }

  async #canonicalize(path: string): Promise<string> {
    try {
      return await realpath(path)
    } catch {
      throw new ScopedPathError('missing', 'Path does not resolve to an existing file or directory')
    }
  }

  async #resolveScopes(): Promise<string[]> {
    if (!this.#scopes) return []
    const [projectRoots, artifactRoots] = await Promise.all([
      this.#scopes.projectRoots(),
      this.#scopes.appArtifactRoots()
    ])
    const candidates = [...projectRoots, ...artifactRoots, ...this.#userSelectedRoots].filter(
      (root) => typeof root === 'string' && root.length > 0
    )
    const resolved: string[] = []
    for (const root of candidates) {
      try {
        resolved.push(await realpath(root))
      } catch {
        // A root that no longer exists can grant no scope.
      }
    }
    return resolved
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  )
}
