import type {
  AssignmentFollowUpTaskInput,
  AssignmentPlan,
  AssignmentPlanContent,
  AssignmentTask,
  AssignmentTaskReview
} from '../types'

/** Completed task ids in a task list, in list order. */
export function completedTaskIds(tasks: AssignmentTask[]): Set<string> {
  return new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id))
}

/** `ready` when every dependency completed, otherwise `blocked`. */
export function dependencyStatus(
  dependsOn: string[],
  completedIds: Set<string>
): AssignmentTask['status'] {
  return dependsOn.every((dependency) => completedIds.has(dependency)) ? 'ready' : 'blocked'
}

/**
 * Tasks as `activate` materializes them: pre-existing worker/thread/report
 * state is dropped so an approved Assignment always starts clean, except for
 * scope-repair re-activation where completed tasks are preserved verbatim.
 */
export function buildActivationTaskGraph(plan: AssignmentPlan): AssignmentTask[] {
  const reworkActivation = plan.auditCycle?.status === 'awaiting_rework_approval'
  const scopeRepairActivation = reworkActivation && plan.auditCycle?.scopeRepair === true
  const completedTaskIds = new Set(
    plan.content.tasks
      .filter((task) => scopeRepairActivation && task.status === 'completed')
      .map((task) => task.id)
  )
  return plan.content.tasks.map((task) => {
    if (scopeRepairActivation && task.status === 'completed') return task
    const {
      statusBeforeStop: _statusBeforeStop,
      workerName: _workerName,
      threadId: _threadId,
      report: _report,
      review: _review,
      startedAt: _startedAt,
      completedAt: _completedAt,
      ...taskDefinition
    } = task
    return {
      ...taskDefinition,
      workKind: task.workKind ?? (reworkActivation ? ('rework' as const) : ('initial' as const)),
      workAssignmentVersion: reworkActivation
        ? plan.version
        : (task.workAssignmentVersion ?? plan.version),
      ...(reworkActivation
        ? { reworkCycle: task.reworkCycle ?? plan.auditCycle?.reworkCycle ?? 1 }
        : {}),
      status:
        task.dependsOn.length === 0 ||
        (scopeRepairActivation &&
          task.dependsOn.every((dependency) => completedTaskIds.has(dependency)))
          ? ('ready' as const)
          : ('blocked' as const)
    }
  })
}

/** Freeze unfinished tasks as `stopped`, remembering how to restore them. */
export function buildStoppedTasks(tasks: AssignmentTask[]): AssignmentTask[] {
  return tasks.map((task) => {
    if (task.status === 'completed') return task
    const statusBeforeStop =
      task.status === 'stopped' ? (task.statusBeforeStop ?? 'attention') : task.status
    return { ...task, status: 'stopped' as const, statusBeforeStop }
  })
}

/** Restore `stopped` tasks to their pre-stop state; `running` falls back to `attention`. */
export function buildResumedTasks(tasks: AssignmentTask[]): AssignmentTask[] {
  return tasks.map((task): AssignmentTask => {
    if (task.status !== 'stopped') return task
    const restoredStatus = task.statusBeforeStop ?? 'attention'
    const { statusBeforeStop: _statusBeforeStop, ...rest } = task
    return {
      ...rest,
      status: restoredStatus === 'running' ? 'attention' : restoredStatus
    }
  })
}

/** Plan status after resuming the stopped task list. */
export function deriveResumedStatus(
  plan: AssignmentPlan,
  tasks: AssignmentTask[]
): AssignmentPlan['status'] {
  const previousStatus =
    plan.statusBeforeStop ??
    (tasks.every((task) => task.status === 'completed') ? 'completed' : 'attention')
  return previousStatus === 'failed' || tasks.some((task) => task.status === 'attention')
    ? 'attention'
    : previousStatus
}

/** Audit cycle restored from its stopped snapshot, or unchanged when not stopped. */
export function restoreStoppedAuditCycle(
  auditCycle: AssignmentPlan['auditCycle']
): AssignmentPlan['auditCycle'] {
  if (!auditCycle) return undefined
  if (auditCycle.status !== 'stopped') return auditCycle
  const restoredStatus = auditCycle.statusBeforeStop ?? 'available'
  const { statusBeforeStop: _statusBeforeStop, ...rest } = auditCycle
  return {
    ...rest,
    status: restoredStatus === 'running' ? ('available' as const) : restoredStatus
  }
}

/** A completed task reopened for post-audit rework. */
export function buildReopenedTask(
  task: AssignmentTask,
  reworkCycle: number,
  assignmentVersion: number
): AssignmentTask {
  return {
    ...task,
    workKind: 'rework',
    reworkCycle,
    workAssignmentVersion: assignmentVersion,
    status: 'rework',
    report: undefined,
    review: undefined,
    completedAt: undefined
  }
}

