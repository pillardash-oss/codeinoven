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
} from '../lib/types'

const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const THREAD_STATUSES = new Set<ThreadStatus>([
  'created',
  'planning',
  'awaiting_approval',
  'executing',
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
  'thinkingLevel',
  'inferenceMode',
  'permissionLevel',
  'engineeringMode',
  'assignmentMode',
  'loopMode',
  'fileSystemMode',
  'loopAuditor'
])
const AGENT_MODEL_SELECTION_FIELDS = new Set(['harnessId', 'providerId', 'modelId'])
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

const SCOPE_SLICES = new Set<ScopeSlice>(['todo', 'working', 'issue', 'unread', 'done', 'pinned'])

export function validateScopeSlice(value: unknown): ScopeSlice {
  if (typeof value !== 'string' || !SCOPE_SLICES.has(value as ScopeSlice)) {
    throw new TypeError('Invalid scope slice')
  }
  return value as ScopeSlice
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
      modelId: validateBoundedString(auditor.modelId, 'Achievement auditor model ID', 1, 256)
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
    import('../lib/types').Thread,
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
      import('../lib/types').Thread,
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
  rejectUnknownFields(board, new Set(['version', 'buckets']), 'scope board')
  if (board.version !== 1) {
    throw new TypeError('Scope board version must be 1')
  }
  if (!Array.isArray(board.buckets)) {
    throw new TypeError('Scope board buckets must be an array')
  }

  const ids = new Set<string>()
  const buckets = board.buckets.map((value, index) => {
    const bucket = assertRecord(value, `Scope bucket ${index + 1}`)
    rejectUnknownFields(
      bucket,
      new Set(['id', 'name', 'color', 'iconType', 'sortOrder', 'collapsed', 'collapsedSlices']),
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
    return {
      id,
      name,
      ...(color ? { color } : {}),
      ...(iconType ? { iconType } : {}),
      sortOrder: bucket.sortOrder,
      collapsed,
      collapsedSlices
    }
  })

  if (!ids.has('default')) {
    throw new TypeError('Scope board must contain the Default bucket')
  }

  return { version: 1, buckets }
}
