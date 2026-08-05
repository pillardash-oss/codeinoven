import type {
  AssignmentModelSelection,
  AssignmentPhase,
  AssignmentPlanContent,
  AssignmentTask,
  AssignmentValidationIssue,
  AssignmentValidationResult
} from '../types'

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Generated assignment ${label} is missing`)
  }
  return value.trim()
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Generated assignment ${label} must be a string array`)
  }
  return value.map((item) => item.trim()).filter(Boolean)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function generatedModel(value: unknown): AssignmentModelSelection | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Generated assignment model is invalid')
  const thinkingLevel = requiredString(value.thinkingLevel, 'model thinking level')
  if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(thinkingLevel)) {
    throw new Error('Generated assignment model thinking level is invalid')
  }
  return {
    harnessId: requiredString(value.harnessId, 'model harness'),
    providerId: requiredString(value.providerId, 'model provider'),
    modelId: requiredString(value.modelId, 'model'),
    thinkingLevel: thinkingLevel as AssignmentModelSelection['thinkingLevel']
  }
}

export function parseGeneratedAssignmentContent(value: unknown): AssignmentPlanContent {
  if (!isRecord(value) || !Array.isArray(value.phases) || !Array.isArray(value.tasks)) {
    throw new Error('Generated assignment is invalid')
  }
  const phases: AssignmentPhase[] = value.phases.map((phase) => {
    if (!isRecord(phase)) throw new Error('Generated assignment phase is invalid')
    return {
      id: requiredString(phase.id, 'phase ID'),
      title: requiredString(phase.title, 'phase title'),
      description: requiredString(phase.description, 'phase description'),
      ...(typeof phase.info === 'string' && phase.info.trim() ? { info: phase.info.trim() } : {}),
      ...(phase.defaultModel === undefined
        ? {}
        : { defaultModel: generatedModel(phase.defaultModel) })
    }
  })
  const tasks: AssignmentTask[] = value.tasks.map((task) => {
    if (!isRecord(task)) throw new Error('Generated assignment task is invalid')
    const owner = requiredString(task.owner, 'task owner')
    if (owner !== 'senior' && owner !== 'worker') {
      throw new Error('Generated assignment task owner is invalid')
    }
    return {
      id: requiredString(task.id, 'task ID'),
      phaseId: requiredString(task.phaseId, 'task phase ID'),
      title: requiredString(task.title, 'task title'),
      description: requiredString(task.description, 'task description'),
      ...(typeof task.info === 'string' && task.info.trim() ? { info: task.info.trim() } : {}),
      prompt: requiredString(task.prompt, 'task prompt'),
      owner,
      dependsOn: stringArray(task.dependsOn, 'task dependencies'),
      expectedFiles: stringArray(task.expectedFiles, 'task expected files'),
      auditChecklist: stringArray(task.auditChecklist, 'task audit checklist'),
      ...(task.model === undefined ? {} : { model: generatedModel(task.model) }),
      status: 'planned'
    }
  })
  const content: AssignmentPlanContent = {
    title: requiredString(value.title, 'title'),
    summary: requiredString(value.summary, 'summary'),
    phases,
    tasks
  }
  const validation = validateAssignment(content)
  if (!validation.valid) {
    throw new Error(validation.issues.map((issue) => issue.message).join('; '))
  }
  return content
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\/+$/u, '')
  const normalizedRight = right.replace(/\/+$/u, '')
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  )
}

function dependsTransitively(
  taskId: string,
  dependencyId: string,
  tasks: ReadonlyMap<string, AssignmentTask>,
  visited = new Set<string>()
): boolean {
  if (visited.has(taskId)) return false
  visited.add(taskId)
  const task = tasks.get(taskId)
  if (!task) return false
  if (task.dependsOn.includes(dependencyId)) return true
  return task.dependsOn.some((id) => dependsTransitively(id, dependencyId, tasks, visited))
}

export function validateAssignment(content: AssignmentPlanContent): AssignmentValidationResult {
  const issues: AssignmentValidationIssue[] = []
  const phases = new Set<string>()
  const tasks = new Map<string, AssignmentTask>()

  if (!content.title.trim()) {
    issues.push({ code: 'required', path: 'title', message: 'Assignment title is required' })
  }
  if (content.phases.length === 0) {
    issues.push({ code: 'required', path: 'phases', message: 'At least one phase is required' })
  }
  if (content.tasks.length === 0) {
    issues.push({ code: 'required', path: 'tasks', message: 'At least one task is required' })
  }

  for (const [index, phase] of content.phases.entries()) {
    if (!phase.id.trim() || !phase.title.trim()) {
      issues.push({
        code: 'required',
        path: `phases.${index}`,
        message: 'Every phase requires an ID and title'
      })
    }
    if (phases.has(phase.id)) {
      issues.push({
        code: 'duplicate_id',
        path: `phases.${index}.id`,
        message: `Duplicate phase ID: ${phase.id}`
      })
    }
    phases.add(phase.id)
  }

  for (const [index, task] of content.tasks.entries()) {
    if (!task.id.trim() || !task.title.trim() || !task.prompt.trim()) {
      issues.push({
        code: 'required',
        path: `tasks.${index}`,
        message: 'Every task requires an ID, title, and prompt'
      })
    }
    if (tasks.has(task.id)) {
      issues.push({
        code: 'duplicate_id',
        path: `tasks.${index}.id`,
        message: `Duplicate task ID: ${task.id}`
      })
    }
    if (!phases.has(task.phaseId)) {
      issues.push({
        code: 'missing_reference',
        path: `tasks.${index}.phaseId`,
        message: `Unknown phase: ${task.phaseId}`
      })
    }
    tasks.set(task.id, task)
  }

  for (const [index, task] of content.tasks.entries()) {
    for (const dependency of task.dependsOn) {
      if (!tasks.has(dependency)) {
        issues.push({
          code: 'missing_reference',
          path: `tasks.${index}.dependsOn`,
          message: `Task ${task.id} depends on unknown task ${dependency}`
        })
      } else if (dependency === task.id || dependsTransitively(dependency, task.id, tasks)) {
        issues.push({
          code: 'cycle',
          path: `tasks.${index}.dependsOn`,
          message: `Task dependency cycle includes ${task.id} and ${dependency}`
        })
      }
    }
    for (const [pathIndex, path] of task.expectedFiles.entries()) {
      const segments = path.replace(/\\/gu, '/').split('/')
      if (path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) || segments.includes('..')) {
        issues.push({
          code: 'invalid_path',
          path: `tasks.${index}.expectedFiles.${pathIndex}`,
          message: `Expected file must be project-relative: ${path}`
        })
      }
    }
  }

  for (let leftIndex = 0; leftIndex < content.tasks.length; leftIndex += 1) {
    const left = content.tasks[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < content.tasks.length; rightIndex += 1) {
      const right = content.tasks[rightIndex]
      const ordered =
        dependsTransitively(left.id, right.id, tasks) ||
        dependsTransitively(right.id, left.id, tasks)
      if (ordered) continue
      const overlap = left.expectedFiles.find((leftPath) =>
        right.expectedFiles.some((rightPath) => pathsOverlap(leftPath, rightPath))
      )
      if (overlap) {
        issues.push({
          code: 'parallel_file_overlap',
          path: `tasks.${leftIndex}.expectedFiles`,
          message: `Parallel tasks ${left.id} and ${right.id} overlap at ${overlap}`
        })
      }
    }
  }

  return { valid: issues.length === 0, issues }
}
