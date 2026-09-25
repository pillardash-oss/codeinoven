import type { AssignmentPlan, AssignmentTask, ScopeChoice } from '../types'

function mermaidLabel(value: string): string {
  return value.replace(/"/gu, "'").replace(/\r?\n/gu, ' ')
}

/**
 * How a worker scope reads in the reviewable Assignment. The export is a pure
 * function with no board to resolve names against, so a named scope is written
 * as its bucket ID, exactly like a task's thread ID.
 */
function scopeLabel(scope: ScopeChoice): string {
  if (scope.mode === 'inherit') return 'Inherited from the Sr. Engineer'
  if (scope.mode === 'dedicated') return 'New worktree at dispatch'
  return `Chosen scope \`${scope.bucketId}\``
}

/** A scope choice compared by value, so a task's own pick is only printed when
 *  it actually departs from the level above it. */
function sameScope(left: ScopeChoice, right: ScopeChoice | undefined): boolean {
  if (right === undefined || left.mode !== right.mode) return false
  if (left.mode === 'scope' && right.mode === 'scope') return left.bucketId === right.bucketId
  return true
}

function taskDetails(task: AssignmentTask, inheritedScope?: ScopeChoice): string[] {
  const worker = task.workerName ? ` (${task.workerName})` : ''
  const model = task.model
    ? `${task.model.harnessId}/${task.model.providerId}/${task.model.modelId} · ${task.model.thinkingLevel}`
    : 'phase default'
  return [
    `### ${task.title}${worker}`,
    '',
    task.description,
    '',
    `- Status: ${task.status}`,
    `- Work pass: ${task.workKind === 'rework' ? `Rework ${task.reworkCycle ?? 1}` : 'Initial'}`,
    `- Assignment version: ${task.workAssignmentVersion ?? 'Not recorded'}`,
    `- Owner: ${task.owner === 'senior' ? 'Sr. Engineer' : 'Worker'}`,
    `- Depends on: ${task.dependsOn.join(', ') || 'None'}`,
    `- Model: ${model}`,
    // Written only when the task departs from the scope of its phase and
    // Assignment, so the artifact points at the exceptions rather than
    // repeating one line on every task. `inherit` is not a departure, it defers
    // to the level above.
    ...(task.workerScope === undefined ||
    task.workerScope.mode === 'inherit' ||
    sameScope(task.workerScope, inheritedScope)
      ? []
      : [`- Scope: ${scopeLabel(task.workerScope)}`]),
    `- Thread: ${task.threadId ?? 'Not assigned'}`,
    '',
    task.info ? `> ${task.info}` : '',
    ''
  ].filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
}

export function exportAssignmentMarkdown(plan: AssignmentPlan): string {
  const lines = [
    `# Assignment: ${plan.content.title}`,
    '',
    '## TL;DR',
    '',
    plan.content.summary,
    '',
    `Status: **${plan.status}**`,
    ''
  ]

  if (plan.content.workerScope !== undefined && plan.content.workerScope.mode !== 'inherit') {
    lines.push(`Worker scope: ${scopeLabel(plan.content.workerScope)}`, '')
  }

  if (plan.auditCycle) {
    lines.push('## Audit cycle', '', `Status: **${plan.auditCycle.status}**`)
    if (plan.auditCycle.reworkCycle !== undefined) {
      lines.push(`Rework cycle: ${plan.auditCycle.reworkCycle}`)
    }
    if (plan.auditCycle.startedAt !== undefined) {
      lines.push(`Started: ${new Date(plan.auditCycle.startedAt).toISOString()}`)
    }
    if (plan.auditCycle.failedAt !== undefined) {
      lines.push(`Failed: ${new Date(plan.auditCycle.failedAt).toISOString()}`)
    }
    if (plan.auditCycle.failure) {
      lines.push('', '### Failure', '')
      lines.push(...plan.auditCycle.failure.split(/\r?\n/u).map((line) => `> ${line}`))
    }
    lines.push('')
  }

  lines.push('```mermaid', 'flowchart TD')

  for (const task of plan.content.tasks) {
    lines.push(`  ${task.id}["${mermaidLabel(task.title)}"]`)
    for (const dependency of task.dependsOn) {
      lines.push(`  ${dependency} --> ${task.id}`)
    }
  }
  lines.push('```', '')

  for (const phase of plan.content.phases) {
    lines.push(`## ${phase.title}`, '', phase.description, '')
    if (phase.info) lines.push(`> ${phase.info}`, '')
    if (phase.workerScope !== undefined && phase.workerScope.mode !== 'inherit') {
      lines.push(`Worker scope: ${scopeLabel(phase.workerScope)}`, '')
    }
    const inheritedScope = [phase.workerScope, plan.content.workerScope].find(
      (candidate): candidate is ScopeChoice =>
        candidate !== undefined && candidate.mode !== 'inherit'
    )
    for (const task of plan.content.tasks.filter((candidate) => candidate.phaseId === phase.id)) {
      lines.push(...taskDetails(task, inheritedScope))
    }
  }

  return `${lines.join('\n').trim()}\n`
}

export function exportAuditChecklist(task: AssignmentTask): string {
  const lines = [
    `# Audit checklist: ${task.title}`,
    '',
    `Assignment task: \`${task.id}\``,
    '',
    ...task.auditChecklist.flatMap((item) => [`- [ ] ${item}`]),
    '',
    '## Worker evidence',
    '',
    '- Summary:',
    '- Test baseline:',
    '- Test check:',
    '- Commit:',
    ''
  ]
  return lines.join('\n')
}
