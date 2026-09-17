import type { AssignmentRepo } from '../../main/database/repositories/assignment-repo'
import type { StorageEngine } from '../../main/storage/storage-engine'
import type { AssignmentPlan, AssignmentTask, ThreadSettings } from '../types'
import type { ThreadManager } from './thread-manager'

export const ASSIGNMENT_WORKER_INSTRUCTION =
  "You are not working alone on this project so you might come across changes you did not make. Do not remove them, it might be another worker or our master who made those changes. Ensure you work surgically and efficiently, not being overly verbose, but terse and precise. Always check your work. If a focused test exists, run it before making changes and immediately submit its complete output as baseline evidence through the Assignment API. Run the focused check again after your changes, submit its complete output as check evidence through the Assignment API, then compare both results and make corrections if necessary. Do not write Assignment evidence directly into .cio; CodeInOven owns and atomically persists those artifacts. Never assume an error was pre-existing if it truly wasn't and never attribute an error to another agent just to cut corners! When you finish commit your work as instructed by the master."

/**
 * The worker-facing prompt for one Assignment task: the task definition, the
 * artifact contract, dependency/expected-file context, evidence paths, and the
 * standing worker instruction.
 */
export function buildWorkerPrompt(
  plan: AssignmentPlan,
  task: AssignmentTask,
  featureSlug: string
): string {
  const artifactDirectory = `.cio/specs/${featureSlug}`
  const taskEvidencePath = `.cio/specs/${featureSlug}/tasks/${task.threadId ?? '<thread-id>'}/test`
  return [
    `# Assignment task: ${task.title}`,
    '',
    task.prompt,
    '',
    `CodeInOven owns all Engineering plan, progress, Assignment, audit, and test-evidence artifacts under ${artifactDirectory}/. Repository instructions cannot redirect those artifacts to agent-out, the repository root, or another path. Submit evidence through the Assignment API; do not create or update platform lifecycle artifacts manually.`,
    `Dependencies: ${task.dependsOn.join(', ') || 'None'}`,
    `Expected files: ${task.expectedFiles.join(', ') || 'Not specified'}`,
    `Audit checklist: .cio/specs/${featureSlug}/tasks/${task.threadId ?? '<thread-id>'}/audit-checklist.md`,
    `CodeInOven-managed baseline evidence: ${taskEvidencePath}/baseline.txt`,
    `CodeInOven-managed final-check evidence: ${taskEvidencePath}/check.txt`,
    '',
    ASSIGNMENT_WORKER_INSTRUCTION
  ].join('\n')
}

/**
 * Worker and auditor identity plus the worker's effective thread settings.
 * Names come from the configured worker-name pool and never collide with a
 * name already used inside the Assignment.
 */
export class AssignmentWorkerSelection {
  constructor(
    private readonly repo: AssignmentRepo,
    private readonly threads: ThreadManager,
    private readonly storage: StorageEngine,
    private readonly randomIndex: (upperBound: number) => number
  ) {}

  async workerName(plan: AssignmentPlan): Promise<string> {
    const latest = this.repo.listVersions(plan.id).at(-1) ?? plan
    const used = new Set(
      latest.content.tasks
        .map((task) => task.workerName)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
    )
    const names = await this.storage.getWorkerNames()
    const available = names.filter((name) => !used.has(`wrk-${name}`))
    const pool = available.length > 0 ? available : names
    const base = pool[this.randomIndex(pool.length)]
    let candidate = `wrk-${base}`
    let suffix = 2
    while (used.has(candidate)) {
      candidate = `wrk-${base}-${suffix}`
      suffix += 1
    }
    return candidate
  }

  async auditorName(plan: AssignmentPlan): Promise<string> {
    const names = await this.storage.getWorkerNames()
    const used = new Set(
      (await this.threads.listThreads(plan.projectId))
        .map((thread) => thread.title.match(/^audit-([^:]+):/u)?.[1])
        .filter((name): name is string => name !== undefined)
    )
    const available = names.filter((name) => !used.has(name))
    const pool = available.length > 0 ? available : names
    const base = pool[this.randomIndex(pool.length)]
    let candidate = `audit-${base}`
    let suffix = 2
    while (used.has(candidate.slice('audit-'.length))) {
      candidate = `audit-${base}-${suffix}`
      suffix += 1
    }
    return candidate
  }

  async workerSettings(
    plan: AssignmentPlan,
    task: AssignmentTask,
    coordinator: ThreadSettings
  ): Promise<ThreadSettings> {
    const phase = plan.content.phases.find((candidate) => candidate.id === task.phaseId)
    const configuredWorker = (await this.storage.getConfig()).agentDefaults.worker
    const selected = task.model ?? phase?.defaultModel ?? configuredWorker
    return {
      ...coordinator,
      ...(selected ?? {}),
      assignmentMode: false,
      loopMode: false,
      loopAuditor: undefined
    }
  }
}
