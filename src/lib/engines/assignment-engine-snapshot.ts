import type { AssignmentPlan, Thread } from '../types'

/**
 * Deterministic JSON of the durable coordinator-visible state: the Assignment
 * plan (phases, tasks, reports, reviews), its assignment-bound threads, and
 * their selected models. `claimCoordinatorSnapshot` hashes this to detect when
 * a completed coordinator turn has already observed the current state.
 */
export function buildCoordinatorSnapshotJson(plan: AssignmentPlan, allThreads: Thread[]): string {
  const threads = allThreads
    .filter((thread) => thread.assignmentId === plan.id)
    .map((thread) => ({
      id: thread.id,
      assignmentRole: thread.assignmentRole,
      assignmentTaskId: thread.assignmentTaskId,
      model: thread.settings
        ? {
            harnessId: thread.settings.harnessId,
            providerId: thread.settings.providerId,
            modelId: thread.settings.modelId,
            thinkingLevel: thread.settings.thinkingLevel
          }
        : null
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const tasks = plan.content.tasks.map((task) => ({
    id: task.id,
    phaseId: task.phaseId,
    title: task.title,
    owner: task.owner,
    dependsOn: task.dependsOn,
    model: task.model,
    status: task.status,
    workerName: task.workerName,
    threadId: task.threadId,
    report: task.report
      ? {
          status: task.report.status,
          summary: task.report.summary,
          evidence: task.report.evidence,
          commitHash: task.report.commitHash
        }
      : null,
    review: task.review
      ? {
          decision: task.review.decision,
          checklistResults: task.review.checklistResults,
          notes: task.review.notes
        }
      : null
  }))
  return JSON.stringify({
    assignmentId: plan.id,
    version: plan.version,
    specId: plan.specId,
    specVersion: plan.specVersion,
    status: plan.status,
    phases: plan.content.phases,
    tasks,
    threads
  })
}
