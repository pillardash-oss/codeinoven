/**
 * What happens to the work running under a thread when the thread moves to
 * another app instance.
 *
 * A thread is not alone: it can have nested sub-agent workers (sessions inside
 * the departing harness process), pawn workers (their own threads), and both
 * wear the same sub-agent card. A hand-off ends the process that hosted those
 * sessions, so neither kind keeps running in it, but the work is not lost: a
 * nested worker that names its session file is resumed on the adopting
 * instance, and a pawn is resumed when its thread comes along. Only a nested
 * worker with no session file, and a pawn that was not resumed, are stopped for
 * good.
 *
 * This module owns the roster of the workers that were in flight and the
 * continuation note built from it. It is pure: the releasing side derives the
 * roster from the thread's persisted sub-agent cards, the adopting side turns it
 * into one paragraph the resumed agent receives with its continuation. The
 * roster carries what a resume needs because a settled card cannot say whether
 * a worker finished or was handed off, and a fresh harness process answers
 * `cio_agent_status` for none of the ids the agent remembers.
 */

import type { AgentMessage, AgentPart } from '../../../lib/types'
import type { HandedOffQuestion } from './thread-transfer-attention'

/** One worker a thread was running when it was handed off, with what a resume needs. */
export interface HandedOffWorker {
  /** Id the primary agent used for this worker in its own tool calls. */
  agentId: string
  /** Task label, i.e. what the worker was asked to do. */
  label: string
  /** `nested` is a session inside the departing harness, `pawn` is its own thread. */
  kind: 'nested' | 'pawn'
  /** Session file the adopting instance opens to continue this worker. */
  sessionFile?: string
  /** Child session id the card is keyed by, so a resume updates the same card. */
  childSessionId?: string
  /** Model the worker ran on, so a resume continues on the same one. */
  modelId?: string
  /** Reasoning effort the worker ran at, so a resume keeps that level. */
  thinkingLevel?: string
  /** Instructions the worker was spawned with, i.e. the work it has to finish. */
  prompt?: string
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
  /** Workers the release was running, with what their resume needs. */
  workers?: HandedOffWorker[]
  /** Pawn threads whose runs were stopped so the adopter can resume them. */
  pawnThreadIds?: string[]
  /**
   * Question cards the release was holding, so the adopter can put the decision
   * back in front of the user instead of resuming past it.
   */
  questions?: HandedOffQuestion[]
}

/**
 * How many workers one block of a continuation note names. A longer fan-out
 * keeps the note to a bounded paragraph: the tail is summarized by count,
 * because the resumed agent already knows the whole list from its own trace.
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
 * The rule lives in the shared thread vocabulary because the renderer reads it
 * too: a pawn is a thread carrying its spawner in `coordinatorThreadId` and no
 * Assignment or Achievement role, which is what the row mark, the pawn board and
 * the worker hand-off all have to agree on.
 */
export { isPawnWorkerThread } from '../../../lib/types/thread'

/**
 * The workers of a thread that are still running, newest card first.
 *
 * Only a `running` card is a worker in flight when the thread moved. A worker
 * that had already reported (`completed`, `error`, `aborted`) finished, or was
 * stopped by the user, before the thread left: resuming must not re-open that.
 *
 * A running card also carries what the resume needs, which the shared rows
 * cannot show once the departure has settled it: the session file to open, the
 * model and effort to continue at, and the instructions the worker was given.
 *
 * A pawn's card appears on the spawning thread too, and a pawn is identified by
 * `activity.pawn`, so the caller can tell "this one moves with the primary"
 * from "this one has to be resumed from its own session".
 */
