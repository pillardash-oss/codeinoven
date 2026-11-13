import { rm } from 'fs/promises'
import type { Thread } from '../types'
import { isAssistantSetupThread, isOrchestrationChildThread, type Project } from '../types'
import { threadOwnedDirectories } from '../thread-storage-paths'
import { Logger } from '../../main/system/logger'
import type { Database } from '../../main/database/database'
import type { ProjectRepo } from '../../main/database/repositories/project-repo'
import type { ThreadRepo } from '../../main/database/repositories/thread-repo'
import { buildThreadDeletionStatements, placeholdersFor } from './thread-manager-deletion'
import { assistantRunDescendants, orchestrationDescendants } from './thread-manager-lineage'
import type { ThreadTranscriptStore } from './thread-manager-transcripts'

/**
 * The project row a thread sweep resolves its scratch directories against.
 * Narrow on purpose: only the source and path decide where a thread's files live.
 */
export type ThreadDeletionProject = Pick<Project, 'source' | 'path'> | null

/** What a project-wide thread sweep removed, and what it could not. */
export interface ThreadSweepSummary {
  swept: number
  unresolved: number
}

/**
 * Owns thread deletion as a sweep: the exact rows a deletion takes with it (a
 * task's runs and a coordinator's descendants), the one set-based transaction
 * that removes them, the disk artifacts they leave behind, and the project-wide
 * pass that drains a whole project without starving the app.
 *
 * Deletion is the app's most destructive path, so it is deliberately one place:
 * a single thread, a scope, a capacity eviction and a project teardown all reach
 * the same teardown order and the same cleanup, and none of them can drift.
 */
export class ThreadSweepService {
  /**
   * @param onDelete Invoked before a thread's rows are removed so the caller can
   * tear down live harness resources (sessions, servers, ports) first.
   * @param onDeleted Invoked after the rows are gone, so every window can drop
   * them.
   */
  constructor(
    private readonly db: Database,
    private readonly threadRepo: ThreadRepo,
    private readonly projectRepo: ProjectRepo,
    private readonly transcripts: ThreadTranscriptStore,
    private readonly onDelete: (thread: Thread) => void | Promise<void>,
    private readonly onDeleted: (
      threads: Pick<Thread, 'projectId' | 'id'>[]
    ) => void | Promise<void>
  ) {}

  async deleteThread(
    projectId: string,
    threadId: string,
    options: { allowAssistantSetupThread?: boolean } = {}
  ): Promise<void> {
    const projectThreads = await this.threadRepo.listForDeletionViaWorker(projectId)
    const thread = projectThreads.find((candidate) => candidate.id === threadId)
    // An assistant's Getting started thread is never deleted on its own: it is the
    // record of the conversation that wrote the instructions the assistant runs on.
    // It leaves with its assistant, through the sweep that removes both, which is
    // the only caller that passes the allowance below.
    if (thread && isAssistantSetupThread(thread) && !options.allowAssistantSetupThread) {
      throw new Error('The Getting started thread cannot be deleted. Remove the assistant itself.')
    }
    if (!thread) {
      // Deleting a thread that is already gone is a finished deletion, not a
      // failure: the row and everything the cascade takes with it are exactly
      // what the caller asked to remove, and reporting "not found" would show a
      // cleanup warning for a delete that already succeeded. The broadcast still
      // runs so every window drops a row it may have kept from a missed event;
      // a thread owned by another project is still a caller bug and keeps
      // failing with the ownership error above.
      if (await this.threadRepo.getViaWorker(threadId)) {
        throw new Error(`Thread not found in project ${projectId}: ${threadId}`)
      }
      await this.onDeleted([{ projectId, id: threadId }])
      return
    }
    // A task owns the runs it produced, exactly as a coordinator owns its
    // workers: both are swept with the thread so no orphan row survives.
    const deletionOrder = [
      ...assistantRunDescendants(projectThreads, threadId),
      ...orchestrationDescendants(projectThreads, threadId),
      thread
    ]
    await this.deleteThreadOrder(projectId, deletionOrder)
  }

