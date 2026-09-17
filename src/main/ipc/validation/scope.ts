import { isAbsolute, posix, win32 } from 'path'
import type { ScopeBoard, ScopeSlice } from '../../../lib/types'
import {
  assertEnum,
  assertRecord,
  rejectUnknownFields,
  validateBoundedInteger,
  validateBoundedString,
  validateBoolean,
  validateEntityId
} from './primitives'
import { validateBranchName } from './git'

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
const SCOPE_ENVIRONMENT_MODES = new Set<import('../../../lib/types').ScopeEnvironmentMode>([
  'copy',
  'symlink'
])
const SCOPE_SETUP_STATES = new Set<import('../../../lib/types').ScopeSetupStatusState>([
  'not_run',
  'running',
  'succeeded',
  'failed',
  'interrupted',
  'stale'
])
const SCOPE_SETUP_COMMAND_STATES = new Set<import('../../../lib/types').ScopeSetupCommandState>([
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
export function validateScopeTarget(value: unknown): import('../../../lib/types').ScopeTarget {
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
): import('../../../lib/types').ScopeSetupCommandSpec {
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
): import('../../../lib/types').ScopeSetupCommandSpec[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError('Setup commands must be an array of at most 64 entries')
  }
  return value.map((entry) => validateSetupCommandSpec(entry))
}

export function validateEnvironmentMode(
  value: unknown
): import('../../../lib/types').ScopeEnvironmentMode {
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

const SCOPE_LIFECYCLE_ACTIONS = new Set<import('../../../lib/types').ScopeLifecycleAction>([
  'detach',
  'remove-worktree',
  'delete-scope',
  'delete-branch',
  'delete-project-worktrees'
])

export function validateScopeLifecycleAction(
  value: unknown
): import('../../../lib/types').ScopeLifecycleAction {
  return assertEnum(value, SCOPE_LIFECYCLE_ACTIONS, 'scope lifecycle action')
}

const SCOPE_MERGE_MODES = new Set<import('../../../lib/types').ScopeMergeMode>([
  'merge-delete',
  'merge-keep',
  'merge-move-to-default'
])

export function validateScopeMergeMode(
  value: unknown
): import('../../../lib/types').ScopeMergeMode {
  return assertEnum(value, SCOPE_MERGE_MODES, 'scope merge mode')
}

/** Validate the renderer input for managed-worktree creation. */
export function validateScopeWorktreeCreateInput(
  value: unknown
): import('../../../lib/types').ScopeWorktreeCreateInput {
  const input = assertRecord(value, 'Scope worktree create input')
  rejectUnknownFields(
    input,
    new Set(['title', 'runSetup', 'environmentMode', 'baseBranch', 'setupCommands']),
    'scope worktree create input'
  )
  return {
    title: validateBoundedString(input.title, 'Scope title', 1, 120),
    runSetup: validateBoolean(input.runSetup, 'Run setup'),
    environmentMode: validateEnvironmentMode(input.environmentMode),
    ...(input.baseBranch === undefined
      ? {}
      : { baseBranch: validateBranchName(input.baseBranch, 'Source branch') }),
    ...(input.setupCommands === undefined
      ? {}
      : { setupCommands: validateSetupCommandSpecs(input.setupCommands) })
  }
}

export function validateConfirmationToken(value: unknown): string {
  const token = validateBoundedString(value, 'Confirmation token', 1, 128)
  if (!/^[0-9a-f]{32}$/u.test(token)) {
    throw new TypeError('Confirmation token is malformed')
  }
  return token
}

/** Validate an absolute filesystem path supplied for worktree adoption. */
export function validateSourcePath(value: unknown): string {
  const sourcePath = validateBoundedString(value, 'Worktree path', 1, 4096)
  const trimmed = sourcePath.trim()
  const absolute =
    process.platform === 'win32'
      ? win32.isAbsolute(trimmed) || posix.isAbsolute(trimmed)
      : posix.isAbsolute(trimmed)
  if (!absolute) {
    throw new TypeError('Worktree path must be absolute')
  }
  if (trimmed.includes('\0')) {
    throw new TypeError('Worktree path must not contain control characters')
  }
  return trimmed
}

/** Validate the renderer input for adopting an existing Git worktree. */
export function validateScopeAdoptInput(value: unknown): {
  sourcePath: string
  runSetup: boolean
} {
  const input = assertRecord(value, 'Scope worktree adopt input')
  rejectUnknownFields(input, new Set(['sourcePath', 'runSetup']), 'scope worktree adopt input')
  return {
    sourcePath: validateSourcePath(input.sourcePath),
    runSetup: validateBoolean(input.runSetup, 'Run setup')
  }
}

/** Validate a full scope ordering for the layout operation. */
export function validateScopeOrderIds(value: unknown): string[] {
  return validateStringArray(value, 'Scope order', 1, 256, 256)
}

/** Validate a display-metadata patch for one scope bucket. */
export function validateScopeAppearancePatch(
  value: unknown
): import('../../../lib/types').ScopeAppearancePatch {
  const input = assertRecord(value, 'Scope appearance patch')
  rejectUnknownFields(input, new Set(['name', 'color', 'iconType']), 'scope appearance patch')
  const patch: import('../../../lib/types').ScopeAppearancePatch = {}
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
): import('../../../lib/types').ScopeCollapsePatch {
  const input = assertRecord(value, 'Scope collapse patch')
  rejectUnknownFields(input, new Set(['collapsed', 'collapsedSlices']), 'scope collapse patch')
  const patch: import('../../../lib/types').ScopeCollapsePatch = {}
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
): import('../../../lib/types').ScopeCreateInput {
  const input = assertRecord(value, 'Scope create input')
  rejectUnknownFields(input, new Set(['name', 'color', 'iconType']), 'scope create input')
  const sanitized: import('../../../lib/types').ScopeCreateInput = {
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
): import('../../../lib/types').ScopeWorktreeDefaults {
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

function validateSetupStatus(value: unknown): import('../../../lib/types').ScopeSetupStatus {
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
    (entry, index): import('../../../lib/types').ScopeSetupCommandRecord => {
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
      const result: import('../../../lib/types').ScopeSetupCommandRecord = {
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
  const status: import('../../../lib/types').ScopeSetupStatus = { state, commands }
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

function validateRootDescriptor(value: unknown): import('../../../lib/types').ScopeRootDescriptor {
  const input = assertRecord(value, 'Scope root descriptor')
  if (input.kind === 'project') {
    rejectUnknownFields(input, new Set(['kind']), 'scope root descriptor')
    return { kind: 'project' } satisfies import('../../../lib/types').ProjectRootDescriptor
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
    } satisfies import('../../../lib/types').ManagedWorktreeDescriptor
  }
  throw new TypeError(`Unsupported scope root kind: ${String(input.kind)}`)
}

export function validateScopeSlice(value: unknown): ScopeSlice {
  if (typeof value !== 'string' || !SCOPE_SLICES.has(value as ScopeSlice)) {
    throw new TypeError('Invalid scope slice')
  }
  return value as ScopeSlice
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