export function runningWorkers(messages: readonly AgentMessage[]): HandedOffWorker[] {
  const seen = new Set<string>()
  const workers: HandedOffWorker[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'subagent') continue
      const activity = part.activity
      if (activity.status !== 'running') continue
      // The worker's own id, so a resume on another instance can register the
      // worker under the name its primary agent already uses. The tool call id
      // is only the card's key, never the agent's name.
      const agentId = activity.agentId ?? part.callID ?? activity.childSessionId ?? part.id
      if (seen.has(agentId)) continue
      seen.add(agentId)
      workers.push({
        agentId,
        label: workerLabel(activity),
        kind: activity.pawn === true ? 'pawn' : 'nested',
        ...(activity.sessionFile ? { sessionFile: activity.sessionFile } : {}),
        ...(activity.childSessionId ? { childSessionId: activity.childSessionId } : {}),
        ...(activity.modelId ? { modelId: activity.modelId } : {}),
        ...(activity.thinkingLevel ? { thinkingLevel: activity.thinkingLevel } : {}),
        ...(activity.prompt ? { prompt: activity.prompt } : {})
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
 * Whether a hand-off can continue this worker on the adopting instance.
 *
 * A nested worker is a session inside the process the move ends, and its
 * session file is what the adopting harness opens to start it again, so a
 * worker with a file comes across and a worker without one is lost with that
 * process. A pawn is handled by its thread instead, so it is never "resumed"
 * from a file here; the caller says whether its thread is being resumed.
 */
function isResumableWorker(worker: HandedOffWorker): boolean {
  return worker.kind === 'nested' && Boolean(worker.sessionFile)
}

/** The roster a note block names, keeping the count of the workers it dropped. */
function rosterLines(workers: readonly HandedOffWorker[]): string[] {
  const { named, omitted } = boundedWorkerRoster(workers)
  const lines = named.map((worker) => `- ${worker.label} (${worker.agentId})`)
  if (omitted > 0) lines.push(`- and ${omitted} more`)
  return lines
}

/**
 * The note a transferred thread's continuation carries.
 *
 * It has to say what the agent cannot discover for itself: the thread moved
 * instances, and which of its workers are still working on the new instance
 * versus which ones the move ended. A worker that came across is running here,
 * so telling the agent to re-spawn it would start the same job twice, and a
 * worker that did not is gone, so the note must say the loss is not a failure of
 * its work or the agent reads its own trace back as one.
 *
 * Pawns are named only when their threads did not come along: a resumed pawn is
 * a thread the primary already sees, so it needs no line of its own.
 */
export function handedOffWorkersNote(
  workers: readonly HandedOffWorker[],
  options: { pawnsResumed: boolean }
): string {
  const resumable = workers.filter((worker) => isResumableWorker(worker))
  const stopped = workers.filter((worker) =>
    worker.kind === 'nested' ? !isResumableWorker(worker) : !options.pawnsResumed
  )
  const blocks: string[] = []
  if (resumable.length > 0) {
    const lead =
      resumable.length === 1
        ? 'This thread was moved to another app instance mid-turn. 1 nested worker came with it: its session was handed off and resumed on this instance, so it is still running here and it is not stopped:'
        : `This thread was moved to another app instance mid-turn. ${resumable.length} nested workers came with it: their sessions were handed off and resumed on this instance, so they are still running here and they are not stopped:`
    const closing =
      resumable.length === 1
        ? 'Continue by waiting for it to report, or read it with cio_agent_status and cio_agent_output. Do not spawn it again.'
        : 'Continue by waiting for them to report, or read them with cio_agent_status and cio_agent_output. Do not spawn these workers again.'
    blocks.push([lead, ...rosterLines(resumable), closing].join('\n'))
  }
  if (stopped.length > 0) {
    const noun = stopped.length === 1 ? 'worker' : 'workers'
    const lead =
      resumable.length > 0
        ? `The same move stopped ${stopped.length} ${noun} that could not come along, and that is not a failure of their work:`
        : `This thread was moved to another app instance mid-turn. The move stopped ${stopped.length} ${noun} that could not come along, and that is not a failure of their work:`
    blocks.push(
      [
        lead,
        ...rosterLines(stopped),
        'Read what they already changed in the repository before you continue, then re-spawn the unfinished work with cio_spawn_agent (or cio_pawn_agent for a thread of its own). Do not report these workers as failed.'
      ].join('\n')
    )
  }
  return blocks.join('\n\n')
}

/** Fold the note into the continuation text the resumed agent receives. */
export function withHandedOffWorkersNote(nudge: string, note: string): string {
  if (!note) return nudge
  return `${nudge}\n\n${note}`
}

/**
 * The note a resumed agent receives about the sub-agents an app closure killed.
 *
 * A nested sub-agent is a session inside the harness process its parent turn
 * owns, so the process goes down with the app and the worker with it. Nothing in
 * the harness ever reports that, and the parent came back believing its workers
 * were still in flight. The note says three things it cannot discover: they are
 * gone, they produced nothing, and there is a way to find an account that can
 * still pay for the retry.
 */
export function interruptedSubagentsNote(workers: readonly HandedOffWorker[]): string {
  const nested = workers.filter((worker) => worker.kind === 'nested')
  if (nested.length === 0) return ''
  const { named, omitted } = boundedWorkerRoster(nested)
  const lines = named.map((worker) => `- ${worker.label} (${worker.agentId})`)
  if (omitted > 0) lines.push(`- and ${omitted} more`)
  const noun = nested.length === 1 ? 'sub-agent' : 'sub-agents'
  return [
    `This app closed while it was running ${nested.length} ${noun}, so they ended without reporting. Their work is not in progress and will produce no result:`,
    ...lines,
    'Before you redo that work yourself, call cio_orchestrate_targets to see which connected account still has subscription capacity, then spawn the work again on an account and model that has capacity. If no account has capacity, do the work yourself on the model this thread already uses.'
  ].join('\n')
}
