/**
 * What happens to the work running under a thread when the thread moves to
 * another app instance.
 *
 * A thread is not alone: it can have nested sub-agent workers (sessions inside
 * the departing harness process), pawn workers (their own threads), and both
 * wear the same sub-agent card. Neither kind can keep running in a process the
 * adopting instance does not own, so the hand-off always ends them. What the
 * adopting instance must not do is pretend they failed: the departing run was
 * stopped by a move, and the primary agent that returns on the new instance
 * needs to know exactly which workers it left behind, or it reads its own trace
 * back as a pile of failures and calls `cio_agent_status` for ids the fresh
 * harness process has never heard of.
 *
 * This module owns that roster and the continuation note built from it. It is
 * pure: the releasing side derives the roster from the thread's persisted
 * sub-agent cards, the adopting side turns it into one paragraph the resumed
 * agent receives with its continuation.
 */

import type { AgentMessage, AgentPart, Thread } from '../../../lib/types'

/** One worker a hand-off stopped, as the resuming agent must hear about it. */
export interface HandedOffWorker {
  /** Id the primary agent used for this worker in its own tool calls. */
  agentId: string
  /** Task label, i.e. what the worker was asked to do. */
  label: string
  /** `nested` is a session inside the departing harness, `pawn` is its own thread. */
  kind: 'nested' | 'pawn'
}

/**
 * What a releasing instance hands to the instance taking the thread over.
 *
 * `released` and `reason` are the verdict; the rest is what the adopter needs
 * and cannot infer once the departure has settled everything. A pawn thread is
 * a thread of its own, so it is named rather than described: the adopter resumes
 * exactly those threads instead of guessing which idle pawns should move.
 */
export interface ThreadTransferRelease {
  released: boolean
  reason?: string
  /** Workers the release had to stop, as the resuming agent must hear them. */
  workers?: HandedOffWorker[]
  /** Pawn threads whose runs were stopped so the adopter can resume them. */
  pawnThreadIds?: string[]
}

/**
 * How many stopped workers one continuation note names. A longer fan-out keeps
 * the note to a bounded paragraph: the tail is summarized by count, because the
 * resumed agent already knows the whole list from its own trace.
 */
export const HANDED_OFF_WORKER_LIMIT = 12

/** Longest label a note carries, so one huge task line cannot swamp it. */
const HANDED_OFF_LABEL_LIMIT = 120

type SubagentPart = Extract<AgentPart, { type: 'subagent' }>

function workerLabel(activity: SubagentPart['activity']): string {
  const label = activity.agent?.trim() || activity.description?.trim() || ''
  const collapsed = label.replace(/\s+/gu, ' ')
  if (collapsed.length === 0) return 'sub-agent'
  return collapsed.length > HANDED_OFF_LABEL_LIMIT
    ? `${collapsed.slice(0, HANDED_OFF_LABEL_LIMIT - 1)}…`
    : collapsed
}

/**
 * Whether a thread is a pawn worker spawned by `spawnerThreadId`.
 *
 * A pawn is the app's agent-owned worker thread: it carries the spawner in
 * `coordinatorThreadId` and no Assignment or Achievement role, which is what
 * tells it apart from an orchestration worker of those workflows. The user's
 * threads never carry a coordinator.
 */
export function isPawnWorkerThread(
  thread: Pick<
    Thread,
    'coordinatorThreadId' | 'assignmentRole' | 'achievementRole' | 'assignmentId'
  >,
  spawnerThreadId: string
): boolean {
  if (thread.coordinatorThreadId !== spawnerThreadId) return false
  if (thread.assignmentRole !== undefined || thread.achievementRole !== undefined) return false
  return thread.assignmentId === undefined
}

/**
 * The workers of a thread that are still running, newest card first.
 *
 * Only a `running` card is a worker the move interrupted. A worker that had
 * already reported (`completed`, `error`, `aborted`) finished, or was stopped
 * by the user, before the thread left: resuming must not re-open that.
 *
 * A pawn's card appears on the spawning thread too, and a pawn is identified by
 * `activity.pawn`, so the caller can tell "this one can restart on the new
 * instance" from "this one has to be re-spawned by the primary".
 */
export function runningWorkers(messages: readonly AgentMessage[]): HandedOffWorker[] {
  const seen = new Set<string>()
  const workers: HandedOffWorker[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'subagent') continue
      const activity = part.activity
      if (activity.status !== 'running') continue
      const agentId = part.callID ?? activity.childSessionId ?? part.id
      if (seen.has(agentId)) continue
      seen.add(agentId)
      workers.push({
        agentId,
        label: workerLabel(activity),
        kind: activity.pawn === true ? 'pawn' : 'nested'
      })
    }
  }
  return workers
}

/** The roster a note names, keeping the count of the workers it had to drop. */
export function boundedWorkerRoster(workers: readonly HandedOffWorker[]): {
  named: HandedOffWorker[]
  omitted: number
} {
  return {
    named: workers.slice(0, HANDED_OFF_WORKER_LIMIT),
    omitted: Math.max(0, workers.length - HANDED_OFF_WORKER_LIMIT)
  }
}

/**
 * The note a transferred thread's continuation carries.
 *
 * It has to say three things the agent cannot discover for itself: the thread
 * moved instances, what the move did to its workers, and that this is not a
 * failure of their work. Without the last two, the resumed agent reads its own
 * interrupted trace as a failure and reports it that way.
 *
 * Pawns are named separately because their threads really do move with the
 * primary, so a pawn is only named when it failed to come along.
 */
export function handedOffWorkersNote(
  workers: readonly HandedOffWorker[],
  options: { pawnsResumed: boolean }
): string {
  const live = options.pawnsResumed ? workers.filter((worker) => worker.kind === 'nested') : workers
  if (live.length === 0) return ''
  const { named, omitted } = boundedWorkerRoster(live)
  const lines = named.map((worker) => `- ${worker.label} (${worker.agentId})`)
  if (omitted > 0) lines.push(`- and ${omitted} more`)
  const noun = live.length === 1 ? 'worker' : 'workers'
  return [
    `This thread was moved to another app instance mid-turn. The move stopped ${live.length} ${noun} it was running, and that is not a failure of their work:`,
    ...lines,
    'Read what they already changed in the repository before you continue, then re-spawn the unfinished work with cio_spawn_agent (or cio_pawn_agent for a thread of its own). Do not report these workers as failed.'
  ].join('\n')
}

/** Fold the note into the continuation text the resumed agent receives. */
export function withHandedOffWorkersNote(nudge: string, note: string): string {
  if (!note) return nudge
  return `${nudge}\n\n${note}`
}
