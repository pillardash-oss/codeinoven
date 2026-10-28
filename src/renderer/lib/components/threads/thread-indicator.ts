import { isOrchestrationChildThread, type Thread } from '$shared/types'

/**
 * The single indicator slot a thread row can show. Speech, browser sound and
 * computer use compete for it, and exactly one of them wins.
 *
 * `transcribing-send` and `transcribing-steer` are the armed refinements of a
 * transcription in flight: the user has told the app how the transcript should
 * be delivered once it lands, so the row shows that intent rather than plain
 * processing.
 *
 * `browser-audio` is a browser tab of this thread playing sound. It is not a
 * speech action of the app's own, but it is still sound the user can hear coming
 * from a thread, so it takes the same slot and competes the same way: the mark
 * must say which thread is making the noise the user is hearing.
 *
 * `engineering` is the durable Engineering mark: the thread has engaged the
 * Engineering lifecycle, or the independent audit that is the other half of the
 * same tooling (see {@link threadUsesEngineeringTooling}). It is not an action in
 * flight, so it carries the oldest candidate time and yields the slot to any live
 * action (recording, speaking, transcription, computer use, browser sound)   the
 * transient action is the more urgent fact, and the Engineering mark returns
 * the moment the slot is free.
 */
export type ThreadIndicator =
  | 'recording'
  | 'speaking'
  | 'transcribing'
  | 'transcribing-send'
  | 'transcribing-steer'
  | 'computer-use'
  | 'browser-audio'
  | 'browser-microphone'
  | 'browser-camera'
  | 'browser-screen'
  | 'engineering'

export interface ThreadIndicatorCandidate {
  indicator: ThreadIndicator
  /** Wall-clock time the action this candidate represents began. */
  at: number
}

/**
 * Pick the row's indicator under the app's "last action wins" rule: the
 * candidate whose action began most recently takes the slot.
 *
 * Order carries meaning. Candidates are supplied from the most to the least
 * preferred, and an identical `at` keeps the earlier candidate, which preserves
 * the speech precedence that already governs the slot (listening, then
 * speaking, then transcribing) when two actions share a timestamp.
 */
export function resolveThreadIndicator(
  candidates: readonly ThreadIndicatorCandidate[]
): ThreadIndicator | null {
  let winner: ThreadIndicatorCandidate | null = null
  for (const candidate of candidates) {
    if (winner === null || candidate.at > winner.at) winner = candidate
  }
  return winner?.indicator ?? null
}

/**
 * Whether a thread has engaged Engineering tooling at all, which is what the
 * row's Engineering mark reports.
 *
 * The durable `engineering` marker covers the Engineering lifecycle. The
 * independent (spec-less) audit is the other half of the same tooling and is
 * deliberately locked out of the lifecycle modes, so it never sets that marker:
 * it carries its own durable pair instead (`independentAudit` while the switch
 * is on, `independentAuditInitialized` once the first run starts). A thread
 * whose audit report is waiting must wear the same mark the lifecycle threads
 * wear, or the one moment it is asking for the user is the moment it reads as an
 * ordinary conversation.
 */
export function threadUsesEngineeringTooling(
  thread: Pick<Thread, 'engineering' | 'independentAudit' | 'independentAuditInitialized'>
): boolean {
  return (
    thread.engineering === true ||
    thread.independentAudit === true ||
    thread.independentAuditInitialized === true
  )
}

/**
 * Whether the conversation view must load this thread's Engineering state
 * (lifecycle, Spec, Brainstorm, PRD, Assignment, audit).
 *
 * Engineering state exists only where the tooling was engaged, plus the
 * orchestration children that carry a coordinator's work and never set the
 * marker themselves. The old rule was "not a chat thread", which made every
 * ordinary conversation ask six thread-scoped engines on mount and on every turn
 * boundary for state that cannot exist there: IPC on the conversation's critical
 * path, and a background read racing a deleted thread. Chat threads (Chats, the
 * Assistant space, browser assistant chats) own no Engineering state at all.
 *
 * The audit fields are here on purpose. The independent (spec-less) audit never
 * sets the Engineering marker, so its own durable pair is what keeps it
 * hydrated, and a row that still carries an audit gate or a durable auditor
 * thread is never treated as an ordinary conversation even if a marker is
 * missing from an older database.
 */
export function threadHydratesEngineeringState(
  thread: Pick<
    Thread,
    | 'engineering'
    | 'independentAudit'
    | 'independentAuditInitialized'
    | 'coordinatorThreadId'
    | 'assignmentId'
    | 'assignmentRole'
    | 'achievementRole'
    | 'auditState'
    | 'auditorThreadId'
  >
): boolean {
  return (
    threadUsesEngineeringTooling(thread) ||
    isOrchestrationChildThread(thread) ||
    thread.auditState !== undefined ||
    thread.auditorThreadId !== undefined
  )
}
