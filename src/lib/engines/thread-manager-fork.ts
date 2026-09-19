import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { getConfigRoot } from '../utils'
import { messageId as createMessageId } from '../id'
import { featureSlugFromTitle } from '../project-artifacts'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import type { Database } from '../../main/database/database'
import { EngineeringLifecycleEngine } from './engineering-lifecycle-engine'
import type { AgentMessage, AgentPart, CreateThreadInput, Thread, ThreadStatus } from '../types'

/**
 * Re-key copied messages and their parts so they can live in a new thread
 * without colliding with the originals. Used when forking a thread or when
 * promoting a temporary (quick) chat into a regular thread.
 */
export function remapCopiedMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    const newId = createMessageId()
    const remapPart = (part: AgentPart): AgentPart => {
      if (!('messageID' in part)) return part
      const previous = part.id.includes(msg.id)
        ? part.id.replace(msg.id, newId)
        : `${newId}-${part.id}`
      return { ...part, id: previous, messageID: newId }
    }
    return {
      ...msg,
      id: newId,
      parts: msg.parts.map(remapPart),
      transportParts: msg.transportParts?.map(remapPart)
    }
  })
}

/**
 * The narrow slice of `ThreadManager` the fork path needs: thread creation and
 * a status transition. Kept as an interface so the fork module never imports
 * the manager class.
 */
export interface ThreadForkHost {
  createThread(input: CreateThreadInput): Promise<Thread>
  setStatus(
    projectId: string,
    threadId: string,
    status: ThreadStatus,
    opts?: { read?: boolean; error?: string; errorDetail?: string }
  ): Promise<Thread>
}

export interface ForkThreadInput {
  projectId: string
  parent: Thread
  title: string
  checkpointId?: string
  messageId?: string
  targetProjectId?: string
}

/**
 * Forking a conversation into a new thread: resolve the fork boundary from the
 * parent transcript, create the destination thread, copy the bounded history,
 * and link the fork to its parent through branch metadata.
 */
export class ThreadForkService {
  constructor(
    private readonly db: Database,
    private readonly projectRepo: ProjectRepo,
    private readonly lifecycle: EngineeringLifecycleEngine,
    private readonly host: ThreadForkHost
  ) {}

