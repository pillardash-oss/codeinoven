import { unarchivedThreadSql } from '../../../lib/archives'
import { validateEntityId } from '../../ipc/ipc-validation'
import { Logger } from '../../system/logger'
import type { ThreadOpenDigest, ThreadOpenDigestPart } from '../../../lib/ipc/invoke-thread'
import type {
  AgentSessionStatus,
  ImageDescriptorErrorRequest,
  PendingAgentQuestionRequest,
  PermissionRequest,
  Thread
} from '../../../lib/types'
import type { ChatEngine } from '../chat-engine'

/**
 * ChatEngine open-digest: the one aggregate read a thread mount needs.
 *
 * Opening a conversation used to cost five renderer→main round trips that all
 * re-read the same thread row through the single database worker: `thread:get`
 * (a visibility probe plus the row), `agent:listPermissions` and
 * `agent:listQuestions` (the row again, only to decide Oven routing   the
 * question path read it twice), and `agent:getSessionStatus` (readiness plus the
 * row). Every one of those was a job on the shared connection for an answer the
 * mount already had.
 *
 * This reads the row once and hands it to each of those helpers, so the answer
 * is assembled from a single row read and keeps every part's own shape. The
 * individual channels are untouched: they still read the row themselves, which
 * is exactly what a caller that does not already hold it needs.
 */
export class ChatEngineOpenDigest {
  constructor(private readonly host: ChatEngine) {}

  async readOpenDigest(projectId: string, threadId: string): Promise<ThreadOpenDigest> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    // A renderer opens an optimistically created thread on the click, before its
    // row exists. Every separate channel on this path waits for persistence
    // here, so the digest waits once instead of five separate waits   and answers
    // a create that never persisted with the same sentence `thread:get` uses,
    // instead of a null row the mount would read as an empty thread.
    const creation = this.host.threadCreation
    await creation?.awaitReady(threadId)
    if (creation?.didFinalizationFail(threadId)) {
      throw new Error(`Thread not found: ${threadId} (its creation did not complete)`)
    }
    const failures: ThreadOpenDigestPart[] = []
    const thread = await this.readThread(projectId, threadId, failures)
    if (!thread && failures.length > 0) {
      // The row read itself failed: no part below can be trusted to speak for a
      // thread whose row could not be read, so name them all and let the caller
      // ask each channel the way it did before.
      failures.push('permissions', 'questions', 'imageDescriptorErrors', 'sessionStatus')
      return {
        thread: null,
        permissions: [],
        questions: [],
        imageDescriptorErrors: [],
        sessionStatus: null,
        failures
      }
    }
    // The parts are independent reads of in-memory state (plus, for questions,
    // the thread's own provider probe), so they answer together instead of
    // stacking their latencies the way the separate round trips did.
    const [permissions, questions, imageDescriptorErrors, sessionStatus] = await Promise.all([
      this.readPart<PermissionRequest[]>('permissions', failures, [], () =>
        this.host.units['permissions'].listPermissions(projectId, threadId, thread)
      ),
      this.readPart<PendingAgentQuestionRequest[]>('questions', failures, [], () =>
        this.host.units['questions-ask'].listQuestions(projectId, threadId, thread)
      ),
      this.readPart<ImageDescriptorErrorRequest[]>('imageDescriptorErrors', failures, [], () =>
        this.host.units['media-artifacts'].listImageDescriptorErrors(projectId, threadId)
      ),
      this.readPart<AgentSessionStatus | null>('sessionStatus', failures, null, () =>
        this.host.units['turns-sessions'].getSessionStatus(projectId, threadId, thread)
      )
    ])
    return { thread, permissions, questions, imageDescriptorErrors, sessionStatus, failures }
  }

  /**
   * The one full row read this digest performs.
   *
   * The visibility probe is the same one `thread:get` answers with: an archived
   * thread (or one whose project, assistant, or parent is archived) is not
   * visible to this window, and the mount must see the same null row it saw
   * before.
   */
  private async readThread(
    projectId: string,
    threadId: string,
    failures: ThreadOpenDigestPart[]
  ): Promise<Thread | null> {
    try {
      const visible = await this.host.database.queryViaWorker(
        `SELECT id FROM threads WHERE id = ? AND project_id = ? AND ${unarchivedThreadSql()}`,
        [threadId, projectId],
        1
      )
      if (!visible.ok || visible.rows.length === 0) return null
      return await this.host.threadManager.getThread(projectId, threadId)
    } catch (error) {
      failures.push('thread')
      Logger.error('Thread open digest could not read the thread row', {
        projectId,
        threadId,
        error: String(error)
      })
      return null
    }
  }

  /**
   * One part of the digest, with its own failure kept out of the others.
   *
   * A single failing read must never cost the mount the four answers that did
   * succeed, and it must never be mistaken for an empty answer: the part is
   * named in `failures` so the caller re-reads that one channel.
   */
  private async readPart<T>(
    part: ThreadOpenDigestPart,
    failures: ThreadOpenDigestPart[],
    fallback: T,
    read: () => Promise<T>
  ): Promise<T> {
    try {
      return await read()
    } catch (error) {
      failures.push(part)
      Logger.error('Thread open digest could not answer a part', {
        part,
        error: String(error)
      })
      return fallback
    }
  }
}
