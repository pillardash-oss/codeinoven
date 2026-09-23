import type {
  LocalRankingGradeProgress,
  LocalRankingGradeScope,
  LocalRankingQueueStatus
} from '$shared/types'
import { formatNumber } from './profile-settings-format'
import type { UsageClearCopyPart } from './profile-settings-records'

/**
 * Copy for the ranking grading actions, held as data so no wording lives in
 * markup.
 *
 * The dialog states the two things a user cannot infer from a count: that a
 * conversation still inside its inactivity window is graded early when they ask
 * for the whole queue, and that a conversation the grading model cannot score
 * stays queued instead of disappearing unscored.
 */
export interface RankingGradeConfirmation {
  title: string
  /** Action grading only what is already due, or null when nothing is due. */
  dueLabel: string | null
  /** Action grading every conversation still waiting. */
  allLabel: string
  /** Sentence stating how many conversations are graded, and by which judge. */
  scope: UsageClearCopyPart[]
  /** Sentence stating what the run does with each conversation. */
  outcome: UsageClearCopyPart[]
  /** Emphasis line under the body. */
  note: string
}

/** The confirmation for a run over the queue the panel is showing. */
export function rankingGradeConfirmation(
  status: LocalRankingQueueStatus
): RankingGradeConfirmation {
  return {
    title: 'Grade queued conversations',
    dueLabel: status.due > 0 ? `Grade ${formatNumber(status.due)} due now` : null,
    allLabel: `Grade all ${formatNumber(status.awaiting)}`,
    scope: scopeParts(status),
    outcome: [
      quoted('Each conversation is judged 0 to 10 and leaves the queue once its score is counted.'),
      quoted(
        ' A conversation the grading model cannot score stays queued, never discarded unscored.'
      )
    ],
    note: 'Grading spends tokens on the model above, and the scores it produces are permanent.'
  }
}

/**
 * Live progress line for a run in flight. `remaining` is the queue's own live
 * count, so a user watching a backlog drain sees the number that matters rather
 * than only how far the run has come.
 */
export function rankingGradeProgressLabel(progress: LocalRankingGradeProgress): string {
  const graded = `Graded ${formatNumber(progress.graded)} of ${formatNumber(progress.requested)}`
  if (progress.remaining === 0) return `${graded} · queue clear`
  return `${graded} · ${formatNumber(progress.remaining)} still waiting`
}

/** What a finished run did, including why anything is still queued. */
export function rankingGradeNotice(
  progress: LocalRankingGradeProgress,
  scope: LocalRankingGradeScope
): string {
  if (progress.cancelled) {
    return `Stopped after grading ${formatNumber(progress.graded)} of ${formatNumber(
      progress.requested
    )} conversations. ${formatNumber(progress.remaining)} are still queued.`
  }
  if (progress.requested === 0) {
    return scope === 'due'
      ? 'Nothing was due for grading. Every queued conversation is still inside its waiting window.'
      : 'The grading queue was already clear.'
  }
  if (progress.remaining === 0) {
    return `Graded ${formatNumber(progress.graded)} conversations and cleared the queue.`
  }
  const graded = `Graded ${formatNumber(progress.graded)} of ${formatNumber(
    progress.requested
  )} conversations.`
  // A `due` run leaves rows behind that it was never allowed to touch, so it
  // must not blame the model for them; a full run only leaves rows the model
  // could not score.
  if (scope === 'due') {
    return `${graded} ${formatNumber(
      progress.remaining
    )} are still queued; grading the whole queue takes the rest early.`
  }
  return `${graded} ${formatNumber(
    progress.remaining
  )} are still queued because the grading model did not return a score for them.`
}

function scopeParts(status: LocalRankingQueueStatus): UsageClearCopyPart[] {
  const parts: UsageClearCopyPart[] = [
    quoted('You are about to grade '),
    emphasised(
      `${formatNumber(status.awaiting)} ${
        status.awaiting === 1 ? 'conversation awaiting grading' : 'conversations awaiting grading'
      }`
    ),
    quoted(' with '),
    emphasised(status.judge.label),
    quoted('.')
  ]
  if (status.due === status.awaiting) {
    parts.push(quoted(status.awaiting === 1 ? ' It is due now.' : ' Every one of them is due now.'))
    return parts
  }
  const waiting = status.awaiting - status.due
  parts.push(
    quoted(' '),
    emphasised(formatNumber(status.due)),
    quoted(` ${status.due === 1 ? 'is' : 'are'} due now and `),
    emphasised(formatNumber(waiting)),
    quoted(
      ` ${waiting === 1 ? 'is' : 'are'} still inside the 24-hour inactivity window, so grading the whole queue takes ${
        waiting === 1 ? 'it' : 'them'
      } early.`
    )
  )
  return parts
}

function quoted(text: string): UsageClearCopyPart {
  return { text, emphasis: false }
}

function emphasised(text: string): UsageClearCopyPart {
  return { text, emphasis: true }
}
