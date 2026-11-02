import {
  FOLLOW_UP_MAX_HORIZON_MS,
  FOLLOW_UP_NOTE_LIMIT,
  FOLLOW_UP_PROMPT_LIMIT,
  type FollowUp
} from '../../lib/follow-up'
import { formatDateTimeWithWeekday } from '../../lib/date-time-format'
import type { FollowUpExecutor } from '../utilities/utility-orchestration-service'
import type { FollowUpService } from './follow-up-service'

/** What the capability reports about one armed wake. */
interface FollowUpSummary {
  id: string
  dueAt: number
  note: string
}

function shortSummary(followUp: FollowUp): FollowUpSummary {
  return { id: followUp.id, dueAt: followUp.dueAt, note: followUp.note }
}

function boundedString(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} cannot be empty`)
  if (trimmed.length > limit) {
    throw new Error(`${field} must be at most ${limit} characters (it is ${trimmed.length})`)
  }
  return trimmed
}

/**
 * Resolve the wake time from the two shapes the capability accepts.
 *
 * `minutesFromNow` is the form an agent should use, because it needs no clock of
 * its own; `at` exists for the case where the app's own reported time is already
 * in the prompt. Exactly one of them must be present, so a schedule is never
 * guessed from a missing field.
 */
function resolveDueAt(input: Record<string, unknown>, now: number): number {
  const minutes = input['minutesFromNow']
  const at = input['at']
  if (typeof minutes === 'number' && typeof at === 'number') {
    throw new Error('Pass either minutesFromNow or at, and not both')
  }
  if (typeof minutes === 'number') {
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error('minutesFromNow must be a positive number of minutes')
    }
    return now + Math.round(minutes * 60_000)
  }
  if (typeof at !== 'number') {
    throw new Error('Pass either minutesFromNow or at')
  }
  if (!Number.isFinite(at)) throw new Error('at must be epoch milliseconds')
  if (at - now > FOLLOW_UP_MAX_HORIZON_MS) {
    throw new Error('A follow-up cannot be scheduled more than 30 days ahead')
  }
  return Math.round(at)
}

/**
 * The app-owned operations behind `cio:follow-up`.
 *
 * Every operation is scoped to the thread that is running: the caller supplies
 * its project and thread ids, never the agent, so a wake can only ever be armed
 * on the conversation that asked for it.
 */
export function createFollowUpExecutor(service: FollowUpService): FollowUpExecutor {
  return async (operation, input, context) => {
    if (operation === 'schedule_followup') {
      const dueAt = resolveDueAt(input, service.now())
      const note = boundedString(input['note'], 'note', FOLLOW_UP_NOTE_LIMIT)
      const prompt = boundedString(input['prompt'], 'prompt', FOLLOW_UP_PROMPT_LIMIT)
      const followUp = await service.schedule({
        projectId: context.projectId,
        threadId: context.threadId,
        dueAt,
        note,
        prompt
      })
      return {
        scheduled: shortSummary(followUp),
        message: `This thread will be woken ${formatDateTimeWithWeekday(followUp.dueAt)}. Say when that is in the user's own words and tell them they do not have to watch anything.`
      }
    }
    if (operation === 'list_followups') {
      return { followUps: service.listForThread(context.threadId).map(shortSummary) }
    }
    if (operation === 'cancel_followup') {
      const id = boundedString(input['id'], 'id', 200)
      const armed = service.listForThread(context.threadId).some((entry) => entry.id === id)
      if (!armed) throw new Error('No follow-up with that id is armed on this thread')
      service.cancel(id)
      return { cancelled: id }
    }
    throw new Error(
      'The follow-up capability exposes schedule_followup, list_followups and cancel_followup'
    )
  }
}
