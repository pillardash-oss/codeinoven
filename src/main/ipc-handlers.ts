import { app, ipcMain, dialog, shell, clipboard, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile, mkdtemp, mkdir, stat } from 'fs/promises'
import { tmpdir, release } from 'os'
import { basename, dirname, extname, join } from 'path'
import { APP_NAME, APP_SLUG } from '../lib/brand'
import type { Database } from './database/database'
import { StorageEngine } from './storage-engine'
import { Logger } from './logger'
import { EditorService } from './editor-service'
import { RepositoryService } from './repository-service'
import { GitService } from './git-service'
import { SecretVault } from './secret-vault'
import { GitHubAuthService } from './github-auth-service'
import { GitHubProvider } from './providers/github-provider'
import type { GitProvider } from './git-provider.interface'
import { ProjectFilesService } from './project-files-service'
import { CheckpointManager } from './checkpoint-manager'
import { DiagnosticsService } from './diagnostics-service'
import { resolveFavicons } from './favicon-service'
import { MemoryService, validateMemoryConfig } from './memory-service'
import { harnessLoadsAgentsMd } from './harness-registry'
import type { HarnessManifestService } from './harness-manifest-service'
import { SpecContextService } from './spec-context-service'
import type { UpdaterService } from './updater-service'
import type { ChatEngine } from './chat-engine'
import type { PowerWakeService } from './power-wake-service'
import type { RetrySchedulerService } from './retry-scheduler-service'
import { broadcastThreadUpdate, dismissThreadNotifications } from './thread-events'
import { parseThreadContextUsage } from './database/repositories/thread-repo'
import {
  validateBoundedInteger,
  validateBoundedString,
  validateBoolean,
  validateBranchName,
  validateChecklistItemStatus,
  validateCommitMessage,
  validateCreateProjectInput,
  validateCreateThreadInput,
  validateEntityId,
  validateGitIdentity,
  validateGitPathArray,
  validateGitRelativePath,
  validateGitResetMode,
  validateHistoryRole,
  validateMergeMethod,
  validateMergeTarget,
  validatePrCreateInput,
  validatePrNumber,
  validatePrState,
  validatePrPage,
  validatePrReviewEvent,
  validatePrCommentBody,
  validatePushOptions,
  validateRemoteName,
  validateRemoteUrl,
  validateFaviconHostnames,
  validateScopeBoard,
  validateScopeSlice,
  validateStashMessage,
  validateStashId,
  validateThreadSettings,
  validateThreadStatus,
  validateThreadUpdateInput,
  PrivilegedIpcValidator,
  originOfUrl
} from './ipc-validation'
import { ProjectManager } from '../lib/engines/project-manager'
import { ThreadManager } from '../lib/engines/thread-manager'
import { ScopeManager } from '../lib/engines/scope-manager'
import { HistoryEngine } from '../lib/engines/history-engine'
import { PlanEngine } from '../lib/engines/plan-engine'
import {
  SpecEngine,
  type AddSpecAnnotationInput,
  type NewSpecProvenance
} from '../lib/engines/spec-engine'
import {
  BrainstormEngine,
  type AddBrainstormAnnotationInput,
  type NewBrainstormProvenance
} from '../lib/engines/brainstorm-engine'
import { AuditEngine, type AddAuditAnnotationInput } from '../lib/engines/audit-engine'
import {
  AssignmentEngine,
  type AddAssignmentAnnotationInput
} from '../lib/engines/assignment-engine'
import { validateAuditReportContent } from '../lib/audit/audit-validation'
import { exportAuditReportMarkdown } from '../lib/audit/audit-markdown'
import { exportAssignmentMarkdown } from '../lib/assignment/assignment-markdown'
import { validateAssignment } from '../lib/assignment/assignment-validation'
import {
  exportEngineeringSpecMarkdown,
  importEngineeringSpecMarkdown
} from '../lib/spec/spec-markdown'
import { validateEngineeringSpec } from '../lib/spec/spec-validation'
import { parseGeneratedBrainstormContent } from '../lib/brainstorm/brainstorm-validation'
import { exportBrainstormMarkdown } from '../lib/brainstorm/brainstorm-markdown'
import { atomicWrite, getConfigRoot } from '../lib/utils'
import { normalizeWorkerNames } from '../lib/assignment/worker-names'
import type {
  AppConfig,
  AppConfigPatch,
  AgentDefaultsConfig,
  AgentModelSelection,
  AgentRole,
  AssignmentModelSelection,
  AssignmentPhase,
  AssignmentPlanContent,
  AssignmentProvenance,
  AssignmentTask,
  BrainstormEntryChoice,
  BrainstormSectionId,
  CapturableSpecContextType,
  CreateProjectInput,
  EngineeringSpec,
  EngineeringSpecContent,
  AuditSectionId,
  HistoryEntry,
  EditorId,
  MemoryEntry,
  SpecContextReference,
  SpecSectionId,
  SpecValidationCode,
  SpecValidationIssue,
  ThreadMessageCursor
} from '../lib/types'

type NewAssignmentProvenance = Omit<AssignmentProvenance, 'createdAt' | 'parentVersion'>

