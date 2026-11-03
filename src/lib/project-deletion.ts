/**
 * The one record of a project deletion in flight.
 *
 * Deleting a project erases its folder, its browser profiles, every thread it
 * owns, and several project-scoped tables. That is far too much work to hold an
 * IPC reply open for, so the main process queues the job, answers at once, and
 * reports every stage on the `project:deletion` event. A renderer greys the
 * project the moment the request leaves, follows the phase while it runs, and
 * drops the row only when the deletion really finished. A failure puts the row
 * back because nothing on the main thread ever waited for a frozen window.
 */
export type ProjectDeletionPhase =
  /** Erasing the project's own folder from the user's device. */
  | 'folder'
  /** Releasing and erasing the browser profiles the project owned. */
  | 'browsers'
  /** Tearing down every thread the project owns, in bounded batches. */
  | 'threads'
  /** Removing the project row itself. */
  | 'project'
  /** Purging project-scoped rows, files, and scratch data. */
  | 'cleanup'

export type ProjectDeletionStatus = 'started' | 'progress' | 'deleted' | 'failed'

export interface ProjectDeletionEvent {
  projectId: string
  status: ProjectDeletionStatus
  /** Stage the deletion is in. Present on `started` and `progress`. */
  phase?: ProjectDeletionPhase
  /** Threads swept so far, out of `total`. Present during `threads`. */
  done?: number
  total?: number
  /** Human-readable cause. Present on `failed`. */
  error?: string
}

/** Name of one deletion phase, for the row that reports it while it runs. */
export const PROJECT_DELETION_PHASE_LABEL: Record<ProjectDeletionPhase, string> = {
  folder: 'Erasing folder',
  browsers: 'Releasing browsers',
  threads: 'Removing threads',
  project: 'Removing project',
  cleanup: 'Cleaning up'
}

/** What a greyed project row says while its deletion runs. */
export function projectDeletionLabel(event: {
  phase?: ProjectDeletionPhase
  done?: number
  total?: number
}): string {
  const label = event.phase ? PROJECT_DELETION_PHASE_LABEL[event.phase] : 'Removing'
  if (event.phase === 'threads' && event.total && event.done !== undefined) {
    return `${label} ${event.done}/${event.total}`
  }
  return label
}
