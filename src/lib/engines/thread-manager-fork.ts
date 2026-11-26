import { writeFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { getConfigRoot } from '../utils'
import { messageId as createMessageId } from '../id'
import { featureSlugFromTitle } from '../project-artifacts'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import { ThreadCheckpointRepo } from '../../main/database/repositories/thread-checkpoint-repo'
import type { Database } from '../../main/database/database'
import { DEFAULT_HARNESS } from '../harness-default'
import { EngineeringLifecycleEngine } from './engineering-lifecycle-engine'
import { DON_ASSISTANT_ID } from '../types/assistant'
import { Logger } from '../../main/system/logger'
import {
  ASSISTANT_SPACE_ID,
  isOrchestrationChildThread,
  type AgentMessage,
  type AgentPart,
  type CreateThreadInput,
  type Thread,
  type ThreadStatus
} from '../types'

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
  /** Pin a fork that has to survive the automatic capacity sweep. */
  setPinned?(projectId: string, threadId: string, pinned: boolean): Promise<Thread>
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
 * Where a fork came from, as recorded next to the fork's own artifacts.
 *
 * The authoritative record of a fork's lineage is the `thread_checkpoints` row
 * of kind `fork`; this file is a cache of the same fact for the paths that read
 * it off the fork's branch directory. The fork writes it once and never touches
 * it again, so a reader can cache it for the life of the process: a thread id is
 * never reused, and a missing file stays missing.
 */
export interface ForkOrigin {
  /** The thread this one was forked from. */
  parentThreadId: string
  /** Epoch ms the fork was made. Everything either thread did before it is older. */
  forkedAt: number
}

const forkOriginCache = new Map<string, ForkOrigin | null>()

/**
 * The origin recorded for a forked thread, or null for a thread that was not
 * forked. Used by the send path to point the agent at the thread its context
 * came from (see `firstTurnForkNotice`).
 */
export async function readForkOrigin(
  projectId: string,
  threadId: string
): Promise<ForkOrigin | null> {
  const key = `${projectId}/${threadId}`
  const cached = forkOriginCache.get(key)
  if (cached !== undefined) return cached
  let origin: ForkOrigin | null = null
  try {
    const raw = await readFile(
      join(getConfigRoot(), 'projects', projectId, 'threads', threadId, 'branches', 'origin.json'),
      'utf8'
    )
    const parsed: unknown = JSON.parse(raw)
    const record = parsed as { parentThreadId?: unknown; forkedAt?: unknown }
    if (typeof record.parentThreadId === 'string' && record.parentThreadId.length > 0) {
      origin = {
        parentThreadId: record.parentThreadId,
        forkedAt: typeof record.forkedAt === 'number' ? record.forkedAt : 0
      }
    }
  } catch {
    // No origin file: an ordinary thread, or a fork whose metadata could not be
    // read. Either way it is not a fork the send path can point at.
    origin = null
  }
  forkOriginCache.set(key, origin)
  return origin
}

/**
 * The one-line label a fork's lineage row carries: the thread it came from, named
 * so a reader of the checkpoint list never has to resolve an id to know it.
 */
function forkLineageLabel(parentTitle: string): string {
  const name = parentTitle.trim() || 'Untitled thread'
  const label = `Forked from ${name}`
  return label.length > 120 ? `${label.slice(0, 119)}…` : label
}

/**
 * Forking a conversation into a new thread: resolve the fork boundary from the
 * parent transcript, create the destination thread, and record the lineage.
 *
 * A fork carries no copy of the parent's messages. The parent thread stays the
 * one place that history lives, and the fork's `thread_checkpoints` row of kind
 * `fork` names it (with the message the fork was cut at), so the agent reads the
 * parent through the read tools and the composer can draw the fork banner.
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
    // Resolve the fork point before creating a destination: an unknown or stale
    // boundary has to fail while no fork exists yet. Only the boundary's id and
    // timestamp are read; the parent's transcript itself is never touched.
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
    // The cutoff is the last parent message the fork was cut at. Both values are
    // nullable in storage, so an unreadable boundary yields none rather than a
    // row whose marker is a lie.
    const boundaryMessageId = typeof cutoff?.['id'] === 'string' ? cutoff['id'] : undefined
    const boundaryCreatedAt =
      typeof cutoff?.['created_at'] === 'number' ? cutoff['created_at'] : undefined
    const destinationPath = this.projectRepo.get(destinationProjectId)?.path ?? ''
    const forkScopeBucketId = destinationProjectId === projectId ? parent.scopeBucketId : undefined
    /**
     * A fork made inside Assistant View stays inside its assistant.
     *
     * An assistant task, and every run of one, carries the `assistantId` that
     * groups it under that assistant in the tab. A fork is a new conversation
     * over the same history, so it has to stay in that group: without the id the
     * new row is an assistant-less task, which reads as a thread sitting outside
     * the assistant it was forked from. Ownership is all that travels   the fork
     * is never the knowledge thread and never a run   and the task's own
     * schedule override travels with it so the copy is still the same task.
     */
    const assistantFork =
      destinationProjectId === projectId &&
      projectId === ASSISTANT_SPACE_ID &&
      parent.assistantId !== undefined
        ? {
            assistantId: parent.assistantId,
            assistantIconType: parent.assistantIconType,
            assistantIcon: parent.assistantIcon,
            scheduleOverride: parent.scheduleOverride ?? null,
            scheduled: parent.scheduled
          }
        : {}
    /**
     * A group conversation forks as a group conversation.
     *
     * The participants are who can speak in it, so a copy that lost them would
     * render as a single assistant's thread with every speaker gone. The group
     * title travels with the fork's own name, because the copy is a new
     * conversation and never a rename of the one it came from.
     */
    const groupFork =
      destinationProjectId === projectId && (parent.groupParticipants?.length ?? 0) > 0
        ? {
            groupParticipants: [...(parent.groupParticipants ?? [])],
            groupTitle: title
          }
        : {}
    // A fork of an Engineering thread is an Engineering thread. An Engineering
    // thread stays one for its lifetime, even with every switch off (a parked,
    // completed or cancelled run), so the marker must travel from the durable
    // row or the lifecycle's permanent started marker. Independent-audit and
    // orchestration-child threads are never Engineering and seed nothing.
    const sourceLifecycle =
      parent.independentAudit === true || isOrchestrationChildThread(parent)
        ? null
        : this.lifecycle.get(projectId, threadId)
    const sourceIsEngineering =
      parent.engineering === true ||
      sourceLifecycle?.startedAt !== undefined ||
      (sourceLifecycle?.selection ?? 'none') !== 'none'
    const forked = await this.host.createThread({
      projectId: destinationProjectId,
      providerId: parent.providerId,
      title,
      titleSource: 'manual',
      settings: parent.settings,
      engineering: sourceIsEngineering,
      // Forks into another project (e.g. a chat continued in a project) never
      // inherit the parent's feature work-directory or scope bucket.
      featureSlug:
        destinationProjectId === projectId
          ? (parent.featureSlug ?? featureSlugFromTitle(parent.title))
          : undefined,
      scopeBucketId: forkScopeBucketId,
      workingDirectory:
        destinationProjectId === projectId ? parent.workingDirectory : destinationPath,
      ...assistantFork,
      ...groupFork
    })
    // The fork's lineage is written here, before anything else touches the new
    // thread: a fork that existed without it would read as a conversation whose
    // history came from nowhere. This row is the authoritative record   every
    // reader (the composer's fork banner, the session brief, the diagnostics
    // reader) resolves the parent from it, so the fork needs no copy of the
    // parent's messages at all.
    //
    // The boundary is the message the fork was cut at when the caller named one,
    // which is what lets a reader tell how much of the parent's history the fork
    // was made over without re-deriving it.
    const forkedAt = Date.now()
    new ThreadCheckpointRepo(this.db).create({
      threadId: forked.id,
      kind: 'fork',
      // The fork's settings travel with it from the parent, and the harness those
      // settings name is the one that owns the parent's provider, so reading the
      // parent's harness when the fork's own row carries none keeps the lineage
      // row from disagreeing with the conversation it describes.
      harnessId: forked.settings?.harnessId ?? parent.settings?.harnessId ?? DEFAULT_HARNESS,
      // `session_id` is NOT NULL, and this row describes a thread that has not run
      // yet. With no session of its own, the session it names is the parent's:
      // that is the session whose history this fork continues. A fork cut from a
      // parent that never started one has no session to name at all, so it
      // carries its own thread id   unique by construction, and never something
      // a harness could later hand out as a session id.
      sessionId: forked.sessionId ?? parent.sessionId ?? forked.id,
      projectPath: destinationPath,
      parentThreadId: threadId,
      label: forkLineageLabel(parent.title),
      createdAt: forkedAt,
      ...(boundaryMessageId ? { boundaryMessageId } : {}),
      ...(boundaryCreatedAt !== undefined ? { boundaryCreatedAt } : {})
    })
    // The orchestrator's conversations are pinned so the automatic capacity
    // sweep can never take the front door, and a fork of one is another of the
    // same kind: it has to survive the next sweep exactly like its parent.
    if (parent.assistantId === DON_ASSISTANT_ID && forked.projectId === ASSISTANT_SPACE_ID) {
      await this.host
        .setPinned?.(forked.projectId, forked.id, true)
        .catch((error: unknown) => Logger.dev('Forked Don conversation pin failed:', error))
    }
    // Same-scope forks re-resolve their compatibility directory from the
    // destination scope inside `createThread`, so a stale parent directory
    // can never override the authoritative root.
    // A fork of an Engineering thread must open with the same switches lit:
    // carry the parent's stage selection, and   for a parked
    // source with every switch off   its permanent started marker, so the
    // fork's Toolbox mirrors the parent's instead of arriving neutral.
    if (
      sourceLifecycle &&
      (sourceLifecycle.selection !== 'none' || sourceLifecycle.startedAt !== undefined)
    ) {
      try {
        this.lifecycle.inherit(destinationProjectId, forked.id, {
          stages: sourceLifecycle.selectedStages ?? [],
          startedAt: sourceLifecycle.startedAt
        })
      } catch {
        // Lifecycle inheritance is cosmetic   never fail the fork on it.
      }
    }
    // A fork holds the parent's history by reference, so it is a completed
    // thread, not an empty "New Thread" draft. Keep it out of the todo slice and
    // out of the renderer's empty-new-thread reuse logic; it becomes active again
    // only when the user actually writes on it.
    const completed = await this.host.setStatus(destinationProjectId, forked.id, 'completed', {
      read: true
    })

    // Link fork to parent via branch metadata. This is now a cache of the
    // lineage the checkpoint row already holds: the renderer reads it through
    // `readForkOrigin` without a database round trip, and a missing or stale file
    // costs the banner, never the fact.
    const branchMeta = {
      parentThreadId: threadId,
      checkpointId: checkpointId ?? null,
      messageId: messageId ?? null,
      forkedAt
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