const THEMES = new Set(['light', 'dark', 'system'])
/** Pull requests fetched per sidebar page. */
const PR_PAGE_SIZE = 20
const SLASH_COMMAND_MODES = new Set(['app', 'passthrough'])
const EDITOR_IDS = new Set<EditorId>([
  'system',
  'terminal',
  'iterm2',
  'ghostty',
  'cmux',
  'warp',
  'kitty',
  'alacritty',
  'vscode',
  'cursor',
  'zed',
  'webstorm',
  'idea'
])
const CONFIG_PATCH_FIELDS = new Set([
  'theme',
  'threadLimit',
  'questionTimeoutMs',
  'slashCommandMode',
  'preferredEditor',
  'memory',
  'agentDefaults',
  'autoDownloadUpdates',
  'autoInstallUpdates',
  'updateChannel',
  'keepAwakeWhileWorking',
  'imageDescriptorAskAgain',
  'autoRetryAfterReset'
])
const SPEC_SECTIONS = new Set<SpecSectionId>([
  'problem',
  'resolution',
  'success_criteria',
  'test_strategy',
  'documentation',
  'additional_info',
  'commit_pattern',
  'constraints_risks'
])
const SPEC_VALIDATION_CODES = new Set<SpecValidationCode>([
  'required',
  'invalid_path',
  'missing_evidence',
  'duplicate_id'
])
const SPEC_PROVENANCE_SOURCES = new Set(['manual', 'agent', 'brainstorm', 'markdown_import'])
const SPEC_CONTEXT_TYPES = new Set(['project_file', 'attachment', 'project_rule', 'memory'])
const BRAINSTORM_SECTIONS = new Set<BrainstormSectionId>([
  'context',
  'goals',
  'decisions',
  'open_questions',
  'constraints',
  'proposed_direction',
  'additional_info'
])
const AUDIT_SECTIONS = new Set<AuditSectionId>([
  'executive_summary',
  'findings',
  'resolution_recommendation',
  'conclusion'
])
const AGENT_ROLES = new Set<AgentRole>(['seniorEngineer', 'worker', 'auditor'])
const AGENT_DEFAULT_FIELDS = new Set([
  'seniorEngineer',
  'worker',
  'auditor',
  'imageDescriptor',
  'syncFromThreadChanges'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Origins the renderer may invoke privileged IPC from: the development server
 * origin while running unpackaged against `ELECTRON_RENDERER_URL`, otherwise
 * the packaged `file://` renderer origin.
 */
function computeTrustedRendererOrigins(): string[] {
  const isProduction = app.isPackaged || process.env['NODE_ENV'] === 'production'
  if (!isProduction && process.env['ELECTRON_RENDERER_URL']) {
    const origin = originOfUrl(process.env['ELECTRON_RENDERER_URL'])
    if (origin) return [origin]
  }
  return ['file://']
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${label} must be a${allowEmpty ? '' : ' non-empty'} string`)
  }
  return value
}

function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Specification version must be a positive safe integer')
  }
  return value
}

function validateAgentModelSelection(value: unknown, label: string): AgentModelSelection {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  const fields = new Set(['harnessId', 'providerId', 'modelId'])
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`Unsupported ${label} field: ${field}`)
  }
  return {
    harnessId: requireString(value.harnessId, `${label} harness ID`),
    providerId: requireString(value.providerId, `${label} provider ID`),
    modelId: requireString(value.modelId, `${label} model ID`)
  }
}

function validateAgentDefaults(value: unknown): AgentDefaultsConfig {
  if (!isRecord(value)) throw new TypeError('Agent defaults must be an object')
  for (const field of Object.keys(value)) {
    if (!AGENT_DEFAULT_FIELDS.has(field)) {
      throw new TypeError(`Unsupported agent defaults field: ${field}`)
    }
  }
  if (typeof value.syncFromThreadChanges !== 'boolean') {
    throw new TypeError('Agent default thread synchronization must be a boolean')
  }
  return {
    syncFromThreadChanges: value.syncFromThreadChanges,
    ...(value.seniorEngineer === undefined
      ? {}
      : {
          seniorEngineer: validateAgentModelSelection(value.seniorEngineer, 'Sr. Engineer default')
        }),
    ...(value.worker === undefined
      ? {}
      : { worker: validateAgentModelSelection(value.worker, 'Worker default') }),
    ...(value.auditor === undefined
      ? {}
      : { auditor: validateAgentModelSelection(value.auditor, 'Auditor default') }),
    ...(value.imageDescriptor === undefined
      ? {}
      : {
          imageDescriptor: validateAgentModelSelection(
            value.imageDescriptor,
            'Image descriptor default'
          )
        })
  }
}

function validateStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value.map((item, index) => requireString(item, `${label}[${index}]`, true))
}

function validateAssignmentModel(
  value: unknown,
  label: string
): AssignmentModelSelection | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  const thinkingLevel = requireString(value.thinkingLevel, `${label} thinking level`)
  if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(thinkingLevel)) {
    throw new TypeError(`${label} thinking level is invalid`)
  }
  return {
    harnessId: requireString(value.harnessId, `${label} harness ID`),
    providerId: requireString(value.providerId, `${label} provider ID`),
    modelId: requireString(value.modelId, `${label} model ID`),
    thinkingLevel: thinkingLevel as AssignmentModelSelection['thinkingLevel']
  }
}

function validateAssignmentContent(value: unknown): AssignmentPlanContent {
  if (!isRecord(value)) throw new TypeError('Assignment content must be an object')
  if (!Array.isArray(value.phases) || !Array.isArray(value.tasks)) {
    throw new TypeError('Assignment phases and tasks must be arrays')
  }
  const phases: AssignmentPhase[] = value.phases.map((phase, index) => {
    if (!isRecord(phase)) throw new TypeError(`Assignment phase ${index} must be an object`)
    return {
      id: requireString(phase.id, `Assignment phase ${index} ID`),
      title: requireString(phase.title, `Assignment phase ${index} title`),
      description: requireString(phase.description, `Assignment phase ${index} description`),
      ...(typeof phase.info === 'string' ? { info: phase.info } : {}),
      ...(phase.defaultModel === undefined
        ? {}
        : {
            defaultModel: validateAssignmentModel(
              phase.defaultModel,
              `Assignment phase ${index} model`
            )
          })
    }
  })
  const tasks: AssignmentTask[] = value.tasks.map((task, index) => {
    if (!isRecord(task)) throw new TypeError(`Assignment task ${index} must be an object`)
    const owner = requireString(task.owner, `Assignment task ${index} owner`)
    if (owner !== 'senior' && owner !== 'worker') {
      throw new TypeError(`Assignment task ${index} owner is invalid`)
    }
    return {
      id: requireString(task.id, `Assignment task ${index} ID`),
      phaseId: requireString(task.phaseId, `Assignment task ${index} phase ID`),
      title: requireString(task.title, `Assignment task ${index} title`),
      description: requireString(task.description, `Assignment task ${index} description`),
      ...(typeof task.info === 'string' ? { info: task.info } : {}),
      prompt: requireString(task.prompt, `Assignment task ${index} prompt`),
      owner,
      dependsOn: validateStringArray(task.dependsOn, `Assignment task ${index} dependencies`),
      expectedFiles: validateStringArray(
        task.expectedFiles,
        `Assignment task ${index} expected files`
      ),
      auditChecklist: validateStringArray(
        task.auditChecklist,
        `Assignment task ${index} audit checklist`
      ),
      ...(task.model === undefined
        ? {}
        : { model: validateAssignmentModel(task.model, `Assignment task ${index} model`) }),
      status: 'planned'
    }
  })
  return {
    title: requireString(value.title, 'Assignment title'),
    summary: requireString(value.summary, 'Assignment summary'),
    phases,
    tasks
  }
}

function validateAssignmentProvenance(value: unknown): NewAssignmentProvenance {
  if (!isRecord(value)) throw new TypeError('Assignment provenance must be an object')
  const source = requireString(value.source, 'Assignment provenance source')
  if (source !== 'agent' && source !== 'manual') {
    throw new TypeError('Assignment provenance source is invalid')
  }
  return {
    source,
    actor: requireString(value.actor, 'Assignment provenance actor'),
    ...(typeof value.harnessId === 'string' ? { harnessId: value.harnessId } : {}),
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
    ...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {})
  }
}

function validateMemoryEntries(value: unknown): MemoryEntry[] {
  return validateMemoryConfig({ enabled: true, entries: value }).entries
}

function optionalMemoryEntityId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : validateEntityId(value, label)
}

function validateSpecContent(value: unknown): EngineeringSpecContent {
  if (!isRecord(value)) throw new TypeError('Specification content must be an object')
  if (!Array.isArray(value.phases)) throw new TypeError('Specification phases must be an array')

  const phases = value.phases.map((phase, phaseIndex) => {
    if (!isRecord(phase)) throw new TypeError(`Phase ${phaseIndex} must be an object`)
    if (!Array.isArray(phase.checkpoints) || !Array.isArray(phase.fileOperations)) {
      throw new TypeError(`Phase ${phaseIndex} checkpoints and file operations must be arrays`)
    }
    return {
      id: requireString(phase.id, `Phase ${phaseIndex} ID`, true),
      title: requireString(phase.title, `Phase ${phaseIndex} title`, true),
      objective: requireString(phase.objective, `Phase ${phaseIndex} objective`, true),
      checkpoints: phase.checkpoints.map((checkpoint, checkpointIndex) => {
        if (!isRecord(checkpoint)) {
          throw new TypeError(`Checkpoint ${phaseIndex}.${checkpointIndex} must be an object`)
        }
        return {
          id: requireString(checkpoint.id, `Checkpoint ${phaseIndex}.${checkpointIndex} ID`, true),
          description: requireString(
            checkpoint.description,
            `Checkpoint ${phaseIndex}.${checkpointIndex} description`,
            true
          ),
          evidence: requireString(
            checkpoint.evidence,
            `Checkpoint ${phaseIndex}.${checkpointIndex} evidence`,
            true
          )
        }
      }),
      fileOperations: phase.fileOperations.map((operation, operationIndex) => {
        if (!isRecord(operation)) {
          throw new TypeError(`File operation ${phaseIndex}.${operationIndex} must be an object`)
        }
        if (
          operation.operation !== 'create' &&
          operation.operation !== 'edit' &&
          operation.operation !== 'delete'
        ) {
          throw new TypeError(`File operation ${phaseIndex}.${operationIndex} is invalid`)
        }
        return {
          path: requireString(
            operation.path,
            `File operation ${phaseIndex}.${operationIndex} path`,
            true
          ),
          operation: operation.operation as 'create' | 'edit' | 'delete',
          reason: requireString(
            operation.reason,
            `File operation ${phaseIndex}.${operationIndex} reason`,
            true
          )
        }
      }),
      commit: requireString(phase.commit, `Phase ${phaseIndex} commit`, true)
    }
  })

  return {
    problem: requireString(value.problem, 'Problem', true),
    resolutionSummary: requireString(value.resolutionSummary, 'Resolution summary', true),
    phases,
    successCriteria: validateStringArray(value.successCriteria, 'Success criteria'),
    testStrategy: requireString(value.testStrategy, 'Test strategy', true),
    documentationRequirements: validateStringArray(
      value.documentationRequirements,
      'Documentation requirements'
    ),
    ...(value.additionalInfo === undefined
      ? {}
      : { additionalInfo: requireString(value.additionalInfo, 'Additional info') }),
    commitPattern: requireString(value.commitPattern, 'Commit pattern', true),
    constraints: validateStringArray(value.constraints, 'Constraints'),
    risks: validateStringArray(value.risks, 'Risks'),
    ...(value.assignment === undefined
      ? {}
      : { assignment: validateAssignmentContent(value.assignment) })
  }
}

function validateProvenance(value: unknown): NewSpecProvenance {
  if (!isRecord(value)) throw new TypeError('Specification provenance must be an object')
  if (typeof value.source !== 'string' || !SPEC_PROVENANCE_SOURCES.has(value.source)) {
    throw new TypeError('Invalid specification provenance source')
  }
  return {
    source: value.source as NewSpecProvenance['source'],
    actor: requireString(value.actor, 'Provenance actor'),
    ...(typeof value.harnessId === 'string' ? { harnessId: value.harnessId } : {}),
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
    ...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {}),
    ...(typeof value.importedFilename === 'string'
      ? { importedFilename: value.importedFilename }
      : {}),
    ...(typeof value.brainstormId === 'string'
      ? { brainstormId: validateEntityId(value.brainstormId, 'Brainstorm ID') }
      : {}),
    ...(value.brainstormVersion === undefined
      ? {}
      : { brainstormVersion: requireVersion(value.brainstormVersion) }),
    ...(typeof value.brainstormInputHash === 'string'
      ? { brainstormInputHash: requireString(value.brainstormInputHash, 'Brainstorm input hash') }
      : {})
  }
}

function validateBrainstormProvenance(value: unknown): NewBrainstormProvenance {
  if (!isRecord(value)) throw new TypeError('Brainstorm provenance must be an object')
  if (value.source !== 'agent' && value.source !== 'manual') {
    throw new TypeError('Invalid brainstorm provenance source')
  }
  return {
    source: value.source,
    actor: requireString(value.actor, 'Brainstorm provenance actor'),
    ...(typeof value.harnessId === 'string' ? { harnessId: value.harnessId } : {}),
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
    ...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {})
  }
}

function validateBrainstormSection(value: unknown): BrainstormSectionId {
  if (typeof value !== 'string' || !BRAINSTORM_SECTIONS.has(value as BrainstormSectionId)) {
    throw new TypeError('Invalid brainstorm section')
  }
  return value as BrainstormSectionId
}

function validateBrainstormAnnotationInput(value: unknown): AddBrainstormAnnotationInput {
  if (!isRecord(value)) throw new TypeError('Brainstorm annotation input must be an object')
  const startLine = validateOptionalAnnotationLine(value.startLine, 'Annotation start line')
  const endLine = validateOptionalAnnotationLine(value.endLine, 'Annotation end line')
  const startOffset = validateOptionalAnnotationOffset(value.startOffset, 'Annotation start offset')
  const endOffset = validateOptionalAnnotationOffset(value.endOffset, 'Annotation end offset')
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new TypeError('Annotation end line must be greater than or equal to its start line')
  }
  if (startOffset !== undefined && endOffset !== undefined && endOffset < startOffset) {
    throw new TypeError('Annotation end offset must be greater than or equal to its start offset')
  }
  return {
    section: validateBrainstormSection(value.section),
    body: requireString(value.body, 'Brainstorm annotation body'),
    author: requireString(value.author, 'Brainstorm annotation author'),
    ...(value.quote === undefined ? {} : { quote: requireString(value.quote, 'Annotation quote') }),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(startOffset === undefined ? {} : { startOffset }),
    ...(endOffset === undefined ? {} : { endOffset })
  }
}

function validateSection(value: unknown): SpecSectionId {
  if (typeof value !== 'string' || !SPEC_SECTIONS.has(value as SpecSectionId)) {
    throw new TypeError('Invalid specification section')
  }
  return value as SpecSectionId
}

function validateOptionalAnnotationLine(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return value
}

function validateOptionalAnnotationOffset(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return value
}

function validateSpecValidationIssue(value: unknown): SpecValidationIssue {
  if (!isRecord(value)) throw new TypeError('Specification validation issue must be an object')
  if (
    typeof value.code !== 'string' ||
    !SPEC_VALIDATION_CODES.has(value.code as SpecValidationCode)
  ) {
    throw new TypeError('Invalid specification validation issue code')
  }
  return {
    code: value.code as SpecValidationCode,
    section: validateSection(value.section),
    path: requireString(value.path, 'Specification validation issue path'),
    message: requireString(value.message, 'Specification validation issue message')
  }
}

function validateAnnotationInput(value: unknown): AddSpecAnnotationInput {
  if (!isRecord(value)) throw new TypeError('Annotation input must be an object')
  const startLine = validateOptionalAnnotationLine(value.startLine, 'Annotation start line')
  const endLine = validateOptionalAnnotationLine(value.endLine, 'Annotation end line')
  const startOffset = validateOptionalAnnotationOffset(value.startOffset, 'Annotation start offset')
  const endOffset = validateOptionalAnnotationOffset(value.endOffset, 'Annotation end offset')
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new TypeError('Annotation end line must be greater than or equal to its start line')
  }
  if (startOffset !== undefined && endOffset !== undefined && endOffset < startOffset) {
    throw new TypeError('Annotation end offset must be greater than or equal to its start offset')
  }
  return {
    section: validateSection(value.section),
    body: requireString(value.body, 'Annotation body'),
    author: requireString(value.author, 'Annotation author'),
    ...(value.quote === undefined ? {} : { quote: requireString(value.quote, 'Annotation quote') }),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(startOffset === undefined ? {} : { startOffset }),
    ...(endOffset === undefined ? {} : { endOffset })
  }
}

function validateAssignmentAnnotationInput(
  value: unknown,
  assignment: AssignmentPlanContent
): AddAssignmentAnnotationInput {
  if (!isRecord(value)) throw new TypeError('Assignment annotation input must be an object')
  const section = requireString(value.section, 'Assignment annotation section')
  const validSections = new Set([
    'overview',
    'graph',
    ...assignment.phases.map((phase) => `phase:${phase.id}`),
    ...assignment.tasks.map((task) => `task:${task.id}`)
  ])
  if (!validSections.has(section)) throw new TypeError('Invalid Assignment annotation section')
  const startLine = validateOptionalAnnotationLine(value.startLine, 'Annotation start line')
  const endLine = validateOptionalAnnotationLine(value.endLine, 'Annotation end line')
  const startOffset = validateOptionalAnnotationOffset(value.startOffset, 'Annotation start offset')
  const endOffset = validateOptionalAnnotationOffset(value.endOffset, 'Annotation end offset')
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new TypeError('Annotation end line must be greater than or equal to its start line')
  }
  if (startOffset !== undefined && endOffset !== undefined && endOffset < startOffset) {
    throw new TypeError('Annotation end offset must be greater than or equal to its start offset')
  }
  return {
    section,
    body: requireString(value.body, 'Assignment annotation'),
    author: requireString(value.author, 'Annotation author'),
    ...(value.quote === undefined ? {} : { quote: requireString(value.quote, 'Annotation quote') }),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(startOffset === undefined ? {} : { startOffset }),
    ...(endOffset === undefined ? {} : { endOffset })
  }
}

function validateAuditAnnotationInput(value: unknown): AddAuditAnnotationInput {
  if (!isRecord(value)) throw new TypeError('Audit annotation input must be an object')
  if (typeof value.section !== 'string' || !AUDIT_SECTIONS.has(value.section as AuditSectionId)) {
    throw new TypeError('Invalid audit section')
  }
  const startLine = validateOptionalAnnotationLine(value.startLine, 'Annotation start line')
  const endLine = validateOptionalAnnotationLine(value.endLine, 'Annotation end line')
  const startOffset = validateOptionalAnnotationOffset(value.startOffset, 'Annotation start offset')
  const endOffset = validateOptionalAnnotationOffset(value.endOffset, 'Annotation end offset')
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new TypeError('Annotation end line must be greater than or equal to its start line')
  }
  if (startOffset !== undefined && endOffset !== undefined && endOffset < startOffset) {
    throw new TypeError('Annotation end offset must be greater than or equal to its start offset')
  }
  return {
    section: value.section as AuditSectionId,
    body: requireString(value.body, 'Audit annotation'),
    author: requireString(value.author, 'Annotation author'),
    ...(value.quote === undefined ? {} : { quote: requireString(value.quote, 'Annotation quote') }),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(startOffset === undefined ? {} : { startOffset }),
    ...(endOffset === undefined ? {} : { endOffset })
  }
}

function validateContext(value: unknown): SpecContextReference[] {
  if (!Array.isArray(value)) throw new TypeError('Specification context must be an array')
  return value.map((reference, index) => {
    if (!isRecord(reference)) throw new TypeError(`Context reference ${index} must be an object`)
    if (typeof reference.type !== 'string' || !SPEC_CONTEXT_TYPES.has(reference.type)) {
      throw new TypeError(`Context reference ${index} has an invalid type`)
    }
    if (
      typeof reference.selectedAt !== 'number' ||
      !Number.isSafeInteger(reference.selectedAt) ||
      reference.selectedAt < 0
    ) {
      throw new TypeError(`Context reference ${index} has an invalid timestamp`)
    }
    return {
      id: validateEntityId(reference.id, `Context reference ${index} ID`),
      type: reference.type as SpecContextReference['type'],
      label: requireString(reference.label, `Context reference ${index} label`),
      ...(typeof reference.path === 'string' ? { path: reference.path } : {}),
      ...(typeof reference.contentHash === 'string' ? { contentHash: reference.contentHash } : {}),
      selectedAt: reference.selectedAt
    }
  })
}

function validateEngineeringSpecInput(value: unknown): EngineeringSpec {
  if (!isRecord(value)) throw new TypeError('Specification must be an object')
  const status = value.status
  if (
    status !== 'draft' &&
    status !== 'in_review' &&
    status !== 'approved' &&
    status !== 'superseded'
  ) {
    throw new TypeError('Invalid specification status')
  }
  if (!Array.isArray(value.annotations)) {
    throw new TypeError('Specification annotations must be an array')
  }

  const annotations = value.annotations.map((annotation, index) => {
    if (!isRecord(annotation)) throw new TypeError(`Annotation ${index} must be an object`)
    if (annotation.status !== 'open' && annotation.status !== 'resolved') {
      throw new TypeError(`Annotation ${index} has an invalid status`)
    }
    return {
      id: validateEntityId(annotation.id, `Annotation ${index} ID`),
      section: validateSection(annotation.section),
      body: requireString(annotation.body, `Annotation ${index} body`),
      status: annotation.status as 'open' | 'resolved',
      author: requireString(annotation.author, `Annotation ${index} author`),
      createdAt: requireTimestamp(annotation.createdAt, `Annotation ${index} creation`),
      ...(annotation.resolvedAt === undefined
        ? {}
        : {
            resolvedAt: requireTimestamp(annotation.resolvedAt, `Annotation ${index} resolution`)
          })
    }
  })
  const decisionComments =
    value.decisionComments === undefined
      ? []
      : (() => {
          if (!Array.isArray(value.decisionComments)) {
            throw new TypeError('Specification decision comments must be an array')
          }
          return value.decisionComments.map((comment, index) => {
            if (!isRecord(comment)) {
              throw new TypeError(`Decision comment ${index} must be an object`)
            }
            if (comment.action !== 'review' && comment.action !== 'implement') {
              throw new TypeError(`Decision comment ${index} has an invalid action`)
            }
            return {
              id: validateEntityId(comment.id, `Decision comment ${index} ID`),
              action: comment.action as 'review' | 'implement',
              body: requireString(comment.body, `Decision comment ${index} body`),
              createdAt: requireTimestamp(comment.createdAt, `Decision comment ${index} creation`)
            }
          })
        })()
  const dismissedValidationIssues =
    value.dismissedValidationIssues === undefined
      ? []
      : (() => {
          if (!Array.isArray(value.dismissedValidationIssues)) {
            throw new TypeError('Dismissed specification validation issues must be an array')
          }
          return value.dismissedValidationIssues.map((issue, index) => ({
            ...validateSpecValidationIssue(issue),
            dismissedAt: requireTimestamp(
              isRecord(issue) ? issue.dismissedAt : undefined,
              `Dismissed specification validation issue ${index}`
            )
          }))
        })()
  if (value.schemaVersion !== 1) throw new TypeError('Unsupported specification schema')
  if (!isRecord(value.provenance)) throw new TypeError('Specification provenance is invalid')
  const provenance = {
    ...validateProvenance(value.provenance),
    createdAt: requireTimestamp(value.provenance.createdAt, 'Provenance creation'),
    ...(value.provenance.parentVersion === undefined
      ? {}
      : { parentVersion: requireVersion(value.provenance.parentVersion) })
  }
  return {
    schemaVersion: 1,
    id: validateEntityId(value.id, 'Specification ID'),
    projectId: validateEntityId(value.projectId, 'Project ID'),
    threadId: validateEntityId(value.threadId, 'Thread ID'),
    version: requireVersion(value.version),
    status,
    content: validateSpecContent(value.content),
    annotations,
    dismissedValidationIssues,
    decisionComments,
    context: validateContext(value.context),
    provenance,
    createdAt: requireTimestamp(value.createdAt, 'Specification creation'),
    updatedAt: requireTimestamp(value.updatedAt, 'Specification update'),
    ...(value.approvedAt === undefined
      ? {}
      : {
          approvedAt: requireTimestamp(value.approvedAt, 'Specification approval')
        })
  }
}

function requireTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} timestamp is invalid`)
  }
  return value
}

