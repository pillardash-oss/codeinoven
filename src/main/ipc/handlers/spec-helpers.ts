import { validateMemoryConfig } from '../../chat/memory-service'
import { validateEntityId } from '../ipc-validation'
import { isRecord, requireString, requireVersion, validateStringArray } from './shared'
import type { AddSpecAnnotationInput, NewSpecProvenance } from '../../../lib/engines/spec-engine'
import type {
  AddBrainstormAnnotationInput,
  NewBrainstormProvenance
} from '../../../lib/engines/brainstorm-engine'
import type { AddPrdAnnotationInput, NewPrdProvenance } from '../../../lib/engines/prd-engine'
import type { AddAuditAnnotationInput } from '../../../lib/engines/audit-engine'
import type { AddAssignmentAnnotationInput } from '../../../lib/engines/assignment-engine'
import type {
  AssignmentModelSelection,
  AssignmentPhase,
  AssignmentPlanContent,
  AssignmentProvenance,
  AssignmentTask,
  AuditSectionId,
  BrainstormSectionId,
  EngineeringSpec,
  EngineeringSpecContent,
  MemoryEntry,
  PrdSectionId,
  ScopeChoice,
  SpecContextReference,
  SpecSectionId,
  SpecValidationCode,
  SpecValidationIssue
} from '../../../lib/types'

export type NewAssignmentProvenance = Omit<AssignmentProvenance, 'createdAt' | 'parentVersion'>

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
const PRD_SECTIONS = new Set<PrdSectionId>([
  'problem',
  'goals',
  'non_goals',
  'users_and_use_cases',
  'product_requirements',
  'experience_flow',
  'acceptance_criteria',
  'dependencies',
  'risks',
  'open_questions'
])
const AUDIT_SECTIONS = new Set<AuditSectionId>([
  'executive_summary',
  'findings',
  'resolution_recommendation',
  'conclusion'
])

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
    ...(value.accountId === undefined
      ? {}
      : { accountId: requireString(value.accountId, `${label} account ID`) }),
    thinkingLevel: thinkingLevel as AssignmentModelSelection['thinkingLevel']
  }
}

function validateAssignmentWorkerScope(value: unknown, label: string): ScopeChoice {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  const mode = requireString(value.mode, `${label} mode`)
  if (mode === 'inherit' || mode === 'dedicated') return { mode }
  if (mode === 'scope') {
    return { mode, bucketId: requireString(value.bucketId, `${label} scope bucket ID`) }
  }
  throw new TypeError(`${label} mode is invalid`)
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
      // Carried through untouched: the choice is made on the review surface and
      // must survive the save/approve round trip, exactly like the task model.
      // `workerScopeBucketId` is not accepted from the renderer at all; only the
      // engine records where a dispatched worker actually runs.
      ...(task.workerScope === undefined
        ? {}
        : {
            workerScope: validateAssignmentWorkerScope(
              task.workerScope,
              `Assignment task ${index} worker scope`
            )
          }),
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

function validatePrdProvenance(value: unknown): NewPrdProvenance {
  if (!isRecord(value)) throw new TypeError('PRD provenance must be an object')
  if (value.source !== 'agent' && value.source !== 'manual') {
    throw new TypeError('Invalid PRD provenance source')
  }
  return {
    source: value.source,
    actor: requireString(value.actor, 'PRD provenance actor'),
    ...(typeof value.harnessId === 'string' ? { harnessId: value.harnessId } : {}),
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
    ...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {}),
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

function validatePrdAnnotationInput(value: unknown): AddPrdAnnotationInput {
  if (!isRecord(value)) throw new TypeError('PRD annotation input must be an object')
  if (typeof value.section !== 'string' || !PRD_SECTIONS.has(value.section as PrdSectionId)) {
    throw new TypeError('Invalid PRD section')
  }
  return {
    section: value.section as PrdSectionId,
    body: requireString(value.body, 'PRD annotation body'),
    author: requireString(value.author, 'PRD annotation author'),
    ...(value.quote === undefined ? {} : { quote: requireString(value.quote, 'Annotation quote') }),
    ...(value.startLine === undefined
      ? {}
      : { startLine: validateOptionalAnnotationLine(value.startLine, 'Annotation start line') }),
    ...(value.endLine === undefined
      ? {}
      : { endLine: validateOptionalAnnotationLine(value.endLine, 'Annotation end line') }),
    ...(value.startOffset === undefined
      ? {}
      : {
          startOffset: validateOptionalAnnotationOffset(
            value.startOffset,
            'Annotation start offset'
          )
        }),
    ...(value.endOffset === undefined
      ? {}
      : { endOffset: validateOptionalAnnotationOffset(value.endOffset, 'Annotation end offset') })
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

/** Font family ids offered in Appearance settings. */

export {
  validateAssignmentModel,
  validateAssignmentContent,
  validateAssignmentWorkerScope,
  validateAssignmentProvenance,
  validateSpecContent,
  validateProvenance,
  validateBrainstormProvenance,
  validateBrainstormAnnotationInput,
  validatePrdProvenance,
  validatePrdAnnotationInput,
  validateSpecValidationIssue,
  validateAnnotationInput,
  validateAssignmentAnnotationInput,
  validateAuditAnnotationInput,
  validateContext,
  validateEngineeringSpecInput,
  validateMemoryEntries,
  optionalMemoryEntityId,
  requireTimestamp
}