  /**
   * Fork a thread into a new conversation. When `targetProjectId` is provided
   * the fork is created in that project instead of the source project   used to
   * continue a standalone chat inside a real project.
   */
  async fork(input: ForkThreadInput): Promise<Thread> {
    const { projectId, parent, title, checkpointId, messageId, targetProjectId } = input
    const threadId = parent.id
    const destinationProjectId = targetProjectId ?? projectId
    if (destinationProjectId !== projectId) {
      const destination = this.projectRepo.get(destinationProjectId)
      if (!destination) throw new Error(`Project not found: ${destinationProjectId}`)
    }
    // Resolve the upper bound before creating a destination. Only metadata crosses
    // the worker boundary; transcript JSON stays in SQLite throughout the copy.
    const upper = await this.db.queryViaWorker(
      `SELECT id, created_at FROM agent_messages WHERE thread_id = ?
       AND session_id IS NULL ${messageId ? 'AND id = ?' : ''}
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      messageId ? [threadId, messageId] : [threadId],
      1
    )
    if (!upper.ok) throw new Error(upper.error ?? 'Cannot read fork boundary')
    let cutoff = upper.rows[0]
    if (messageId && !cutoff) {
      // `agent_messages` is written when a turn settles, so a running turn's
      // messages are addressable from the renderer (they stream into its live
      // cache) before the durable transcript holds them. A fork copies stored
      // history, so the boundary of such a message is the newest stored
      // message: the whole of that history. An id that is stored anywhere but
      // is not a canonical row of this thread (another thread, or a
      // session-scoped trace row) is a stale boundary and must still fail, so
      // a bad id can never silently fork the wrong history.
      const storedElsewhere = await this.db.queryViaWorker(
        'SELECT thread_id FROM agent_messages WHERE id = ? LIMIT 1',
        [messageId],
        1
      )
      if (!storedElsewhere.ok) throw new Error(storedElsewhere.error ?? 'Cannot read fork boundary')
      if (storedElsewhere.rows.length > 0) {
        throw new Error(`Cannot fork from message ${messageId}: message not found in thread`)
      }
      const newest = await this.db.queryViaWorker(
        `SELECT id, created_at FROM agent_messages WHERE thread_id = ? AND session_id IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [threadId],
        1
      )
      if (!newest.ok) throw new Error(newest.error ?? 'Cannot read fork boundary')
      cutoff = newest.rows[0]
      if (!cutoff) {
        throw new Error(`Cannot fork from message ${messageId}: this turn has not been saved yet`)
      }
    }
    const boundary = cutoff
      ? await this.db.queryViaWorker(
          `SELECT CASE WHEN json_extract(p.value, '$.firstKeptCreatedAt') IS NOT NULL THEN '' ELSE m.id END AS id,
         min(m.created_at, coalesce((SELECT max(k.created_at) FROM agent_messages k
           WHERE k.thread_id = m.thread_id AND k.session_id IS NULL
             AND k.created_at <= json_extract(p.value, '$.firstKeptCreatedAt')),
           json_extract(p.value, '$.firstKeptCreatedAt'), m.created_at)) AS created_at
       FROM agent_messages m, json_each(m.parts) p
       WHERE m.thread_id = ? AND m.session_id IS NULL
       AND (m.created_at, m.id) <= (?, ?)
       AND (
         (json_extract(p.value, '$.type') = 'compaction-summary'
           AND length(trim(json_extract(p.value, '$.text'))) > 0)
         OR (json_extract(p.value, '$.type') = 'compaction'
           AND length(trim(json_extract(p.value, '$.summary'))) > 0
           AND (json_extract(p.value, '$.firstKeptEntryId') IS NULL
             OR json_extract(p.value, '$.firstKeptCreatedAt') IS NOT NULL)))
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
          [threadId, cutoff.created_at, cutoff.id],
          1
        )
      : undefined
    if (boundary && !boundary.ok)
      throw new Error(boundary.error ?? 'Cannot read compaction boundary')
    const lower = boundary?.rows[0]

    const destinationPath = this.projectRepo.get(destinationProjectId)?.path ?? ''
    const forkScopeBucketId = destinationProjectId === projectId ? parent.scopeBucketId : undefined
    const forked = await this.host.createThread({
      projectId: destinationProjectId,
      providerId: parent.providerId,
      title,
      titleSource: 'manual',
      settings: parent.settings,
      // Forks into another project (e.g. a chat continued in a project) never
      // inherit the parent's feature work-directory or scope bucket.
      featureSlug:
        destinationProjectId === projectId
          ? (parent.featureSlug ?? featureSlugFromTitle(parent.title))
          : undefined,
      scopeBucketId: forkScopeBucketId,
      workingDirectory:
        destinationProjectId === projectId ? parent.workingDirectory : destinationPath
    })
    // Same-scope forks re-resolve their compatibility directory from the
    // destination scope inside `createThread`, so a stale parent directory
    // can never override the authoritative root.
    // A fork of an Engineering thread must open with the same switches lit:
    // carry the parent's stage selection (and Auto Pilot) into the fork so
    // the toolbox reflects exactly what the user had turned on.
    {
      const sourceLifecycle = this.lifecycle.get(projectId, threadId)
      if (sourceLifecycle && sourceLifecycle.selection !== 'none') {
        try {
          this.lifecycle.select(destinationProjectId, forked.id, {
            stages: sourceLifecycle.selectedStages ?? [],
            autopilot: sourceLifecycle.autopilot === true
          })
        } catch {
          // Lifecycle inheritance is cosmetic   never fail the fork on it.
        }
      }
    }
    if (cutoff) {
      let after: Record<string, unknown> | undefined
      for (;;) {
        const page = await this.db.queryViaWorker(
          `SELECT id, created_at FROM agent_messages WHERE thread_id = ?
           AND session_id IS NULL AND visibility IN ('conversation', 'working_trace')
           AND (created_at, id) <= (?, ?)
           ${lower ? 'AND (created_at, id) >= (?, ?)' : ''}
           ${after ? 'AND (created_at, id) > (?, ?)' : ''}
           ORDER BY created_at, id LIMIT 16`,
          [
            threadId,
            cutoff.created_at,
            cutoff.id,
            ...(lower ? [lower.created_at, lower.id] : []),
            ...(after ? [after.created_at, after.id] : [])
          ],
          16
        )
        if (!page.ok) throw new Error(page.error ?? 'Cannot read fork page')
        if (page.rows.length === 0) break
        const statements = page.rows.map((row) => {
          const id = createMessageId()
          return {
            sql: `INSERT INTO agent_messages (
              id, thread_id, role, origin, visibility, parts, search_text,
              model_id, provider_id, harness_id, thinking_level,
              references_json, project_references_json, created_at, completed_at,
              generation_ms
            ) SELECT ?, ?, role, origin, visibility,
              (SELECT json_group_array(json(CASE WHEN json_type(value, '$.messageID') IS NULL
                THEN value ELSE json_set(value, '$.messageID', ?, '$.id', ? || ':' || json_extract(value, '$.id')) END))
                FROM json_each(parts)), search_text,
              model_id, provider_id, harness_id, thinking_level,
              references_json, project_references_json, created_at, completed_at,
              generation_ms
              FROM agent_messages WHERE thread_id = ? AND id = ?`,
            params: [id, forked.id, id, id, threadId, row.id]
          }
        })
        const outcome = await this.db.transactionViaWorker(statements)
        if (!outcome.ok) throw new Error(outcome.error ?? 'Cannot copy fork page')
        after = page.rows[page.rows.length - 1]
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }

    // A fork carries the parent's history, so it is a completed thread, not an
    // empty "New Thread" draft. Keep it out of the todo slice and out of the
    // renderer's empty-new-thread reuse logic; it becomes active again only
    // when the user actually writes on it.
    const completed = await this.host.setStatus(destinationProjectId, forked.id, 'completed', {
      read: true
    })

    // Link fork to parent via branch metadata
    const branchMeta = {
      parentThreadId: threadId,
      checkpointId: checkpointId ?? null,
      messageId: messageId ?? null,
      forkedAt: Date.now()
    }

    const branchDir = join(
      getConfigRoot(),
      'projects',
      destinationProjectId,
      'threads',
      forked.id,
      'branches'
    )
    await mkdir(branchDir, { recursive: true })
    await writeFile(join(branchDir, 'origin.json'), JSON.stringify(branchMeta, null, 2))

    return completed
  }
}
