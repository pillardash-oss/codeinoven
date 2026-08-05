import type {
  EngineeringSpec,
  SpecSectionId,
  SpecValidationIssue,
  SpecValidationResult
} from '../types'

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/
const UNC_PATH = /^(?:\\\\|\/\/)/

function isBlank(value: string): boolean {
  return value.trim().length === 0
}

function addRequired(
  issues: SpecValidationIssue[],
  section: SpecSectionId,
  path: string,
  message: string
): void {
  issues.push({ code: 'required', section, path, message })
}

function validateRequiredString(
  value: string,
  issues: SpecValidationIssue[],
  section: SpecSectionId,
  path: string,
  label: string
): void {
  if (isBlank(value)) {
    addRequired(issues, section, path, `${label} is required.`)
  }
}

function validateRequiredStringList(
  values: string[],
  issues: SpecValidationIssue[],
  section: SpecSectionId,
  path: string,
  label: string
): void {
  if (values.length === 0) {
    addRequired(issues, section, path, `${label} must contain at least one item.`)
    return
  }

  values.forEach((value, index) => {
    validateRequiredString(value, issues, section, `${path}[${index}]`, `${label} item`)
  })
}

export function isSafeProjectRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    WINDOWS_ABSOLUTE_PATH.test(path) ||
    UNC_PATH.test(path)
  ) {
    return false
  }

  const segments = path.replaceAll('\\', '/').split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function validateProjectPath(
  value: string,
  issues: SpecValidationIssue[],
  section: SpecSectionId,
  path: string
): void {
  if (!isSafeProjectRelativePath(value)) {
    issues.push({
      code: 'invalid_path',
      section,
      path,
      message: `"${value}" must be a safe project-relative path without traversal.`
    })
  }
}

function validateUniqueId(
  id: string,
  section: SpecSectionId,
  path: string,
  label: string,
  seenIds: Map<string, string>,
  issues: SpecValidationIssue[]
): void {
  if (isBlank(id)) {
    addRequired(issues, section, path, `${label} id is required.`)
    return
  }

  const previousPath = seenIds.get(id)
  if (previousPath) {
    issues.push({
      code: 'duplicate_id',
      section,
      path,
      message: `${label} id "${id}" duplicates ${previousPath}.`
    })
    return
  }

  seenIds.set(id, path)
}

function issueSignature(issue: SpecValidationIssue): string {
  return `${issue.code}\u0000${issue.section}\u0000${issue.path}\u0000${issue.message}`
}

/** Validates whether a specification is complete enough to enter approval or compilation. */
export function validateEngineeringSpec(spec: EngineeringSpec): SpecValidationResult {
  const issues: SpecValidationIssue[] = []
  const seenIds = new Map<string, string>()
  const content = spec.content

  validateRequiredString(content.problem, issues, 'problem', 'content.problem', 'Problem')
  validateRequiredString(
    content.resolutionSummary,
    issues,
    'resolution',
    'content.resolutionSummary',
    'Resolution summary'
  )

  if (content.phases.length === 0) {
    addRequired(
      issues,
      'resolution',
      'content.phases',
      'Resolution must contain at least one phase.'
    )
  }

  content.phases.forEach((phase, phaseIndex) => {
    const phasePath = `content.phases[${phaseIndex}]`
    validateUniqueId(phase.id, 'resolution', `${phasePath}.id`, 'Phase', seenIds, issues)
    validateRequiredString(phase.title, issues, 'resolution', `${phasePath}.title`, 'Phase title')
    validateRequiredString(
      phase.objective,
      issues,
      'resolution',
      `${phasePath}.objective`,
      'Phase objective'
    )
    validateRequiredString(
      phase.commit,
      issues,
      'commit_pattern',
      `${phasePath}.commit`,
      'Phase commit'
    )

    if (phase.checkpoints.length === 0) {
      addRequired(
        issues,
        'resolution',
        `${phasePath}.checkpoints`,
        'Each phase must contain at least one checkpoint.'
      )
    }

    phase.checkpoints.forEach((checkpoint, checkpointIndex) => {
      const checkpointPath = `${phasePath}.checkpoints[${checkpointIndex}]`
      validateUniqueId(
        checkpoint.id,
        'resolution',
        `${checkpointPath}.id`,
        'Checkpoint',
        seenIds,
        issues
      )
      validateRequiredString(
        checkpoint.description,
        issues,
        'resolution',
        `${checkpointPath}.description`,
        'Checkpoint description'
      )
      if (isBlank(checkpoint.evidence)) {
        issues.push({
          code: 'missing_evidence',
          section: 'resolution',
          path: `${checkpointPath}.evidence`,
          message: `Checkpoint "${checkpoint.id || checkpointIndex + 1}" requires observable evidence.`
        })
      }
    })

    if (phase.fileOperations.length === 0) {
      addRequired(
        issues,
        'resolution',
        `${phasePath}.fileOperations`,
        'Each phase must declare at least one expected file operation.'
      )
    }

    phase.fileOperations.forEach((fileOperation, operationIndex) => {
      const operationPath = `${phasePath}.fileOperations[${operationIndex}]`
      validateProjectPath(fileOperation.path, issues, 'resolution', `${operationPath}.path`)
      validateRequiredString(
        fileOperation.reason,
        issues,
        'resolution',
        `${operationPath}.reason`,
        'File operation reason'
      )
    })
  })

  validateRequiredStringList(
    content.successCriteria,
    issues,
    'success_criteria',
    'content.successCriteria',
    'Success criteria'
  )
  validateRequiredString(
    content.testStrategy,
    issues,
    'test_strategy',
    'content.testStrategy',
    'Test strategy'
  )
  validateRequiredStringList(
    content.documentationRequirements,
    issues,
    'documentation',
    'content.documentationRequirements',
    'Documentation requirements'
  )
  validateRequiredString(
    content.commitPattern,
    issues,
    'commit_pattern',
    'content.commitPattern',
    'Commit pattern'
  )
  validateRequiredStringList(
    content.constraints,
    issues,
    'constraints_risks',
    'content.constraints',
    'Constraints'
  )
  validateRequiredStringList(content.risks, issues, 'constraints_risks', 'content.risks', 'Risks')

  spec.annotations.forEach((annotation, index) => {
    const path = `annotations[${index}]`
    validateUniqueId(annotation.id, annotation.section, `${path}.id`, 'Annotation', seenIds, issues)
  })

  spec.context.forEach((reference, index) => {
    const path = `context[${index}]`
    validateUniqueId(
      reference.id,
      'constraints_risks',
      `${path}.id`,
      'Context reference',
      seenIds,
      issues
    )
    validateRequiredString(
      reference.label,
      issues,
      'constraints_risks',
      `${path}.label`,
      'Context reference label'
    )
    if (reference.path !== undefined) {
      validateProjectPath(reference.path, issues, 'constraints_risks', `${path}.path`)
    }
  })

  const dismissedIssues = new Set(
    (spec.dismissedValidationIssues ?? []).map((issue) => issueSignature(issue))
  )
  const activeIssues = issues.filter((issue) => !dismissedIssues.has(issueSignature(issue)))
  return { valid: activeIssues.length === 0, issues: activeIssues }
}