/** Validate the complete renderer-controlled config boundary. */
export function validateAppConfigPatch(value: unknown): AppConfigPatch {
  if (!isRecord(value)) throw new TypeError('Config patch must be an object')

  for (const field of Object.keys(value)) {
    if (!CONFIG_PATCH_FIELDS.has(field)) {
      throw new TypeError(`Unsupported config field: ${field}`)
    }
  }

  const patch: AppConfigPatch = {}

  if ('theme' in value) {
    if (typeof value.theme !== 'string' || !THEMES.has(value.theme)) {
      throw new TypeError('Invalid theme')
    }
    patch.theme = value.theme as AppConfigPatch['theme']
  }

  if ('threadLimit' in value) {
    if (
      typeof value.threadLimit !== 'number' ||
      !Number.isInteger(value.threadLimit) ||
      value.threadLimit < 1 ||
      value.threadLimit > 1000
    ) {
      throw new TypeError('Thread limit must be an integer between 1 and 1000')
    }
    patch.threadLimit = value.threadLimit
  }

  if ('questionTimeoutMs' in value) {
    if (
      typeof value.questionTimeoutMs !== 'number' ||
      !Number.isSafeInteger(value.questionTimeoutMs) ||
      value.questionTimeoutMs < 10_000 ||
      value.questionTimeoutMs > 3_600_000
    ) {
      throw new TypeError(
        'Question timeout must be an integer between 10000 and 3600000 milliseconds'
      )
    }
    patch.questionTimeoutMs = value.questionTimeoutMs
  }

  if ('slashCommandMode' in value) {
    if (
      typeof value.slashCommandMode !== 'string' ||
      !SLASH_COMMAND_MODES.has(value.slashCommandMode)
    ) {
      throw new TypeError('Invalid slash command mode')
    }
    patch.slashCommandMode = value.slashCommandMode as AppConfigPatch['slashCommandMode']
  }

  if ('preferredEditor' in value) {
    if (
      typeof value.preferredEditor !== 'string' ||
      !EDITOR_IDS.has(value.preferredEditor as EditorId)
    ) {
      throw new TypeError('Invalid preferred editor')
    }
    patch.preferredEditor = value.preferredEditor as EditorId
  }

  if ('memory' in value) {
    patch.memory = validateMemoryConfig(value.memory)
  }

  if ('agentDefaults' in value) {
    patch.agentDefaults = validateAgentDefaults(value.agentDefaults)
  }

  if ('autoDownloadUpdates' in value) {
    if (typeof value.autoDownloadUpdates !== 'boolean') {
      throw new TypeError('autoDownloadUpdates must be a boolean')
    }
    patch.autoDownloadUpdates = value.autoDownloadUpdates
  }

  if ('autoInstallUpdates' in value) {
    if (typeof value.autoInstallUpdates !== 'boolean') {
      throw new TypeError('autoInstallUpdates must be a boolean')
    }
    patch.autoInstallUpdates = value.autoInstallUpdates
  }

  if ('updateChannel' in value) {
    if (value.updateChannel !== 'stable' && value.updateChannel !== 'nightly') {
      throw new TypeError('updateChannel must be either "stable" or "nightly"')
    }
    patch.updateChannel = value.updateChannel
  }

  if ('keepAwakeWhileWorking' in value) {
    if (typeof value.keepAwakeWhileWorking !== 'boolean') {
      throw new TypeError('keepAwakeWhileWorking must be a boolean')
    }
    patch.keepAwakeWhileWorking = value.keepAwakeWhileWorking
  }

  if ('imageDescriptorAskAgain' in value) {
    if (typeof value.imageDescriptorAskAgain !== 'boolean') {
      throw new TypeError('imageDescriptorAskAgain must be a boolean')
    }
    patch.imageDescriptorAskAgain = value.imageDescriptorAskAgain
  }

  if ('autoRetryAfterReset' in value) {
    if (typeof value.autoRetryAfterReset !== 'boolean') {
      throw new TypeError('autoRetryAfterReset must be a boolean')
    }
    patch.autoRetryAfterReset = value.autoRetryAfterReset
  }

  return patch
}

export interface RegisterIpcHandlersOptions {
  projectManager?: ProjectManager
  projectFilesService?: ProjectFilesService
  powerWakeService?: PowerWakeService
  /** Auto-resume scheduler gated by the General settings toggle. */
  retryScheduler?: RetrySchedulerService
  /** Confirmed-override layer on the declarative harness behavior manifests. */
  harnessManifestService?: HarnessManifestService
}