  /**
   * The body of a thread deletion, given the exact rows it sweeps.
   *
   * Split out so a project-wide sweep can reuse one project thread snapshot for
   * every thread it removes. The alternative   reading the whole project's
   * threads again per thread   is quadratic in a project with hundreds of
   * threads, and that is exactly the deletion that used to freeze the app.
   */
  private async deleteThreadOrder(
    projectId: string,
    deletionOrder: Thread[],
    project?: ThreadDeletionProject | null
  ): Promise<void> {
    if (deletionOrder.length === 0) return
    const assignmentIds = await this.assignmentIdsFor(deletionOrder)
    for (const candidate of deletionOrder) {
      await this.onDelete(candidate)
    }
    const outcome = await this.db.transactionViaWorker(
      buildThreadDeletionStatements(deletionOrder, assignmentIds)
    )
    if (!outcome.ok) {
      throw new Error(outcome.error ?? 'thread deletion failed')
    }
    for (const candidate of deletionOrder) {
      this.transcripts.forgetUserMessages(projectId, candidate.id)
    }
    await this.removeThreadDiskArtifacts(deletionOrder, project)
    await this.onDeleted(deletionOrder)
  }

  /**
   * Delete every thread in a project through the same path as `deleteThread`
   * (session teardown, DB row cleanup, disk artifacts), so project deletion
   * never has to duplicate or fall behind that logic.
   *
   * Only walks coordinator/standalone threads   orchestration children are
   * swept as part of their coordinator's deletion. One snapshot serves the
   * whole sweep, each thread is removed as its own small step, and the loop
   * yields to the event loop between threads so a large project cannot starve
   * painting, IPC, or an agent stream while it drains. A thread whose teardown
   * throws is logged and skipped instead of aborting the rest of the project,
   * and a second pass picks up any row the first pass could not remove.
   */
  async deleteAllThreadsInProject(
    projectId: string,
    onProgress?: (done: number, total: number) => void
  ): Promise<ThreadSweepSummary> {
    const projectThreads = await this.threadRepo.listForDeletionViaWorker(projectId)
    const project = await this.projectRepo.getViaWorker(projectId)
    const roots = projectThreads.filter((thread) => !isOrchestrationChildThread(thread))
    const sweptIds = new Set<string>()
    let swept = 0
    let done = 0
    for (const root of roots) {
      if (sweptIds.has(root.id)) continue
      const order = [
        ...assistantRunDescendants(projectThreads, root.id),
        ...orchestrationDescendants(projectThreads, root.id),
        root
      ].filter((candidate) => !sweptIds.has(candidate.id))
      for (const candidate of order) sweptIds.add(candidate.id)
      try {
        await this.deleteThreadOrder(projectId, order, project)
        swept += order.length
      } catch (error) {
        Logger.dev('A thread survived a project deletion sweep', {
          projectId,
          threadId: root.id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      done += 1
      onProgress?.(done, roots.length)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    // A retry pass removes whatever the first pass left behind: a row whose
    // teardown threw, or a descendant that arrived while the sweep ran.
    const leftovers = await this.threadRepo.listForDeletionViaWorker(projectId)
    for (const thread of leftovers) {
      try {
        await this.deleteThreadOrder(projectId, [thread], project)
        swept += 1
      } catch (error) {
        Logger.dev('A leftover thread survived a project deletion sweep', {
          projectId,
          threadId: thread.id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    const unresolved = (await this.threadRepo.listForDeletionViaWorker(projectId)).length
    return { swept, unresolved }
  }

  private async removeThreadDiskArtifacts(
    threads: Thread[],
    project?: ThreadDeletionProject | null
  ): Promise<void> {
    for (const thread of threads) {
      const owner =
        project === undefined ? await this.projectRepo.getViaWorker(thread.projectId) : project
      const dirs = threadOwnedDirectories(owner, thread.projectId, thread.id, thread.assistantId)
      for (const dir of dirs) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  private async assignmentIdsFor(threads: Thread[]): Promise<Set<string>> {
    const assignmentIds = new Set(
      threads.flatMap((thread) => (thread.assignmentId ? [thread.assignmentId] : []))
    )
    if (threads.length === 0) return assignmentIds
    const threadIds = threads.map((thread) => thread.id)
    const placeholders = placeholdersFor(threadIds.length)
    const projectId = threads[0].projectId
    const result = await this.db.queryViaWorker(
      `SELECT assignment_id FROM assignment_workflow
       WHERE project_id = ? AND coordinator_thread_id IN (${placeholders})
       UNION
       SELECT assignment_id FROM assignment_versions
       WHERE project_id = ? AND coordinator_thread_id IN (${placeholders})`,
      [projectId, ...threadIds, projectId, ...threadIds],
      1_000
    )
    for (const row of result.rows) {
      const assignmentId = row['assignment_id']
      if (typeof assignmentId === 'string') assignmentIds.add(assignmentId)
    }
    return assignmentIds
  }
}
