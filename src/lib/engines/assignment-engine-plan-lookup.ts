import type { AssignmentRepo } from '../../main/database/repositories/assignment-repo'
import type { AssignmentPlan, AssignmentTask } from '../types'
import { AssignmentEngineError } from './assignment-engine-error'

/** Latest durable version for a coordinator, or a typed `not_found`. */
export function requireActivePlan(
  repo: AssignmentRepo,
  projectId: string,
  coordinatorThreadId: string
): AssignmentPlan {
  const active = repo.getActive(projectId, coordinatorThreadId)
  if (!active) throw new AssignmentEngineError('not_found', 'Assignment not found')
  return active
}

/** Latest version by Assignment id, or a typed `not_found`. */
export function requirePlanById(repo: AssignmentRepo, assignmentId: string): AssignmentPlan {
  const versions = repo.listVersions(assignmentId)
  const active = versions.at(-1)
  if (!active) throw new AssignmentEngineError('not_found', 'Assignment not found')
  return active
}

/** One task from a plan, or a typed `not_found`. */
export function requireTaskInPlan(plan: AssignmentPlan, taskId: string): AssignmentTask {
  const task = plan.content.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new AssignmentEngineError('not_found', `Task not found: ${taskId}`)
  return task
}
