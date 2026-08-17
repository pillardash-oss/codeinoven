import type { AssignmentPlan, AssignmentTask } from '../types'

function mermaidLabel(value: string): string {
  return value.replace(/"/gu, "'").replace(/\r?\n/gu, ' ')
}

function taskDetails(task: AssignmentTask): string[] {
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
    plan.content.summary,
    '',
    `Status: **${plan.status}**`,
    ''
  ]

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
    for (const task of plan.content.tasks.filter((candidate) => candidate.phaseId === phase.id)) {
      lines.push(...taskDetails(task))
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