/** Apply a coordinator review to one task, tagging rework metadata when active. */
export function buildReviewedTask(
  task: AssignmentTask,
  review: AssignmentTaskReview,
  activeReworkCycle: number | undefined,
  assignmentVersion: number,
  now: number
): AssignmentTask {
  return {
    ...task,
    ...(activeReworkCycle
      ? {
          workKind: 'rework' as const,
          reworkCycle: activeReworkCycle,
          workAssignmentVersion: assignmentVersion
        }
      : {}),
    review,
    status:
      review.decision === 'pass' ? 'completed' : review.decision === 'rework' ? 'rework' : 'failed',
    completedAt: review.decision === 'pass' ? now : undefined
  }
}

/** Promote every `blocked` task whose dependencies all completed to `ready`. */
export function unblockDependentTasks(tasks: AssignmentTask[]): AssignmentTask[] {
  const completedIds = completedTaskIds(tasks)
  return tasks.map((task) =>
    task.status === 'blocked' && task.dependsOn.every((dependency) => completedIds.has(dependency))
      ? { ...task, status: 'ready' as const }
      : task
  )
}

export function allTasksCompleted(tasks: AssignmentTask[]): boolean {
  return tasks.every((task) => task.status === 'completed')
}

export function anyTaskFailed(tasks: AssignmentTask[]): boolean {
  return tasks.some((task) => task.status === 'failed')
}

/** Reset a steered worker task to running with its report/review cleared. */
export function buildSteeredTasks(
  tasks: AssignmentTask[],
  taskId: string,
  now: number
): AssignmentTask[] {
  return tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          status: 'running' as const,
          report: undefined,
          review: undefined,
          startedAt: now,
          completedAt: undefined
        }
      : task
  )
}

/** `attention` when any task is not healthy, otherwise `running`. */
export function planStatusAfterSteer(tasks: AssignmentTask[]): AssignmentPlan['status'] {
  return tasks.some((task) => ['attention', 'failed', 'stopped'].includes(task.status))
    ? 'attention'
    : 'running'
}

/** One-based rework cycle for a new rework proposal. */
export function deriveReworkCycle(auditRework: boolean, currentCycle: number | undefined): number {
  return auditRework ? (currentCycle ?? 1) : (currentCycle ?? 0) + 1
}

/**
 * Merge a proposed rework content with the durable execution state of the
 * current content. Scope repair keeps every existing task's live state while
 * adopting the proposal's task definitions.
 */
export function buildReworkAmendedContent(
  current: AssignmentPlanContent,
  proposed: AssignmentPlanContent,
  scopeRepair: boolean
): AssignmentPlanContent {
  const currentTasks = new Map(current.tasks.map((task) => [task.id, task]))
  return {
    ...structuredClone(proposed),
    tasks: proposed.tasks.map((task) => {
      const currentTask = currentTasks.get(task.id)
      if (!scopeRepair || !currentTask) return structuredClone(task)
      if (currentTask.status === 'completed') return structuredClone(currentTask)
      return {
        ...structuredClone(task),
        status: currentTask.status,
        ...(currentTask.workKind ? { workKind: currentTask.workKind } : {}),
        ...(currentTask.reworkCycle ? { reworkCycle: currentTask.reworkCycle } : {}),
        ...(currentTask.workAssignmentVersion
          ? { workAssignmentVersion: currentTask.workAssignmentVersion }
          : {}),
        ...(currentTask.workerName ? { workerName: currentTask.workerName } : {}),
        ...(currentTask.threadId ? { threadId: currentTask.threadId } : {}),
        ...(currentTask.report ? { report: structuredClone(currentTask.report) } : {}),
        ...(currentTask.review ? { review: structuredClone(currentTask.review) } : {}),
        ...(currentTask.startedAt ? { startedAt: currentTask.startedAt } : {}),
        ...(currentTask.completedAt ? { completedAt: currentTask.completedAt } : {})
      }
    })
  }
}

/** Rework draft tasks: completed scope-repair tasks stay put, every other task is rework. */
export function buildReworkDraftTasks(
  amended: AssignmentPlanContent,
  scopeRepair: boolean,
  reworkCycle: number,
  nextVersion: number
): AssignmentTask[] {
  return amended.tasks.map((task) =>
    scopeRepair && task.status === 'completed'
      ? structuredClone(task)
      : {
          ...structuredClone(task),
          workKind: 'rework' as const,
          reworkCycle,
          workAssignmentVersion: nextVersion
        }
  )
}

/** A follow-up task carrying the audit cycle's rework identity. */
export function buildFollowUpTask(
  input: AssignmentFollowUpTaskInput,
  reworkCycle: number,
  assignmentVersion: number
): AssignmentTask {
  return {
    ...structuredClone(input),
    workKind: 'rework',
    reworkCycle,
    workAssignmentVersion: assignmentVersion,
    status: 'planned'
  }
}
