/**
 * The one answer to "which threads are still being worked on".
 *
 * Two surfaces ask that question and must not be able to disagree: the
 * close/quit gate warns about work it is about to interrupt, and the update
 * gate lists the work an install would take down with it. Both read this, so the
 * threads a user is shown before closing are the threads they are shown before
 * updating, computed once and in one place.
 */

import type { CloseConfirmationProject } from '../../lib/ipc-contract'
import { Logger } from '../system/logger'
import type { Database } from './database'
import { ProjectRepo } from './repositories/project-repo'
import { ThreadRepo } from './repositories/thread-repo'

/** Projects that still have threads being worked on, most active first. */
export function getActiveThreadProjects(database: Database): CloseConfirmationProject[] {
  try {
    const threadRepo = new ThreadRepo(database)
    const projectRepo = new ProjectRepo(database)
    const active = threadRepo.listActive()
    if (active.length === 0) return []
    const byProject = new Map<string, CloseConfirmationProject>()
    for (const thread of active) {
      let entry = byProject.get(thread.projectId)
      if (!entry) {
        const project = projectRepo.get(thread.projectId)
        entry = {
          projectId: thread.projectId,
          projectName: project?.name ?? thread.projectId,
          threadCount: 0,
          threads: []
        }
        byProject.set(thread.projectId, entry)
      }
      entry.threadCount++
      entry.threads.push({
        threadId: thread.id,
        title: thread.title,
        status: thread.status
      })
    }
    return [...byProject.values()].sort((a, b) => b.threadCount - a.threadCount)
  } catch (error) {
    Logger.error('Could not query active threads', error)
    return []
  }
}
