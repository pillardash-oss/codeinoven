import type {
  ChecklistItemStatus,
  CreateProjectInput,
  CreateThreadInput,
  HistoryRole,
  InferenceMode,
  ThreadSettings,
  ThreadStatus,
  ThreadTitleSource
} from '../../../lib/types'
import {
  assertEnum,
  assertRecord,
  rejectUnknownFields,
  validateBoundedInteger,
  validateBoundedString,
  validateBoolean,
  validateEntityId
} from './primitives'

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
  'accountId',
  'modelId',
  'titleMode',
  'thinkingLevel',
  'inferenceMode',
  'permissionLevel',
  'assignmentMode',
  'loopMode',
  'reportToCoordinator',
  'fileSystemMode',
  'loopAuditor',
  'imageDescriptor',
  'imageDescriptorFallback'
])
const AGENT_MODEL_SELECTION_FIELDS = new Set([
  'harnessId',
  'providerId',
  'modelId',
  'accountId',
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
  'id',
  'projectId',
  'providerId',
  'title',
  'workingDirectory',
  'settings',
  'titleSource',
  'scopeBucketId'
])

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
  // Settings persisted before the legacy `engineeringMode` flag was scrubbed
  // still carry it   tolerate and drop it instead of rejecting the payload.
  const { engineeringMode: _legacyEngineeringMode, ...rest } = input
  rejectUnknownFields(rest, THREAD_SETTINGS_FIELDS, 'thread settings')

  const settings: ThreadSettings = {
    harnessId: validateEntityId(input.harnessId, 'Harness ID'),
    providerId: validateBoundedString(input.providerId, 'Provider ID', 0, 128),
    modelId: validateBoundedString(input.modelId, 'Model ID', 0, 256),
    thinkingLevel: assertEnum(input.thinkingLevel, THINKING_LEVELS, 'thinking level'),
    permissionLevel: assertEnum(input.permissionLevel, PERMISSION_LEVELS, 'permission level'),
    assignmentMode:
      input.assignmentMode === undefined
        ? false
        : validateBoolean(input.assignmentMode, 'Assignment'),
    loopMode: input.loopMode === undefined ? false : validateBoolean(input.loopMode, 'Achievement')
  }
  if (input.accountId !== undefined) {
    settings.accountId = validateEntityId(input.accountId, 'Account ID', 256)
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
  if (input.reportToCoordinator !== undefined) {
    settings.reportToCoordinator = validateBoolean(
      input.reportToCoordinator,
      'Worker report to the Sr. Engineer'
    )
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
      ...(auditor.accountId === undefined
        ? {}
        : {
            accountId: validateEntityId(auditor.accountId, 'Achievement auditor account ID', 256)
          }),
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
      ...(descriptor.accountId === undefined
        ? {}
        : {
            accountId: validateEntityId(descriptor.accountId, 'Image descriptor account ID', 256)
          }),
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
  if (input.imageDescriptorFallback !== undefined) {
    const descriptor = assertRecord(input.imageDescriptorFallback, 'Image descriptor fallback')
    rejectUnknownFields(descriptor, AGENT_MODEL_SELECTION_FIELDS, 'image descriptor fallback')
    settings.imageDescriptorFallback = {
      harnessId: validateEntityId(descriptor.harnessId, 'Image descriptor fallback harness ID'),
      providerId: validateBoundedString(
        descriptor.providerId,
        'Image descriptor fallback provider ID',
        1,
        128
      ),
      modelId: validateBoundedString(
        descriptor.modelId,
        'Image descriptor fallback model ID',
        1,
        256
      ),
      ...(descriptor.accountId === undefined
        ? {}
        : {
            accountId: validateEntityId(
              descriptor.accountId,
              'Image descriptor fallback account ID',
              256
            )
          }),
      ...(descriptor.thinkingLevel === undefined
        ? {}
        : {
            thinkingLevel: assertEnum(
              descriptor.thinkingLevel,
              THINKING_LEVELS,
              'image descriptor fallback thinking level'
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
    ...(input.id !== undefined ? { id: validateEntityId(input.id, 'Thread ID') } : {}),
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
    import('../../../lib/types').Thread,
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
      import('../../../lib/types').Thread,
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