export function registerIpcHandlers(
  storage: StorageEngine,
  database: Database,
  updaterService?: UpdaterService,
  chatEngine?: Pick<ChatEngine, 'loadMessages' | 'deleteThreadSession'>,
  options: RegisterIpcHandlersOptions = {}
): void {
  const projectManager = options.projectManager ?? new ProjectManager(database)
  const projectFilesService = options.projectFilesService ?? new ProjectFilesService(projectManager)
  const threadManager = new ThreadManager(database, broadcastThreadUpdate, async (thread) => {
    if (chatEngine?.deleteThreadSession) {
      await chatEngine.deleteThreadSession(thread.projectId, thread.id)
    }
    dismissThreadNotifications(thread.projectId, thread.id)
  })
  const scopeManager = new ScopeManager(database)
  const historyEngine = new HistoryEngine(database)
  const planEngine = new PlanEngine(storage, database)
  const specEngine = new SpecEngine(storage, database, {
    validateForApproval: validateEngineeringSpec
  })
  const brainstormEngine = new BrainstormEngine(storage, database)
  const auditEngine = new AuditEngine(storage, database)
  const assignmentEngine = new AssignmentEngine(storage, database)
  const specContextService = new SpecContextService(database, projectManager)
  const editorService = new EditorService()
  const repositoryService = new RepositoryService()
  const gitService = new GitService()
  const vault = new SecretVault(storage)
  const githubAuthService = new GitHubAuthService(vault)
  const checkpointManager = new CheckpointManager(database)
  const diagnosticsService = new DiagnosticsService(database)
  const memoryService = new MemoryService(storage)

  // Shared privileged-IPC boundary: every renderer call that can open the
  // system browser, reveal files, or read local files is validated here.
  const privilegedIpc = new PrivilegedIpcValidator({
    trustedOrigins: computeTrustedRendererOrigins(),
    scopes: {
      projectRoots: async () =>
        (await projectManager.listProjects())
          .map((project) => project.path)
          .filter((path): path is string => typeof path === 'string' && path.length > 0),
      configRoot: () => getConfigRoot()
    }
  })

  /** Register a privileged channel whose sender frame must be trusted. */
  function privileged<TArgs extends unknown[]>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => unknown
  ): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      privilegedIpc.assertTrustedSender(event)
      return handler(event, ...(args as TArgs))
    })
  }

  // ─── Application config ────────────────────────────────────────────────
  ipcMain.handle('config:get', () => storage.getConfig())
  ipcMain.handle('config:update', async (_, input: unknown) => {
    const patch = validateAppConfigPatch(input)
    const config = { ...(await storage.getConfig()), ...patch }
    await storage.saveConfig(config)
    options.powerWakeService?.setEnabled(config.keepAwakeWhileWorking)
    options.retryScheduler?.setEnabled(config.autoRetryAfterReset)
    return config
  })
  ipcMain.handle('config:syncAgentRole', async (_, role: unknown, selection: unknown) => {
    if (typeof role !== 'string' || !AGENT_ROLES.has(role as AgentRole)) {
      throw new TypeError('Invalid agent role')
    }
    const safeRole = role as AgentRole
    const safeSelection = validateAgentModelSelection(selection, `${safeRole} thread model`)
    const config = await storage.getConfig()
    if (!config.agentDefaults.syncFromThreadChanges) return config
    const updated: AppConfig = {
      ...config,
      agentDefaults: {
        ...config.agentDefaults,
        [safeRole]: safeSelection
      }
    }
    await storage.saveConfig(updated)
    return updated
  })
  ipcMain.handle('workerNames:getSettings', () => storage.getWorkerNameSettings())
  ipcMain.handle('workerNames:saveCustom', async (_, input: unknown) => {
    if (!Array.isArray(input) || input.some((name) => typeof name !== 'string')) {
      throw new TypeError('Worker names must be a JSON array of strings')
    }
    const names = normalizeWorkerNames(input)
    if (!names || names.length === 0) {
      throw new TypeError('Worker names must include at least one name')
    }
    await storage.saveCustomWorkerNames(names)
  })

  // ─── Memory ────────────────────────────────────────────────────────────
  ipcMain.handle('memory:getLayers', async (_, projectId: unknown, threadId: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    const project = await projectManager.getProject(safeProjectId)
    if (!project) throw new Error(`Project not found: ${safeProjectId}`)
    const projectPath = project.path || ''
    const thread = await threadManager.getThread(safeProjectId, safeThreadId)
    const { PromptAssembler } = await import('./prompt-assembler')
    const assembler = new PromptAssembler(memoryService)
    const {
      SPEC_BRAINSTORM_SYSTEM_PROMPT,
      SPEC_IMPLEMENT_SYSTEM_PROMPT,
      MERMAID_OUTPUT_INSTRUCTION
    } = await import('./chat-engine')
    const driverName =
      thread?.settings?.harnessId === 'claude-code'
        ? 'Claude Code'
        : thread?.settings?.harnessId === 'codex'
          ? 'Codex'
          : thread?.settings?.harnessId === 'cline'
            ? 'Cline'
            : thread?.settings?.harnessId === 'pi'
              ? 'Pi'
              : thread?.settings?.harnessId === 'antigravity'
                ? 'Antigravity'
                : 'OpenCode'
    const harnessId = thread?.settings?.harnessId ?? 'opencode'
    const loadsAgentsMd =
      options.harnessManifestService === undefined
        ? harnessLoadsAgentsMd(harnessId)
        : await options.harnessManifestService.resolveLoadsAgentsMd(harnessId)
    const driverInfo = {
      id: harnessId,
      name: driverName,
      loadsAgentsMd
    }
    const workflow = await specEngine.getWorkflowState(safeProjectId, safeThreadId)
    const hasActiveSpec = Boolean(workflow?.activeSpecId && workflow.activeSpecVersion)
    const engineeringMode = thread?.settings?.engineeringMode !== false
    const mode = !engineeringMode ? 'chat' : hasActiveSpec ? 'brainstorm' : 'implement'
    return assembler.getLayers(
      safeProjectId,
      safeThreadId,
      projectPath,
      driverInfo,
      {
        SPEC_BRAINSTORM_SYSTEM_PROMPT,
        SPEC_IMPLEMENT_SYSTEM_PROMPT,
        MERMAID_OUTPUT_INSTRUCTION
      },
      mode
    )
  })
  ipcMain.handle('memory:getRaw', (_, projectId?: unknown, threadId?: unknown) =>
    memoryService.getRawMarkdown(
      optionalMemoryEntityId(projectId, 'Project ID'),
      optionalMemoryEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle(
    'memory:saveRaw',
    async (_, markdown: unknown, projectId?: unknown, threadId?: unknown) => {
      await memoryService.saveFromMarkdown(
        requireString(markdown, 'Memory markdown', true),
        optionalMemoryEntityId(projectId, 'Project ID'),
        optionalMemoryEntityId(threadId, 'Thread ID')
      )
    }
  )
  ipcMain.handle('memory:getEntries', (_, projectId?: unknown, threadId?: unknown) =>
    memoryService.getEntries(
      optionalMemoryEntityId(projectId, 'Project ID'),
      optionalMemoryEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle(
    'memory:saveEntries',
    async (_, entries: unknown, projectId?: unknown, threadId?: unknown) => {
      const safe = validateMemoryEntries(entries)
      await memoryService.saveEntries(
        safe,
        optionalMemoryEntityId(projectId, 'Project ID'),
        optionalMemoryEntityId(threadId, 'Thread ID')
      )
    }
  )
  ipcMain.handle('memory:getMergedEntries', (_, projectId: unknown) =>
    memoryService.getMergedEntries(requireString(projectId, 'Project ID', true))
  )
  ipcMain.handle(
    'memory:addEntry',
    async (_, label: unknown, content: unknown, options?: unknown) => {
      const safeLabel = requireString(label, 'Memory label', true)
      const safeContent = requireString(content, 'Memory content', true)
      const opts = isRecord(options) ? options : {}
      return memoryService.addEntry(safeLabel, safeContent, {
        category:
          typeof opts.category === 'string'
            ? (opts.category as MemoryEntry['category'])
            : undefined,
        priority:
          typeof opts.priority === 'string'
            ? (opts.priority as MemoryEntry['priority'])
            : undefined,
        scope: typeof opts.scope === 'string' ? (opts.scope as MemoryEntry['scope']) : undefined,
        source:
          typeof opts.source === 'string' ? (opts.source as MemoryEntry['source']) : undefined,
        projectId: optionalMemoryEntityId(opts.projectId, 'Project ID'),
        threadId: optionalMemoryEntityId(opts.threadId, 'Thread ID')
      })
    }
  )
  ipcMain.handle(
    'memory:removeEntry',
    async (_, entryId: unknown, projectId?: unknown, threadId?: unknown) =>
      memoryService.removeEntry(
        requireString(entryId, 'Entry ID', true),
        optionalMemoryEntityId(projectId, 'Project ID'),
        optionalMemoryEntityId(threadId, 'Thread ID')
      )
  )
  ipcMain.handle('memory:searchEntries', async (_, query: unknown, options?: unknown) => {
    const safeQuery = requireString(query, 'Search query', true)
    const opts = isRecord(options) ? options : {}
    return memoryService.searchEntries(safeQuery, {
      category:
        typeof opts.category === 'string' ? (opts.category as MemoryEntry['category']) : undefined,
      priority:
        typeof opts.priority === 'string' ? (opts.priority as MemoryEntry['priority']) : undefined,
      projectId: optionalMemoryEntityId(opts.projectId, 'Project ID')
    })
  })
  ipcMain.handle('memory:getPendingProposals', (_, projectId?: unknown) =>
    memoryService.getPendingProposals(optionalMemoryEntityId(projectId, 'Project ID'))
  )
  ipcMain.handle('memory:approveProposal', async (_, proposalId: unknown, projectId?: unknown) =>
    memoryService.approveProposal(
      requireString(proposalId, 'Proposal ID', true),
      optionalMemoryEntityId(projectId, 'Project ID')
    )
  )
  ipcMain.handle('memory:rejectProposal', async (_, proposalId: unknown, projectId?: unknown) =>
    memoryService.rejectProposal(
      requireString(proposalId, 'Proposal ID', true),
      optionalMemoryEntityId(projectId, 'Project ID')
    )
  )
  ipcMain.handle(
    'memory:createProposal',
    async (_, label: unknown, content: unknown, options?: unknown) => {
      const safeLabel = requireString(label, 'Memory label', true)
      const safeContent = requireString(content, 'Memory content', true)
      const opts = isRecord(options) ? options : {}
      return memoryService.createProposal(safeLabel, safeContent, {
        category:
          typeof opts.category === 'string'
            ? (opts.category as MemoryEntry['category'])
            : undefined,
        priority:
          typeof opts.priority === 'string'
            ? (opts.priority as MemoryEntry['priority'])
            : undefined,
        scope: typeof opts.scope === 'string' ? (opts.scope as MemoryEntry['scope']) : undefined,
        projectId: optionalMemoryEntityId(opts.projectId, 'Project ID'),
        threadId: optionalMemoryEntityId(opts.threadId, 'Thread ID')
      })
    }
  )

  // ─── Engineering specifications ───────────────────────────────────────
  ipcMain.handle('assignment:getActive', (_, projectId: unknown, coordinatorThreadId: unknown) =>
    assignmentEngine.getActive(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    )
  )
  ipcMain.handle(
    'assignment:listVersions',
    (_, projectId: unknown, coordinatorThreadId: unknown, assignmentId: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeCoordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
      const safeAssignmentId = validateEntityId(assignmentId, 'Assignment ID')
      const active = assignmentEngine.getActive(safeProjectId, safeCoordinatorThreadId)
      if (!active || active.id !== safeAssignmentId) {
        throw new Error('Assignment does not belong to this coordinator thread')
      }
      return assignmentEngine.listVersions(safeAssignmentId)
    }
  )
  ipcMain.handle(
    'assignment:saveDraft',
    (_, projectId: unknown, coordinatorThreadId: unknown, content: unknown, provenance: unknown) =>
      assignmentEngine.saveDraft(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(coordinatorThreadId, 'Coordinator thread ID'),
        validateAssignmentContent(content),
        validateAssignmentProvenance(provenance)
      )
  )
  ipcMain.handle(
    'assignment:addAnnotation',
    async (
      _,
      projectId: unknown,
      coordinatorThreadId: unknown,
      assignmentId: unknown,
      version: unknown,
      input: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
      const active = assignmentEngine.getActive(safeProjectId, safeThreadId)
      if (!active) throw new Error('Assignment not found')
      return assignmentEngine.addAnnotation(
        safeProjectId,
        safeThreadId,
        validateEntityId(assignmentId, 'Assignment ID'),
        validateBoundedInteger(version, 'Assignment version', 1, Number.MAX_SAFE_INTEGER),
        validateAssignmentAnnotationInput(input, active.content)
      )
    }
  )
  ipcMain.handle(
    'assignment:updateAnnotation',
    (
      _,
      projectId: unknown,
      coordinatorThreadId: unknown,
      assignmentId: unknown,
      version: unknown,
      annotationId: unknown,
      body: unknown
    ) =>
      assignmentEngine.updateAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(coordinatorThreadId, 'Coordinator thread ID'),
        validateEntityId(assignmentId, 'Assignment ID'),
        validateBoundedInteger(version, 'Assignment version', 1, Number.MAX_SAFE_INTEGER),
        validateEntityId(annotationId, 'Assignment annotation ID'),
        requireString(body, 'Assignment annotation')
      )
  )
  ipcMain.handle(
    'assignment:resolveAnnotation',
    (
      _,
      projectId: unknown,
      coordinatorThreadId: unknown,
      assignmentId: unknown,
      version: unknown,
      annotationId: unknown
    ) =>
      assignmentEngine.resolveAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(coordinatorThreadId, 'Coordinator thread ID'),
        validateEntityId(assignmentId, 'Assignment ID'),
        validateBoundedInteger(version, 'Assignment version', 1, Number.MAX_SAFE_INTEGER),
        validateEntityId(annotationId, 'Assignment annotation ID')
      )
  )
  ipcMain.handle(
    'assignment:updateUnlinkedWorkerModel',
    (_, projectId: unknown, coordinatorThreadId: unknown, taskId: unknown, model: unknown) => {
      const safeModel = validateAssignmentModel(model, 'Assignment worker model')
      if (!safeModel) throw new TypeError('Assignment worker model is required')
      return assignmentEngine.updateUnlinkedWorkerModel(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(coordinatorThreadId, 'Coordinator thread ID'),
        validateEntityId(taskId, 'Assignment task ID'),
        safeModel
      )
    }
  )
  ipcMain.handle('assignment:validate', (_, content: unknown) =>
    validateAssignment(validateAssignmentContent(content))
  )
  privileged(
    'assignment:openInEditor',
    async (_event, projectId: unknown, coordinatorThreadId: unknown, content: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
      const active = assignmentEngine.getActive(safeProjectId, safeThreadId)
      if (!active) throw new Error('Assignment not found')
      const safeContent = validateAssignmentContent(content)
      const targetPath = await assignmentEngine.markdownPath(safeProjectId, safeThreadId)
      await atomicWrite(targetPath, exportAssignmentMarkdown({ ...active, content: safeContent }))
      const config = await storage.getConfig()
      await editorService.openInEditor(config.preferredEditor, targetPath, 'file')
      return targetPath
    }
  )
  privileged(
    'assignment:revealInFiles',
    async (_event, projectId: unknown, coordinatorThreadId: unknown, content: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
      const active = assignmentEngine.getActive(safeProjectId, safeThreadId)
      if (!active) throw new Error('Assignment not found')
      const safeContent = validateAssignmentContent(content)
      const targetPath = await assignmentEngine.markdownPath(safeProjectId, safeThreadId)
      await atomicWrite(targetPath, exportAssignmentMarkdown({ ...active, content: safeContent }))
      return targetPath
    }
  )
  ipcMain.handle('brainstorm:ensureWorkflow', (_, projectId: unknown, threadId: unknown) =>
    brainstormEngine.ensureWorkflow(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle('brainstorm:getWorkflow', (_, projectId: unknown, threadId: unknown) =>
    brainstormEngine.getWorkflowState(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle(
    'brainstorm:chooseEntry',
    (_, projectId: unknown, threadId: unknown, choice: unknown) => {
      if (choice !== 'brainstorm' && choice !== 'spec') {
        throw new TypeError('Brainstorm entry choice must be brainstorm or spec')
      }
      return brainstormEngine.chooseEntry(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        choice as BrainstormEntryChoice
      )
    }
  )
  ipcMain.handle('brainstorm:resetWorkflow', (_, projectId: unknown, threadId: unknown) => {
    brainstormEngine.resetWorkflow(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  })
  ipcMain.handle('brainstorm:getActive', (_, projectId: unknown, threadId: unknown) =>
    brainstormEngine.getActive(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle(
    'brainstorm:listVersions',
    (_, projectId: unknown, threadId: unknown, brainstormId: unknown) =>
      brainstormEngine.listVersions(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID')
      )
  )
  ipcMain.handle(
    'brainstorm:createDraft',
    (_, projectId: unknown, threadId: unknown, content: unknown, provenance: unknown) =>
      brainstormEngine.createDraft({
        projectId: validateEntityId(projectId, 'Project ID'),
        threadId: validateEntityId(threadId, 'Thread ID'),
        content: parseGeneratedBrainstormContent(content),
        provenance: validateBrainstormProvenance(provenance)
      })
  )
  ipcMain.handle(
    'brainstorm:saveDraft',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      content: unknown
    ) =>
      brainstormEngine.saveDraft(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        parseGeneratedBrainstormContent(content)
      )
  )
  ipcMain.handle(
    'brainstorm:createVersion',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      content: unknown,
      provenance: unknown
    ) =>
      brainstormEngine.createVersion({
        projectId: validateEntityId(projectId, 'Project ID'),
        threadId: validateEntityId(threadId, 'Thread ID'),
        brainstormId: validateEntityId(brainstormId, 'Brainstorm ID'),
        content: parseGeneratedBrainstormContent(content),
        provenance: validateBrainstormProvenance(provenance)
      })
  )
  ipcMain.handle(
    'brainstorm:addAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      input: unknown
    ) =>
      brainstormEngine.addAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        validateBrainstormAnnotationInput(input)
      )
  )
  ipcMain.handle(
    'brainstorm:updateAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      annotationId: unknown,
      body: unknown
    ) =>
      brainstormEngine.updateAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Brainstorm annotation ID'),
        requireString(body, 'Brainstorm annotation body')
      )
  )
  ipcMain.handle(
    'brainstorm:resolveAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      annotationId: unknown
    ) =>
      brainstormEngine.resolveAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Brainstorm annotation ID')
      )
  )
  ipcMain.handle(
    'brainstorm:addDecisionComment',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      action: unknown,
      body: unknown
    ) => {
      if (action !== 'review' && action !== 'finalize') {
        throw new TypeError('Brainstorm decision action must be review or finalize')
      }
      return brainstormEngine.addDecisionComment(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        action,
        requireString(body, 'Brainstorm decision comment')
      )
    }
  )
  ipcMain.handle(
    'brainstorm:finalize',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      note: unknown
    ) =>
      brainstormEngine.finalize(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        note === undefined ? '' : requireString(note, 'Brainstorm finalization note', true)
      )
  )
  privileged(
    'brainstorm:openInEditor',
    async (
      _event,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown
    ) => {
      const validProjectId = validateEntityId(projectId, 'Project ID')
      const validThreadId = validateEntityId(threadId, 'Thread ID')
      const validBrainstormId = validateEntityId(brainstormId, 'Brainstorm ID')
      const validVersion = requireVersion(version)
      const document = brainstormEngine.getVersion(
        validProjectId,
        validThreadId,
        validBrainstormId,
        validVersion
      )
      if (!document) throw new Error('Brainstorm version not found')
      const targetPath = await brainstormEngine.markdownPath(
        validProjectId,
        validThreadId,
        validBrainstormId,
        validVersion
      )
      await atomicWrite(targetPath, exportBrainstormMarkdown(document))
      const config = await storage.getConfig()
      await editorService.openInEditor(config.preferredEditor, targetPath, 'file')
      return targetPath
    }
  )
  privileged(
    'brainstorm:revealInFiles',
    async (
      _event,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown
    ) => {
      const validProjectId = validateEntityId(projectId, 'Project ID')
      const validThreadId = validateEntityId(threadId, 'Thread ID')
      const validBrainstormId = validateEntityId(brainstormId, 'Brainstorm ID')
      const validVersion = requireVersion(version)
      const document = brainstormEngine.getVersion(
        validProjectId,
        validThreadId,
        validBrainstormId,
        validVersion
      )
      if (!document) throw new Error('Brainstorm version not found')
      const targetPath = await brainstormEngine.markdownPath(
        validProjectId,
        validThreadId,
        validBrainstormId,
        validVersion
      )
      await atomicWrite(targetPath, exportBrainstormMarkdown(document))
      return targetPath
    }
  )
  ipcMain.handle('spec:getActive', async (_, projectId: unknown, threadId: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    const workflow = await specEngine.getWorkflowState(safeProjectId, safeThreadId)
    if (!workflow?.activeSpecId || !workflow.activeSpecVersion) return null
    return specEngine.getVersion(
      safeProjectId,
      safeThreadId,
      workflow.activeSpecId,
      workflow.activeSpecVersion
    )
  })
  ipcMain.handle('spec:listVersions', (_, projectId: unknown, threadId: unknown, specId: unknown) =>
    specEngine.listVersions(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      validateEntityId(specId, 'Specification ID')
    )
  )
  ipcMain.handle(
    'spec:createDraft',
    (_, projectId: unknown, threadId: unknown, content: unknown, provenance: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const safeContent = validateSpecContent(content)
      const safeProvenance = validateProvenance(provenance)
      return memoryService.snapshotCurrent(safeProjectId, safeThreadId).then((context) =>
        specEngine.createDraft({
          projectId: safeProjectId,
          threadId: safeThreadId,
          content: safeContent,
          provenance: safeProvenance,
          context
        })
      )
    }
  )
  ipcMain.handle(
    'spec:saveDraft',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      content: unknown
    ) =>
      specEngine.saveDraft(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateSpecContent(content)
      )
  )
  ipcMain.handle(
    'spec:createVersion',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      content: unknown,
      provenance: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const safeSpecId = validateEntityId(specId, 'Specification ID')
      const safeContent = validateSpecContent(content)
      const safeProvenance = validateProvenance(provenance)
      return Promise.all([
        specEngine.getLatest(safeProjectId, safeThreadId, safeSpecId),
        memoryService.snapshotCurrent(safeProjectId, safeThreadId)
      ]).then(([latest, memory]) =>
        specEngine.createVersion({
          projectId: safeProjectId,
          threadId: safeThreadId,
          specId: safeSpecId,
          content: safeContent,
          provenance: safeProvenance,
          context: [
            ...(latest?.context.filter((reference) => reference.type !== 'memory') ?? []),
            ...memory
          ]
        })
      )
    }
  )
  ipcMain.handle(
    'spec:dismissValidationIssue',
    (_, projectId: unknown, threadId: unknown, specId: unknown, version: unknown, issue: unknown) =>
      specEngine.dismissValidationIssue(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateSpecValidationIssue(issue)
      )
  )
  ipcMain.handle(
    'spec:setReview',
    (_, projectId: unknown, threadId: unknown, specId: unknown, version: unknown) =>
      specEngine.setReview(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version)
      )
  )
  ipcMain.handle(
    'spec:approve',
    (_, projectId: unknown, threadId: unknown, specId: unknown, version: unknown) =>
      specEngine.approve(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version)
      )
  )
  ipcMain.handle('spec:validate', (_, spec: unknown) =>
    validateEngineeringSpec(validateEngineeringSpecInput(spec))
  )
  ipcMain.handle('audit:getActive', (_, projectId: unknown, threadId: unknown) =>
    auditEngine.getActive(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle(
    'audit:listVersions',
    (_, projectId: unknown, threadId: unknown, reportId: unknown) =>
      auditEngine.listVersions(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(reportId, 'Audit report ID')
      )
  )
  ipcMain.handle('audit:save', async (_, report: unknown, content: unknown) => {
    if (!isRecord(report)) throw new TypeError('Audit report must be an object')
    const projectId = validateEntityId(report.projectId, 'Project ID')
    const threadId = validateEntityId(report.threadId, 'Thread ID')
    const reportId = validateEntityId(report.id, 'Audit report ID')
    const version = requireVersion(report.version)
    const persisted = (await auditEngine.listVersions(projectId, threadId, reportId)).find(
      (candidate) => candidate.version === version
    )
    if (!persisted) throw new Error(`Audit report not found: ${reportId} v${version}`)
    return auditEngine.save({
      ...persisted,
      content: validateAuditReportContent(content)
    })
  })
  ipcMain.handle(
    'audit:addAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      reportId: unknown,
      version: unknown,
      input: unknown
    ) =>
      auditEngine.addAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(reportId, 'Audit report ID'),
        requireVersion(version),
        validateAuditAnnotationInput(input)
      )
  )
  ipcMain.handle(
    'audit:updateAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      reportId: unknown,
      version: unknown,
      annotationId: unknown,
      body: unknown
    ) =>
      auditEngine.updateAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(reportId, 'Audit report ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Audit annotation ID'),
        requireString(body, 'Audit annotation')
      )
  )
  ipcMain.handle(
    'audit:resolveAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      reportId: unknown,
      version: unknown,
      annotationId: unknown
    ) =>
      auditEngine.resolveAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(reportId, 'Audit report ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Audit annotation ID')
      )
  )
  ipcMain.handle('audit:complete', async (_, projectId: unknown, threadId: unknown) => {
    const validProjectId = validateEntityId(projectId, 'Project ID')
    const validThreadId = validateEntityId(threadId, 'Thread ID')
    const assignment = assignmentEngine.getActive(validProjectId, validThreadId)
    if (assignment?.status === 'completed' && assignment.auditCycle?.status === 'report_ready') {
      await assignmentEngine.completeAuditCycle(validProjectId, validThreadId)
      await threadManager.setStatus(validProjectId, validThreadId, 'completed')
      return threadManager.setAuditState(validProjectId, validThreadId, undefined)
    }
    return threadManager.setAuditState(validProjectId, validThreadId, undefined)
  })
  ipcMain.handle('audit:beginRework', (_, projectId: unknown, threadId: unknown) =>
    threadManager.setAuditState(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      'reworking'
    )
  )
  ipcMain.handle('audit:returnToOffer', async (_, projectId: unknown, threadId: unknown) => {
    const validProjectId = validateEntityId(projectId, 'Project ID')
    const validThreadId = validateEntityId(threadId, 'Thread ID')
    const assignment = await assignmentEngine.makeAuditAvailable(validProjectId, validThreadId)
    await threadManager.setStatus(validProjectId, validThreadId, 'awaiting_approval')
    await threadManager.setAuditState(validProjectId, validThreadId, 'offered')
    return assignment
  })
  privileged(
    'audit:openInEditor',
    async (_event, projectId: unknown, threadId: unknown, reportId: unknown, version: unknown) => {
      const validProjectId = validateEntityId(projectId, 'Project ID')
      const validThreadId = validateEntityId(threadId, 'Thread ID')
      const validReportId = validateEntityId(reportId, 'Audit report ID')
      const validVersion = requireVersion(version)
      const report = auditEngine.getVersion(
        validProjectId,
        validThreadId,
        validReportId,
        validVersion
      )
      if (!report) throw new Error('Audit report version not found')
      const targetPath = await auditEngine.markdownPath(
        validProjectId,
        validThreadId,
        validReportId,
        validVersion
      )
      await atomicWrite(targetPath, exportAuditReportMarkdown(report))
      const config = await storage.getConfig()
      await editorService.openInEditor(config.preferredEditor, targetPath, 'file')
      return targetPath
    }
  )
  privileged(
    'audit:revealInFiles',
    async (_event, projectId: unknown, threadId: unknown, reportId: unknown, version: unknown) => {
      const validProjectId = validateEntityId(projectId, 'Project ID')
      const validThreadId = validateEntityId(threadId, 'Thread ID')
      const validReportId = validateEntityId(reportId, 'Audit report ID')
      const validVersion = requireVersion(version)
      const report = auditEngine.getVersion(
        validProjectId,
        validThreadId,
        validReportId,
        validVersion
      )
      if (!report) throw new Error('Audit report version not found')
      const targetPath = await auditEngine.markdownPath(
        validProjectId,
        validThreadId,
        validReportId,
        validVersion
      )
      await atomicWrite(targetPath, exportAuditReportMarkdown(report))
      return targetPath
    }
  )
  ipcMain.handle(
    'spec:addAnnotation',
    (_, projectId: unknown, threadId: unknown, specId: unknown, version: unknown, input: unknown) =>
      specEngine.addAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateAnnotationInput(input)
      )
  )
  ipcMain.handle(
    'spec:addDecisionComment',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      action: unknown,
      body: unknown
    ) => {
      if (action !== 'review' && action !== 'implement') {
        throw new TypeError('Specification decision action must be review or implement')
      }
      return specEngine.addDecisionComment(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        action,
        requireString(body, 'Specification decision comment')
      )
    }
  )
  ipcMain.handle(
    'spec:resolveAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      annotationId: unknown
    ) =>
      specEngine.resolveAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Annotation ID')
      )
  )
  ipcMain.handle(
    'spec:updateAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      annotationId: unknown,
      body: unknown
    ) =>
      specEngine.updateAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Annotation ID'),
        requireString(body, 'Annotation body')
      )
  )
  ipcMain.handle(
    'spec:setContext',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      context: unknown
    ) =>
      specEngine.setContext(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateContext(context)
      )
  )
  ipcMain.handle(
    'spec:captureContext',
    async (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      type: unknown,
      selectedPath?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const safeSpecId = validateEntityId(specId, 'Specification ID')
      const safeVersion = requireVersion(version)
      if (type !== 'project_file' && type !== 'project_rule' && type !== 'attachment') {
        throw new TypeError('Invalid specification context type')
      }
      const safeType: CapturableSpecContextType = type

      const current = await specEngine.getVersion(
        safeProjectId,
        safeThreadId,
        safeSpecId,
        safeVersion
      )
      if (!current) throw new Error('Specification version not found')

      const project = await projectManager.getProject(safeProjectId)
      if (!project) throw new Error(`Project not found: ${safeProjectId}`)

      let sourcePath: string
      if (selectedPath !== undefined) {
        const requestedPath = requireString(selectedPath, 'Selected context path')
        sourcePath =
          safeType === 'attachment'
            ? requestedPath
            : await projectFilesService.resolveForExternalEditor(safeProjectId, requestedPath)
      } else {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
        if (win && !win.isFocused()) win.focus()
        const options: Electron.OpenDialogOptions = {
          title:
            safeType === 'attachment'
              ? 'Attach Context File'
              : safeType === 'project_rule'
                ? 'Select Project Rule'
                : 'Select Project File',
          properties: ['openFile'],
          ...(safeType !== 'attachment' && project.path ? { defaultPath: project.path } : {})
        }
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options)
        if (result.canceled || result.filePaths.length === 0) return null
        sourcePath = result.filePaths[0]
      }

      const reference = await specContextService.capture(safeProjectId, sourcePath, safeType)
      const duplicate =
        reference.path !== undefined &&
        current.context.some(
          (candidate) => candidate.type === reference.type && candidate.path === reference.path
        )
      if (duplicate) return current
      return specEngine.setContext(safeProjectId, safeThreadId, safeSpecId, safeVersion, [
        ...current.context,
        reference
      ])
    }
  )
  ipcMain.handle(
    'spec:getContextAttachments',
    async (_, projectId: unknown, threadId: unknown, specId: unknown, version: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const current = await specEngine.getVersion(
        safeProjectId,
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version)
      )
      if (!current) throw new Error('Specification version not found')
      return specContextService.promptAttachments(safeProjectId, current.context)
    }
  )
  ipcMain.handle(
    'spec:importMarkdown',
    async (_, projectId: unknown, threadId: unknown, specId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const safeSpecId =
        specId === undefined ? undefined : validateEntityId(specId, 'Specification ID')
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const options: Electron.OpenDialogOptions = {
        title: 'Import Engineering Specification',
        properties: ['openFile'],
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null

      const selectedPath = result.filePaths[0]
      const imported = importEngineeringSpecMarkdown(
        await readFile(selectedPath, { encoding: 'utf-8' })
      )
      const provenance: NewSpecProvenance = {
        source: 'markdown_import',
        actor: 'user',
        importedFilename: basename(selectedPath)
      }
      return safeSpecId
        ? await specEngine.createVersion({
            projectId: safeProjectId,
            threadId: safeThreadId,
            specId: safeSpecId,
            content: imported.content,
            provenance
          })
        : await specEngine.createDraft({
            projectId: safeProjectId,
            threadId: safeThreadId,
            content: imported.content,
            provenance
          })
    }
  )
  ipcMain.handle('spec:exportMarkdown', async (_, rawSpec: unknown) => {
    const spec = validateEngineeringSpecInput(rawSpec)
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const options: Electron.SaveDialogOptions = {
      title: 'Export Engineering Specification',
      defaultPath: `${spec.id}-v${spec.version}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await atomicWrite(result.filePath, exportEngineeringSpecMarkdown(spec))
    return result.filePath
  })
  privileged('spec:openInEditor', async (_event, rawSpec: unknown) => {
    const spec = validateEngineeringSpecInput(rawSpec)
    const persisted = await specEngine.getVersion(
      spec.projectId,
      spec.threadId,
      spec.id,
      spec.version
    )
    if (!persisted) throw new Error('Specification version not found')
    const targetPath = await specEngine.markdownPath(
      spec.projectId,
      spec.threadId,
      spec.id,
      spec.version
    )
    await atomicWrite(targetPath, exportEngineeringSpecMarkdown(spec))
    const config = await storage.getConfig()
    await editorService.openInEditor(config.preferredEditor, targetPath, 'file')
    return targetPath
  })
  privileged('spec:revealInFiles', async (_event, rawSpec: unknown) => {
    const spec = validateEngineeringSpecInput(rawSpec)
    const persisted = await specEngine.getVersion(
      spec.projectId,
      spec.threadId,
      spec.id,
      spec.version
    )
    if (!persisted) throw new Error('Specification version not found')
    const targetPath = await specEngine.markdownPath(
      spec.projectId,
      spec.threadId,
      spec.id,
      spec.version
    )
    await atomicWrite(targetPath, exportEngineeringSpecMarkdown(spec))
    return targetPath
  })

  // ─── System dialogs ────────────────────────────────────────────────────────
  ipcMain.handle('dialog:pickFolder', async () => {
    try {
      // Always resolve a parent window so the sheet attaches and comes to the front.
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      if (win && !win.isFocused()) win.focus()

      // Open at the last folder the user picked, instead of the OS default (Downloads).
      const config = await storage.getConfig()
      const options: Electron.OpenDialogOptions = {
        title: 'Select Project Folder',
        properties: ['openDirectory', 'createDirectory'],
        ...(config.lastFolderDialogPath ? { defaultPath: config.lastFolderDialogPath } : {})
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null

      // Remember the chosen folder for next time and record it as a
      // user-approved scope for reveal/preview operations.
      config.lastFolderDialogPath = result.filePaths[0]
      privilegedIpc.registerUserSelectedRoot(result.filePaths[0])
      await storage.saveConfig(config)

      return result.filePaths[0]
    } catch (error) {
      Logger.error('dialog:pickFolder failed:', error)
      return null
    }
  })

  ipcMain.handle('clipboard:writeText', (_event, text: unknown) => {
    if (typeof text !== 'string') throw new TypeError('Clipboard text must be a string')
    clipboard.writeText(text)
  })

  ipcMain.handle('clipboard:readText', () => clipboard.readText())

  ipcMain.handle('clipboard:saveImage', async () => {
    try {
      const image = clipboard.readImage()
      if (image.isEmpty()) return null
      const tempDir = await mkdtemp(join(tmpdir(), 'cio-clipboard-'))
      const tempPath = join(tempDir, 'pasted-image.png')
      await writeFile(tempPath, image.toPNG())
      privilegedIpc.registerUserSelectedFile(tempPath)
      return tempPath
    } catch (error) {
      Logger.error('clipboard:saveImage failed:', error)
      return null
    }
  })

  ipcMain.handle('dialog:pickFile', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      if (win && !win.isFocused()) win.focus()

      const config = await storage.getConfig()
      const options: Electron.OpenDialogOptions = {
        title: 'Attach File',
        defaultPath: config.lastAttachmentDialogPath,
        properties: ['openFile'],
        filters: [
          { name: 'All Files', extensions: ['*'] },
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']
          },
          {
            name: 'Documents',
            extensions: [
              'pdf',
              'doc',
              'docx',
              'xls',
              'xlsx',
              'ppt',
              'pptx',
              'txt',
              'csv',
              'md',
              'json',
              'xml',
              'yaml',
              'yml'
            ]
          },
          { name: 'Videos', extensions: ['mp4', 'webm', 'mov', 'avi', 'mkv'] },
          { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] },
          { name: 'Archives', extensions: ['zip', 'tar', 'gz', '7z', 'rar'] }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      config.lastAttachmentDialogPath = dirname(result.filePaths[0])
      privilegedIpc.registerUserSelectedFile(result.filePaths[0])
      await storage.saveConfig(config)
      return result.filePaths[0]
    } catch (error) {
      Logger.error('dialog:pickFile failed:', error)
      return null
    }
  })

  ipcMain.handle('dialog:pickImage', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      if (win && !win.isFocused()) win.focus()

      const options: Electron.OpenDialogOptions = {
        title: 'Select Project Icon',
        properties: ['openFile'],
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'ico', 'jpg', 'jpeg', 'svg', 'webp']
          }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      privilegedIpc.registerUserSelectedFile(result.filePaths[0])
      return result.filePaths[0]
    } catch (error) {
      Logger.error('dialog:pickImage failed:', error)
      return null
    }
  })

  privileged('shell:openExternal', (_event, url: unknown) => {
    try {
      const safeUrl = privilegedIpc.validateExternalUrl(url)
      void shell.openExternal(safeUrl)
    } catch (error) {
      Logger.error('shell:openExternal rejected unsafe URL:', error)
    }
  })

  // Resolve website favicons for external links. Hostnames are validated at the
  // IPC boundary; data URLs returned by the resolver are image content only.
  ipcMain.handle('web:favicon', async (_event, rawHostnames: unknown) => {
    const hostnames = validateFaviconHostnames(rawHostnames)
    return resolveFavicons(hostnames)
  })

  // Reveal a chat artifact (uploaded or agent-created file) in the system file
  // manager. The path must resolve inside a registered project, the config root,
  // or a user-selected scope.
  privileged('shell:revealPath', async (_event, path: unknown) => {
    try {
      const safePath = await privilegedIpc.resolveScopedPath(path)
      shell.showItemInFolder(safePath)
      return true
    } catch (error) {
      Logger.error('shell:revealPath rejected out-of-scope path:', error)
      return false
    }
  })

  // Read a file from disk and return it as a data URL — used for local previews
  // without persisting anything to project storage. Only scoped paths are read.
  const MIME_MAP: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf'
  }

  // Read a local file into bytes for renderer-side media previews. The preload
  // no longer reads files directly; it delegates here so the path can be
  // constrained to registered project, config-root, or user-selected scopes.
  privileged('file:read', async (_event, filePath: unknown) => {
    try {
      const safePath = await privilegedIpc.resolveScopedPath(filePath)
      const buffer = await readFile(safePath)
      return new Uint8Array(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      )
    } catch (error) {
      Logger.error('file:read rejected out-of-scope path:', error)
      return null
    }
  })

  privileged('file:readAsDataUrl', async (_event, filePath: unknown) => {
    try {
      const safePath = await privilegedIpc.resolveScopedPath(filePath)
      const ext = extname(safePath).toLowerCase()
      const mime = MIME_MAP[ext] ?? 'application/octet-stream'
      const buffer = await readFile(safePath)
      return `data:${mime};base64,${buffer.toString('base64')}`
    } catch (error) {
      Logger.error('file:readAsDataUrl rejected out-of-scope path:', error)
      return null
    }
  })

  ipcMain.handle('diagnostics:export', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: `Export ${APP_NAME} Diagnostics`,
          defaultPath: `${APP_SLUG}-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
      : await dialog.showSaveDialog({
          title: `Export ${APP_NAME} Diagnostics`,
          defaultPath: `${APP_SLUG}-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
    if (result.canceled || !result.filePath) return null

    await diagnosticsService.writeReport(result.filePath, {
      appName: app.getName(),
      appVersion: app.getVersion(),
      platform: process.platform,
      platformRelease: release(),
      architecture: process.arch,
      electronVersion: process.versions.electron
    })
    return result.filePath
  })

  // ─── Projects ───────────────────────────────────────────────────────────
  ipcMain.handle('project:create', async (_, rawInput: unknown) => {
    const input = validateCreateProjectInput(rawInput)
    const config = await storage.getConfig()
    return projectManager.createProject({
      ...input,
      threadLimit: input.threadLimit ?? config.threadLimit
    })
  })
  ipcMain.handle('project:get', (_, projectId: string) => projectManager.getProject(projectId))
  ipcMain.handle('project:list', () => projectManager.listProjects())
  ipcMain.handle('project:ensureInbox', () => projectManager.ensureInboxProject())
  ipcMain.handle('scope:get', (_, projectId: unknown) =>
    scopeManager.getBoard(validateEntityId(projectId, 'Project ID'))
  )
  ipcMain.handle('scope:save', (_, projectId: unknown, board: unknown) =>
    scopeManager.saveBoard(validateEntityId(projectId, 'Project ID'), validateScopeBoard(board))
  )
  ipcMain.handle(
    'project:update',
    async (_, projectId: string, input: Partial<CreateProjectInput>) => {
      const project = await projectManager.updateProject(projectId, input)
      projectFilesService.invalidateProject(projectId)
      return project
    }
  )
  ipcMain.handle('project:delete', async (_, projectId: string) => {
    await projectManager.deleteProject(projectId)
    projectFilesService.invalidateProject(projectId)
  })
  ipcMain.handle('project:getIcon', (_, projectId: string) =>
    projectManager.getIconDataUrl(projectId)
  )
  ipcMain.handle('project:setIcon', (_, projectId: string, sourcePath: string) =>
    projectManager.setIcon(projectId, sourcePath)
  )
  ipcMain.handle('project:clearIcon', (_, projectId: string) => projectManager.clearIcon(projectId))
  ipcMain.handle('project:setPinned', (_, projectId: unknown, pinned: unknown) =>
    projectManager.setPinned(
      validateEntityId(projectId, 'Project ID'),
      validateBoolean(pinned, 'Pinned')
    )
  )
  ipcMain.handle('project:reorder', (_, orderedIds: unknown) =>
    projectManager.reorderProjects(validateStringArray(orderedIds, 'Ordered IDs'))
  )
  ipcMain.handle('projectFiles:list', (_, projectId: unknown, relativeDirectory: unknown) =>
    projectFilesService.listDirectory(
      validateEntityId(projectId, 'Project ID'),
      requireString(relativeDirectory, 'Project directory', true)
    )
  )
  ipcMain.handle(
    'projectFiles:search',
    (_, projectId: unknown, query: unknown, category: unknown) => {
      if (category !== 'all' && category !== 'rules') {
        throw new TypeError('Project file search category must be all or rules')
      }
      return projectFilesService.searchFiles(
        validateEntityId(projectId, 'Project ID'),
        requireString(query, 'Project file search query', true),
        category
      )
    }
  )
  ipcMain.handle(
    'projectFiles:resolveCitationPaths',
    (_, projectId: unknown, candidates: unknown) =>
      projectFilesService.resolveCitationPaths(
        validateEntityId(projectId, 'Project ID'),
        validateStringArray(candidates, 'Citation paths')
      )
  )
  ipcMain.handle(
    'projectFiles:create',
    (_, projectId: unknown, relativeDirectory: unknown, name: unknown) =>
      projectFilesService.createFile(
        validateEntityId(projectId, 'Project ID'),
        requireString(relativeDirectory, 'Project directory', true),
        requireString(name, 'File name')
      )
  )
  ipcMain.handle('projectFiles:delete', async (_, projectId: unknown, relativePath: unknown) => {
    const validatedProjectId = validateEntityId(projectId, 'Project ID')
    const target = await projectFilesService.resolveForTrash(
      validatedProjectId,
      requireString(relativePath, 'Project file path')
    )
    await shell.trashItem(target)
    projectFilesService.invalidateProject(validatedProjectId)
  })
  ipcMain.handle('projectFiles:info', (_, projectId: unknown, relativePath: unknown) =>
    projectFilesService.getInfo(
      validateEntityId(projectId, 'Project ID'),
      requireString(relativePath, 'Project file path')
    )
  )
  privileged(
    'projectFiles:openInEditor',
    async (_event, projectId: unknown, relativePath: unknown) => {
      const config = await storage.getConfig()
      const target = await projectFilesService.resolveForExternalEditor(
        validateEntityId(projectId, 'Project ID'),
        requireString(relativePath, 'Project file path')
      )
      await editorService.openInEditor(config.preferredEditor, target, 'file')
    }
  )
  privileged(
    'projectFiles:openInEditorWith',
    async (_event, projectId: unknown, relativePath: unknown, editorId: unknown) => {
      if (typeof editorId !== 'string' || !EDITOR_IDS.has(editorId as EditorId)) {
        throw new TypeError('Unknown editor')
      }
      const target = await projectFilesService.resolveForExternalEditor(
        validateEntityId(projectId, 'Project ID'),
        requireString(relativePath, 'Project file path')
      )
      await editorService.openInEditor(editorId as EditorId, target, 'file')
    }
  )
  ipcMain.handle('projectFiles:read', (_, projectId: unknown, relativePath: unknown) =>
    projectFilesService.readText(
      validateEntityId(projectId, 'Project ID'),
      requireString(relativePath, 'Project file path')
    )
  )
  ipcMain.handle(
    'projectFiles:rename',
    (_, projectId: unknown, relativePath: unknown, name: unknown) =>
      projectFilesService.renameEntry(
        validateEntityId(projectId, 'Project ID'),
        requireString(relativePath, 'Project file path'),
        requireString(name, 'File name')
      )
  )
  ipcMain.handle(
    'projectFiles:paste',
    (
      _,
      sourceProjectId: unknown,
      sourcePath: unknown,
      destinationProjectId: unknown,
      destinationDirectory: unknown,
      mode: unknown
    ) => {
      if (mode !== 'copy' && mode !== 'move') {
        throw new TypeError('Project file transfer mode must be copy or move')
      }
      return projectFilesService.pasteEntry(
        validateEntityId(sourceProjectId, 'Project ID'),
        requireString(sourcePath, 'Source file path'),
        validateEntityId(destinationProjectId, 'Project ID'),
        requireString(destinationDirectory, 'Destination directory', true),
        mode
      )
    }
  )
  ipcMain.handle(
    'projectFiles:importPaths',
    (_, projectId: unknown, sourcePaths: unknown, destinationDirectory: unknown) =>
      projectFilesService.importPaths(
        validateEntityId(projectId, 'Project ID'),
        validateStringArray(sourcePaths, 'Import source paths'),
        requireString(destinationDirectory, 'Destination directory', true)
      )
  )
  ipcMain.handle(
    'projectFiles:save',
    (_, projectId: unknown, relativePath: unknown, content: unknown, expectedRevision: unknown) => {
      const revision = requireString(expectedRevision, 'Project file revision')
      if (!/^[a-f0-9]{64}$/u.test(revision)) {
        throw new TypeError('Project file revision must be a SHA-256 digest')
      }
      return projectFilesService.writeText(
        validateEntityId(projectId, 'Project ID'),
        requireString(relativePath, 'Project file path'),
        requireString(content, 'Project file content', true),
        revision
      )
    }
  )
  ipcMain.handle('projectFiles:saveAs', async (_, projectId: unknown, relativePath: unknown) => {
    const safeRelativePath = requireString(relativePath, 'Project file path')
    const textFile = await projectFilesService.readText(
      validateEntityId(projectId, 'Project ID'),
      safeRelativePath
    )
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const options: Electron.SaveDialogOptions = {
      title: 'Save file as',
      defaultPath: basename(safeRelativePath),
      filters: [{ name: 'All Files', extensions: ['*'] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await atomicWrite(result.filePath, textFile.content)
    return result.filePath
  })
  ipcMain.handle('repository:preflight', (_, projectPath: string) =>
    repositoryService.preflight(projectPath)
  )
  ipcMain.handle('repository:init', (_, projectPath: string) =>
    repositoryService.initialize(projectPath)
  )
  ipcMain.handle('repository:remoteOrigin', (_, projectPath: string) =>
    repositoryService.getRemoteOrigin(projectPath)
  )

  // ─── Git management ─────────────────────────────────────────────────────
  const resolveProjectPath = async (projectId: string): Promise<string> => {
    const project = await projectManager.getProject(projectId)
    if (!project?.path) throw new Error(`Project not found: ${projectId}`)
    return project.path
  }
  ipcMain.handle('git:status', async (_, projectId: unknown) =>
    gitService.getStatus(await resolveProjectPath(validateEntityId(projectId, 'Project ID')))
  )
  ipcMain.handle(
    'git:diff',
    async (_, projectId: unknown, relativePath: unknown, staged: unknown) =>
      gitService.getDiff(
        await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
        validateGitRelativePath(relativePath),
        validateBoolean(staged, 'Staged')
      )
  )
  ipcMain.handle('git:stage', async (_, projectId: unknown, paths: unknown) =>
    gitService.stage(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateGitPathArray(paths)
    )
  )
  ipcMain.handle('git:unstage', async (_, projectId: unknown, paths: unknown) =>
    gitService.unstage(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateGitPathArray(paths)
    )
  )
  ipcMain.handle('git:commit', async (_, projectId: unknown, message: unknown) =>
    gitService.commit(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateCommitMessage(message)
    )
  )
  ipcMain.handle('git:init', async (_, projectId: unknown) =>
    gitService.initialize(await resolveProjectPath(validateEntityId(projectId, 'Project ID')))
  )
  ipcMain.handle('git:branches', async (_, projectId: unknown) =>
    gitService.listBranches(await resolveProjectPath(validateEntityId(projectId, 'Project ID')))
  )
  ipcMain.handle('git:checkout', async (_, projectId: unknown, branch: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const status = await gitService.checkout(
      await resolveProjectPath(safeProjectId),
      validateBranchName(branch)
    )
    // Keep thread.branch coherent when the app drives a checkout (D7): update
    // every owned thread whose working directory is this project.
    const threads = await threadManager.listThreads(safeProjectId)
    for (const thread of threads) {
      if (thread.workingDirectory) {
        const branchName = await repositoryService.getCurrentBranch(thread.workingDirectory)
        if (branchName) await threadManager.setBranch(safeProjectId, thread.id, branchName)
      }
    }
    return status
  })
  ipcMain.handle('git:createBranch', async (_, projectId: unknown, name: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const status = await gitService.createBranch(
      await resolveProjectPath(safeProjectId),
      validateBranchName(name)
    )
    const threads = await threadManager.listThreads(safeProjectId)
    for (const thread of threads) {
      if (thread.workingDirectory) {
        const branchName = await repositoryService.getCurrentBranch(thread.workingDirectory)
        if (branchName) await threadManager.setBranch(safeProjectId, thread.id, branchName)
      }
    }
    return status
  })
  ipcMain.handle('git:deleteBranch', async (_, projectId: unknown, name: unknown) => {
    return gitService.deleteBranch(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateBranchName(name)
    )
  })
  ipcMain.handle('git:log', async (_, projectId: unknown, limit?: unknown) => {
    const bounded = validateBoundedInteger(limit ?? 50, 'Log limit', 1, 200)
    return gitService.log(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      bounded
    )
  })
  ipcMain.handle('git:commitDiff', async (_, projectId: unknown, hash: unknown) => {
    const safeHash = validateEntityId(hash, 'Commit hash')
    return gitService.commitDiff(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      safeHash
    )
  })
  ipcMain.handle(
    'git:commitFileDiff',
    async (_, projectId: unknown, hash: unknown, relativePath: unknown) =>
      gitService.commitFileDiff(
        await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
        validateEntityId(hash, 'Commit hash'),
        validateGitRelativePath(relativePath)
      )
  )
  ipcMain.handle('git:amend', async (_, projectId: unknown, message: unknown) =>
    gitService.amend(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateCommitMessage(message)
    )
  )
  ipcMain.handle('git:reset', async (_, projectId: unknown, mode: unknown, target?: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const status = await gitService.reset(
      await resolveProjectPath(safeProjectId),
      validateGitResetMode(mode),
      target === undefined ? undefined : validateEntityId(target, 'Reset target')
    )
    // A reset moves the branch, so keep thread.branch coherent like checkout.
    const threads = await threadManager.listThreads(safeProjectId)
    for (const thread of threads) {
      if (thread.workingDirectory) {
        const branchName = await repositoryService.getCurrentBranch(thread.workingDirectory)
        if (branchName) await threadManager.setBranch(safeProjectId, thread.id, branchName)
      }
    }
    return status
  })
  ipcMain.handle('git:deleteCommit', async (_, projectId: unknown, target: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const status = await gitService.deleteCommit(
      await resolveProjectPath(safeProjectId),
      validateEntityId(target, 'Delete commit target')
    )
    const threads = await threadManager.listThreads(safeProjectId)
    for (const thread of threads) {
      if (thread.workingDirectory) {
        const branchName = await repositoryService.getCurrentBranch(thread.workingDirectory)
        if (branchName) await threadManager.setBranch(safeProjectId, thread.id, branchName)
      }
    }
    return status
  })
  ipcMain.handle('git:getIdentity', async (_, projectId: unknown) =>
    gitService.getIdentity(await resolveProjectPath(validateEntityId(projectId, 'Project ID')))
  )
  ipcMain.handle('git:setIdentity', async (_, projectId: unknown, identity: unknown) => {
    const safe = validateGitIdentity(identity)
    return gitService.setIdentity(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      safe.name,
      safe.email
    )
  })
  // ─── Git remotes, sync & credentials ────────────────────────────────────
  const gitCredentialRef = (projectId: string): string => `git_pat_${projectId}`
  const gitCredentialStatus = async (projectId: string) => ({
    configured: await vault.exists(gitCredentialRef(projectId)),
    secureStorageAvailable: vault.isAvailable()
  })
  ipcMain.handle('git:remotes', async (_, projectId: unknown) =>
    gitService.listRemotes(await resolveProjectPath(validateEntityId(projectId, 'Project ID')))
  )
  ipcMain.handle('git:addRemote', async (_, projectId: unknown, name: unknown, url: unknown) =>
    gitService.addRemote(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateRemoteName(name),
      validateRemoteUrl(url)
    )
  )
  ipcMain.handle('git:removeRemote', async (_, projectId: unknown, name: unknown) =>
    gitService.removeRemote(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateRemoteName(name)
    )
  )
  ipcMain.handle('git:fetch', async (_, projectId: unknown) =>
    gitService.fetch(await resolveProjectPath(validateEntityId(projectId, 'Project ID')))
  )
  ipcMain.handle('git:pull', async (_, projectId: unknown) =>
    gitService.pull(await resolveProjectPath(validateEntityId(projectId, 'Project ID')))
  )
  ipcMain.handle('git:push', async (_, projectId: unknown, options: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeOptions = validatePushOptions(options)
    // Resolve the vaulted PAT in main only; the token never crosses IPC.
    const tokenRef = gitCredentialRef(safeProjectId)
    const token = (await vault.exists(tokenRef)) ? await vault.resolve(tokenRef) : undefined
    return gitService.push(await resolveProjectPath(safeProjectId), { ...safeOptions, token })
  })
  ipcMain.handle('git:getCredentialStatus', async (_, projectId: unknown) =>
    gitCredentialStatus(validateEntityId(projectId, 'Project ID'))
  )
  ipcMain.handle('git:setCredential', async (_, projectId: unknown, token: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > 16_384 ||
      token.includes('\0')
    ) {
      throw new TypeError('Provider token must be a string of at most 16384 characters')
    }
    await vault.save(token, gitCredentialRef(safeProjectId))
    return gitCredentialStatus(safeProjectId)
  })
  ipcMain.handle('git:removeCredential', async (_, projectId: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    await vault.remove(gitCredentialRef(safeProjectId))
    return gitCredentialStatus(safeProjectId)
  })

  // ─── Merge / rebase / stash (Phase 4) ───────────────────────────────────
  ipcMain.handle('git:merge', async (_, projectId: unknown, target: unknown) =>
    gitService.merge(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateMergeTarget(target)
    )
  )
  ipcMain.handle('git:rebase', async (_, projectId: unknown, target: unknown) =>
    gitService.rebase(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateMergeTarget(target)
    )
  )
  ipcMain.handle('git:stash', async (_, projectId: unknown, message?: unknown, paths?: unknown) =>
    gitService.stash(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateStashMessage(message),
      paths === undefined ? undefined : validateGitPathArray(paths)
    )
  )
  ipcMain.handle('git:ignore', async (_, projectId: unknown, paths: unknown) =>
    gitService.ignore(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateGitPathArray(paths)
    )
  )
  ipcMain.handle('git:discard', async (_, projectId: unknown, paths: unknown) =>
    gitService.discard(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateGitPathArray(paths)
    )
  )
  ipcMain.handle('git:stashList', async (_, projectId: unknown) =>
    gitService.listStashes(await resolveProjectPath(validateEntityId(projectId, 'Project ID')))
  )
  ipcMain.handle('git:stashPop', async (_, projectId: unknown, id?: unknown) =>
    gitService.popStash(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateStashId(id)
    )
  )
  ipcMain.handle('git:stashDrop', async (_, projectId: unknown, id?: unknown) =>
    gitService.dropStash(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateStashId(id)
    )
  )
  ipcMain.handle('git:stashDiff', async (_, projectId: unknown, id: unknown) =>
    gitService.stashDiff(
      await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
      validateStashId(id) ?? ''
    )
  )
  ipcMain.handle(
    'git:stashFileDiff',
    async (_, projectId: unknown, id: unknown, relativePath: unknown) =>
      gitService.stashFileDiff(
        await resolveProjectPath(validateEntityId(projectId, 'Project ID')),
        validateStashId(id) ?? '',
        validateGitRelativePath(relativePath)
      )
  )
  ipcMain.handle('git:abortMerge', async (_, projectId: unknown) =>
    gitService.abortMerge(await resolveProjectPath(validateEntityId(projectId, 'Project ID')))
  )
  ipcMain.handle('git:abortRebase', async (_, projectId: unknown) =>
    gitService.abortRebase(await resolveProjectPath(validateEntityId(projectId, 'Project ID')))
  )

  // ─── Pull requests (GitHub-first) ───────────────────────────────────────
  const providerForProject = async (projectId: string): Promise<GitProvider | null> => {
    const oauthToken = await githubAuthService.resolveToken()
    if (oauthToken) {
      return new GitHubProvider(oauthToken, undefined, () => githubAuthService.resolveToken(true))
    }
    const tokenRef = gitCredentialRef(projectId)
    if (!(await vault.exists(tokenRef))) return null
    const token = await vault.resolve(tokenRef)
    return new GitHubProvider(token)
  }
  const remoteIdentity = async (projectId: string): Promise<{ owner: string; repo: string }> => {
    const remoteUrl = await repositoryService.getRemoteOrigin(await resolveProjectPath(projectId))
    const provider = new GitHubProvider('')
    const identity = provider.resolveRepositoryIdentity(remoteUrl ?? '')
    if (!identity) {
      throw new Error('No GitHub remote (origin) is configured for this project')
    }
    return identity
  }
  ipcMain.handle('pr:create', async (_, projectId: unknown, input: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const provider = await providerForProject(safeProjectId)
    if (!provider) throw new Error('Configure a GitHub token first (Git panel → Credentials)')
    const identity = await remoteIdentity(safeProjectId)
    const draft = validatePrCreateInput(input)
    return provider.createPullRequest({
      owner: identity.owner,
      repo: identity.repo,
      title: draft.title,
      body: draft.body,
      head: draft.head,
      base: draft.base,
      draft: draft.draft
    })
  })
  ipcMain.handle(
    'pr:list',
    async (_, projectId: unknown, owner: unknown, repo: unknown, state?: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) return []
      return provider.listPullRequests({
        owner: validateBoundedString(owner, 'PR owner', 1, 128),
        repo: validateBoundedString(repo, 'PR repository', 1, 128),
        ...(state === undefined ? {} : { state: validatePrState(state) })
      })
    }
  )
  ipcMain.handle(
    'pr:merge',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      method: unknown
    ) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Configure a GitHub token first (Git panel → Credentials)')
      return provider.mergePullRequest({
        owner: validateBoundedString(owner, 'PR owner', 1, 128),
        repo: validateBoundedString(repo, 'PR repository', 1, 128),
        pullNumber: validatePrNumber(pullNumber),
        method: validateMergeMethod(method)
      })
    }
  )

  /** Shared preamble for every single-PR channel: provider + validated target. */
  const pullRequestTarget = async (
    projectId: unknown,
    owner: unknown,
    repo: unknown,
    pullNumber: unknown
  ): Promise<{ provider: GitProvider; owner: string; repo: string; pullNumber: number }> => {
    const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
    if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
    return {
      provider,
      owner: validateBoundedString(owner, 'PR owner', 1, 128),
      repo: validateBoundedString(repo, 'PR repository', 1, 128),
      pullNumber: validatePrNumber(pullNumber)
    }
  }

  ipcMain.handle(
    'pr:page',
    async (_, projectId: unknown, owner: unknown, repo: unknown, state: unknown, page: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      const safePage = validatePrPage(page)
      if (!provider) return { items: [], page: safePage, hasMore: false }
      return provider.listPullRequestPage({
        owner: validateBoundedString(owner, 'PR owner', 1, 128),
        repo: validateBoundedString(repo, 'PR repository', 1, 128),
        state: validatePrState(state),
        page: safePage,
        perPage: PR_PAGE_SIZE
      })
    }
  )

  ipcMain.handle(
    'pr:bundle',
    async (_, projectId: unknown, owner: unknown, repo: unknown, pullNumber: unknown) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      // Fetched together so the sidebar renders one complete view, not six
      // staggered ones. Optional surfaces degrade to empty rather than failing
      // the whole bundle (e.g. a repo with checks disabled).
      const [detail, commits, comments, reviews, reviewComments, files, checks] = await Promise.all(
        [
          provider.getPullRequest(target),
          provider.listPullRequestCommits(target).catch(() => []),
          provider.listPullRequestComments(target).catch(() => []),
          provider.listPullRequestReviews(target).catch(() => []),
          provider.listPullRequestReviewComments(target).catch(() => []),
          provider.listPullRequestFiles(target).catch(() => []),
          provider
            .getPullRequestChecks(target)
            .catch(() => ({ state: 'none' as const, checks: [] }))
        ]
      )
      return {
        detail,
        commits,
        comments,
        reviews,
        reviewComments,
        files,
        checks,
        fetchedAt: Date.now()
      }
    }
  )

  ipcMain.handle(
    'pr:commitFiles',
    async (_, projectId: unknown, owner: unknown, repo: unknown, sha: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      return provider.getCommitFiles(
        {
          owner: validateBoundedString(owner, 'PR owner', 1, 128),
          repo: validateBoundedString(repo, 'PR repository', 1, 128)
        },
        validateEntityId(sha, 'Commit sha')
      )
    }
  )

  ipcMain.handle('pr:agentReport', async (_, projectId: unknown, pullNumber: unknown) => {
    const projectPath = await resolveProjectPath(validateEntityId(projectId, 'Project ID'))
    const reportPath = join(
      projectPath,
      '.cio',
      'git',
      'pr',
      String(validatePrNumber(pullNumber)),
      'review.md'
    )
    const threadId = await readFile(join(dirname(reportPath), 'thread.json'), 'utf-8')
      .then((raw) => {
        const parsed: unknown = JSON.parse(raw)
        const value =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)['threadId']
            : null
        return typeof value === 'string' ? value : null
      })
      .catch(() => null)
    try {
      const [content, stats] = await Promise.all([readFile(reportPath, 'utf-8'), stat(reportPath)])
      return { path: reportPath, content, updatedAt: stats.mtimeMs, threadId }
    } catch {
      // No report yet — the agent hasn't finished (or hasn't been asked).
      return { path: reportPath, content: '', updatedAt: null, threadId }
    }
  })

  ipcMain.handle(
    'pr:comment',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      return provider.createPullRequestComment({
        ...target,
        body: validatePrCommentBody(body)
      })
    }
  )

  ipcMain.handle(
    'pr:review',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      event: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const verdict = validatePrReviewEvent(event)
      const text = validatePrCommentBody(body, true)
      // GitHub rejects a REQUEST_CHANGES or COMMENT review without a body.
      if (verdict !== 'APPROVE' && !text.trim()) {
        throw new Error('Leave a comment explaining the requested changes')
      }
      await provider.createPullRequestReview({ ...target, event: verdict, body: text })
    }
  )

  ipcMain.handle(
    'pr:reviewWorkspace',
    async (_, projectId: unknown, pullNumber: unknown, threadId?: unknown) => {
      const projectPath = await resolveProjectPath(validateEntityId(projectId, 'Project ID'))
      const directory = join(projectPath, '.cio', 'git', 'pr', String(validatePrNumber(pullNumber)))
      await mkdir(directory, { recursive: true })
      if (threadId !== undefined) {
        // Remember which thread owns this review so the sidebar can jump back
        // into the conversation after a restart.
        await writeFile(
          join(directory, 'thread.json'),
          JSON.stringify({ threadId: validateEntityId(threadId, 'Thread ID') }, null, 2),
          'utf-8'
        )
      }
      return directory
    }
  )

  ipcMain.handle('github:authStatus', () => githubAuthService.status())
  ipcMain.handle('github:startDeviceFlow', () => githubAuthService.startDeviceFlow())
  ipcMain.handle('github:poll', async (_, deviceCode: unknown) =>
    githubAuthService.pollAccessToken(validateBoundedString(deviceCode, 'Device code', 1, 256))
  )
  ipcMain.handle('github:logout', () => githubAuthService.logout())

  ipcMain.handle('checkpoint:list', (_, projectId: string, threadId: string) =>
    checkpointManager.listSummaries(projectId, threadId)
  )
  ipcMain.handle(
    'checkpoint:diff',
    (_, projectId: unknown, threadId: unknown, checkpointId: unknown, path: unknown) =>
      checkpointManager.getFileDiff(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(checkpointId, 'Checkpoint ID'),
        requireString(path, 'Checkpoint path')
      )
  )
  ipcMain.handle(
    'checkpoint:rollback',
    async (_, projectId: string, threadId: string, checkpointId: string) => {
      await checkpointManager.rollback(projectId, threadId, checkpointId)
      return checkpointManager.listSummaries(projectId, threadId)
    }
  )
  ipcMain.handle(
    'checkpoint:rollbackPaths',
    async (_, projectId: unknown, threadId: unknown, checkpointId: unknown, paths: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      await checkpointManager.rollbackPaths(
        safeProjectId,
        safeThreadId,
        validateEntityId(checkpointId, 'Checkpoint ID'),
        validateStringArray(paths, 'Checkpoint paths')
      )
      return checkpointManager.listSummaries(safeProjectId, safeThreadId)
    }
  )
  privileged('project:openInEditor', async (_event, projectId: string) => {
    const project = await projectManager.getProject(projectId)
    if (!project?.path) return

    const config = await storage.getConfig()
    await editorService.openInEditor(config.preferredEditor, project.path)
  })

  // ─── Editors ───────────────────────────────────────────────────────────
  editorService.warmUp()
  ipcMain.handle('editors:detect', () => editorService.detect())
  ipcMain.handle('editors:getPreferred', async () => (await storage.getConfig()).preferredEditor)
  ipcMain.handle('editors:setPreferred', async (_, editorId: unknown) => {
    const patch = validateAppConfigPatch({ preferredEditor: editorId })
    const config = { ...(await storage.getConfig()), ...patch }
    await storage.saveConfig(config)
  })

  // ─── Threads ────────────────────────────────────────────────────────────
  ipcMain.handle('thread:create', async (_, input: unknown) => {
    const validated = validateCreateThreadInput(input)
    if (validated.settings?.engineeringMode) {
      const baseSettings = { ...validated.settings }
      delete baseSettings.loopAuditor
      const defaults = (await storage.getConfig()).agentDefaults
      validated.settings = {
        ...baseSettings,
        ...(defaults.seniorEngineer ?? {}),
        ...(defaults.auditor ? { loopAuditor: defaults.auditor } : {})
      }
    }
    const thread = await threadManager.createThread(validated)
    if (thread.workingDirectory) {
      const branch = await repositoryService.getCurrentBranch(thread.workingDirectory)
      if (branch) {
        await threadManager.setBranch(thread.projectId, thread.id, branch)
        thread.branch = branch
      }
    }
    return thread
  })
  ipcMain.handle('thread:get', (_, projectId: string, threadId: string) =>
    threadManager.getThread(projectId, threadId)
  )
  ipcMain.handle('thread:list', (_, projectId: string) => threadManager.listThreads(projectId))
  ipcMain.handle('thread:listAll', () => threadManager.listAllThreads())
  ipcMain.handle('threads:search', (_, query: unknown, options?: unknown) => {
    const safeQuery = requireString(query, 'Search query')
    const safeOptions: { projectId?: string; limit?: number } = {}
    if (options !== undefined) {
      if (!isRecord(options)) throw new TypeError('Search options must be an object')
      if (options.projectId !== undefined) {
        safeOptions.projectId = validateEntityId(options.projectId, 'Project ID')
      }
      if (options.limit !== undefined) {
        safeOptions.limit = validateBoundedInteger(options.limit, 'Search limit', 1, 100)
      }
    }
    return threadManager.searchThreads(safeQuery, safeOptions)
  })
  // Mirror-only transcript read — fast disk access, never touches a harness driver.
  ipcMain.handle(
    'thread:loadMessages',
    (_, projectId: unknown, threadId: unknown, before?: unknown, limit: unknown = 40) => {
      let safeBefore: ThreadMessageCursor | undefined
      if (before !== undefined) {
        if (!isRecord(before)) throw new TypeError('Message cursor must be an object')
        safeBefore = {
          createdAt: validateBoundedInteger(
            before.createdAt,
            'Message cursor timestamp',
            0,
            Number.MAX_SAFE_INTEGER
          ),
          id: validateBoundedString(before.id, 'Message cursor ID', 1, 512)
        }
      }
      return threadManager.loadMessagePage(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        safeBefore,
        validateBoundedInteger(limit, 'Message page limit', 1, 100)
      )
    }
  )
  // Mirror-only centered transcript read for quick jumps to arbitrary messages.
  ipcMain.handle(
    'thread:loadMessagesAround',
    (_, projectId: unknown, threadId: unknown, anchorId: unknown, limit: unknown = 40) => {
      return threadManager.loadMessagePageAround(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateBoundedString(anchorId, 'Message ID', 1, 512),
        validateBoundedInteger(limit, 'Message page limit', 1, 100)
      )
    }
  )
  // Lightweight full user-message history for the header quick-jump list.
  ipcMain.handle('thread:loadUserMessages', (_, projectId: unknown, threadId: unknown) =>
    threadManager.loadUserMessages(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle('thread:update', (_, projectId: string, threadId: string, input) =>
    threadManager.updateThread(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      validateThreadUpdateInput(input)
    )
  )
  ipcMain.handle('thread:delete', async (_, projectId: unknown, threadId: unknown) => {
    const validProjectId = validateEntityId(projectId, 'Project ID')
    const validThreadId = validateEntityId(threadId, 'Thread ID')
    await threadManager.deleteThread(validProjectId, validThreadId)
    await memoryService.deleteThreadMemory(validProjectId, validThreadId)
  })
  ipcMain.handle(
    'thread:dismissSpecReview',
    async (_, projectId: unknown, threadId: unknown, specId: unknown, specVersion: unknown) => {
      const validProjectId = validateEntityId(projectId, 'Project ID')
      const validThreadId = validateEntityId(threadId, 'Thread ID')
      const validSpecId = validateEntityId(specId, 'Specification ID')
      const validSpecVersion = requireVersion(specVersion)
      const workflow = await specEngine.getWorkflowState(validProjectId, validThreadId)
      if (
        workflow?.activeSpecId !== validSpecId ||
        workflow.activeSpecVersion !== validSpecVersion
      ) {
        throw new Error('Only the active specification can be dismissed')
      }
      return threadManager.dismissSpecReview(
        validProjectId,
        validThreadId,
        validSpecId,
        validSpecVersion
      )
    }
  )
  ipcMain.handle('thread:setStatus', (_, projectId: unknown, threadId: unknown, status: unknown) =>
    threadManager.setStatus(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      validateThreadStatus(status)
    )
  )
  ipcMain.handle('thread:setPinned', (_, projectId: unknown, threadId: unknown, pinned: unknown) =>
    threadManager.setPinned(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      validateBoolean(pinned, 'Pinned')
    )
  )
  ipcMain.handle(
    'thread:setContextUsage',
    (_, projectId: unknown, threadId: unknown, usage: unknown) => {
      const parsed = parseThreadContextUsage(usage)
      if (!parsed) throw new TypeError('Thread context usage is malformed')
      threadManager.setContextUsage(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        parsed
      )
    }
  )
  ipcMain.handle('thread:harnessUsage', (_, projectId: unknown, threadId: unknown) =>
    threadManager.harnessUsageFor(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle(
    'thread:setArchived',
    (_, projectId: unknown, threadId: unknown, archived: unknown) =>
      threadManager.setArchived(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateBoolean(archived, 'Archived')
      )
  )
  ipcMain.handle('thread:markRead', (_, projectId: string, threadId: string) =>
    threadManager.markRead(projectId, threadId)
  )
  ipcMain.handle('thread:reorder', (_, projectId: unknown, orderedIds: unknown) =>
    threadManager.reorderThreads(
      validateEntityId(projectId, 'Project ID'),
      validateStringArray(orderedIds, 'Ordered IDs')
    )
  )
  ipcMain.handle(
    'thread:reorderScope',
    (_, projectId: unknown, bucketId: unknown, slice: unknown, orderedIds: unknown) =>
      threadManager.reorderScopeThreads(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(bucketId, 'Scope bucket ID'),
        validateScopeSlice(slice),
        validateStringArray(orderedIds, 'Ordered scope thread IDs')
      )
  )
  ipcMain.handle(
    'thread:updateSettings',
    (_, projectId: unknown, threadId: unknown, settings: unknown) =>
      threadManager.updateSettings(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateThreadSettings(settings)
      )
  )
  ipcMain.handle(
    'thread:fork',
    async (
      _,
      projectId: unknown,
      threadId: unknown,
      title: unknown,
      checkpointId?: unknown,
      messageId?: unknown,
      targetProjectId?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const safeTitle = requireString(title, 'Fork title')
      const safeCheckpointId =
        checkpointId === undefined
          ? undefined
          : validateEntityId(checkpointId, 'Checkpoint ID', 256)
      const safeMessageId =
        messageId === undefined ? undefined : validateEntityId(messageId, 'Message ID', 256)
      const safeTargetProjectId =
        targetProjectId === undefined
          ? undefined
          : validateEntityId(targetProjectId, 'Target project ID')
      await chatEngine?.loadMessages(safeProjectId, safeThreadId)
      const forked = await threadManager.forkThread(
        safeProjectId,
        safeThreadId,
        safeTitle,
        safeCheckpointId,
        safeMessageId,
        safeTargetProjectId
      )
      if (forked.workingDirectory) {
        const branch = await repositoryService.getCurrentBranch(forked.workingDirectory)
        if (branch) {
          await threadManager.setBranch(forked.projectId, forked.id, branch)
          forked.branch = branch
        }
      }
      return forked
    }
  )

  // ─── History ────────────────────────────────────────────────────────────
  ipcMain.handle(
    'history:append',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      role: unknown,
      content: string,
      metadata?: HistoryEntry['metadata']
    ) =>
      historyEngine.append(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateHistoryRole(role),
        content,
        metadata
      )
  )
  ipcMain.handle('history:load', (_, projectId: string, threadId: string, limit?: number) =>
    historyEngine.load(projectId, threadId, limit)
  )

  // ─── Search ─────────────────────────────────────────────────────────────
  ipcMain.handle('history:search', (_, query: unknown, projectId?: unknown, limit?: unknown) =>
    historyEngine.search(
      requireString(query, 'Search query'),
      typeof projectId === 'string' ? projectId : undefined,
      typeof limit === 'number' ? limit : 20
    )
  )
  ipcMain.handle('project:search', (_, query: unknown, limit?: unknown) =>
    projectManager.search(
      requireString(query, 'Search query'),
      typeof limit === 'number' ? limit : 20
    )
  )

  // ─── Plan & Checklist ───────────────────────────────────────────────────
  ipcMain.handle('plan:save', (_, projectId: string, threadId: string, content: string) =>
    planEngine.savePlan(projectId, threadId, content)
  )
  ipcMain.handle('plan:get', (_, projectId: string, threadId: string) =>
    planEngine.getPlan(projectId, threadId)
  )
  ipcMain.handle('plan:approve', (_, projectId: string, threadId: string) =>
    planEngine.approvePlan(projectId, threadId)
  )
  ipcMain.handle(
    'checklist:generate',
    (_, projectId: string, threadId: string, planContent: string) =>
      planEngine.generateChecklist(projectId, threadId, planContent)
  )
  ipcMain.handle('checklist:get', (_, projectId: string, threadId: string) =>
    planEngine.getChecklist(projectId, threadId)
  )
  ipcMain.handle(
    'checklist:updateItem',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      itemId: unknown,
      status: unknown,
      evidence?: string
    ) =>
      planEngine.updateChecklistItem(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(itemId, 'Checklist item ID'),
        validateChecklistItemStatus(status),
        evidence
      )
  )

  // ─── Updater ────────────────────────────────────────────────────────────
  if (updaterService) {
    ipcMain.handle('updater:check', () => updaterService.checkForUpdates())

    ipcMain.handle('updater:getStatus', () => updaterService.status)

    ipcMain.handle('updater:download', () => updaterService.downloadUpdate())

    ipcMain.handle('updater:install', () => updaterService.quitAndInstall())
  }
}
