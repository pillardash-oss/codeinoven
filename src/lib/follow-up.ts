/**
 * A follow-up: one agent-scheduled wake of the thread it is working in.
 *
 * The app has always had a clock, but only for an assistant's tasks, and a due
 * task always fires on a brand new run thread. That is exactly wrong for the
 * case this exists for. An agent that opened a business support chat and found
 * the desk closed, or that was promised an emailed answer, needs the same thread
 * woken later with the same browser page still open, so it can read the reply and
 * carry the conversation on.
 *
 * The contract is deliberately small and honest: one wake, at one time, with a
 * self-contained instruction written by the agent that scheduled it, and the
 * resume is an ordinary internal turn on the thread. Nothing here invents a
 * scheduler, and nothing here can touch a thread that was deleted.
 */

/** Shortest lead time a follow-up may be scheduled with, so a wake is never a spin. */
export const FOLLOW_UP_MIN_LEAD_MS = 60_000

/** Longest horizon a follow-up may reach into, so a typo cannot arm a wake for years. */
export const FOLLOW_UP_MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000

/** How many pending follow-ups one thread may hold, so a loop cannot pile them up. */
export const FOLLOW_UP_MAX_PENDING_PER_THREAD = 3

/** Ceiling on the instruction the resumed turn reads. */
export const FOLLOW_UP_PROMPT_LIMIT = 2_000

/** Ceiling on the short label the user reads in the thread. */
export const FOLLOW_UP_NOTE_LIMIT = 160

/**
 * How long a follow-up waits when it came due on a thread that is mid-turn.
 *
 * A wake that interrupts a run is worse than a late one: the thread is already
 * working on something, and the follow-up is only ever about what happens after
 * that. It is retried a bounded number of times so a thread that stays busy does
 * not accumulate a time bomb.
 */
export const FOLLOW_UP_BUSY_DEFER_MS = 5 * 60 * 1000

/** How many deferrals a single follow-up may spend before it is dropped. */
export const FOLLOW_UP_MAX_DEFERRALS = 12

/** The record the app persists and the UI and agents read. */
export interface FollowUp {
  id: string
  projectId: string
  threadId: string
  /** Epoch ms the thread should be woken at. */
  dueAt: number
  createdAt: number
  /** What the resumed turn has to do. Written to stand on its own. */
  prompt: string
  /** One short line naming what this wake is for. */
  note: string
  /** Deferrals already spent because the thread was mid-turn. */
  deferred: number
}

/**
 * What a renderer needs to badge a row and describe the wake on hover.
 *
 * Deliberately not the whole record: the instruction is the agent's own business
 * and can be long, and no surface needs it to say "this thread wakes at 09:10".
 */
export interface FollowUpNotice {
  id: string
  projectId: string
  threadId: string
  dueAt: number
  note: string
}

/** Reduce one armed wake to what the renderer reads. */
export function followUpNotice(followUp: FollowUp): FollowUpNotice {
  return {
    id: followUp.id,
    projectId: followUp.projectId,
    threadId: followUp.threadId,
    dueAt: followUp.dueAt,
    note: followUp.note
  }
}

/** What the capability accepts when an agent schedules one. */
export interface FollowUpRequest {
  projectId: string
  threadId: string
  dueAt: number
  prompt: string
  note: string
}

export const FOLLOW_UP_CAPABILITY_NAME = 'cio:follow-up'

export const FOLLOW_UP_CAPABILITY_SUMMARY =
  'Schedules a reminder that wakes this thread once, at a time the user agreed to, for work waiting on someone else: closed support hours, a promised callback, an emailed ticket, a refund or review window, or maintenance finishing. The thread resumes with its own browser pages still open and a self-contained instruction you write, so it can read the answer and carry on. It asks the user first, it is cancelled with the thread, and it never runs early.'

/**
 * The capability contract, handed to an agent that activates it.
 *
 * Written for the moment that matters: the user is blocked by another party's
 * clock, and the agent has to turn that into a decision the user agrees to
 * instead of a wait they have to remember.
 */
export const FOLLOW_UP_CAPABILITY_DOCS = `# Wake this thread later

Some work cannot finish inside one turn because the next step belongs to someone
else's clock: a support desk that is closed until morning, a ticket answered by
email, a promised callback, a refund window, a deployment that finishes tonight.
Waiting for it is not a reason to hand the work back to the user.

## When to use it

- The next step is blocked until a time you can name, and waiting inside the turn
  would be hours of nothing.
- Always say the time out loud first, in the user's own timezone, and ask whether
  they want it picked up then. Never schedule a wake the user did not agree to,
  and never schedule one silently.
- Do not use it for something the user should do themselves, and do not use it to
  poll a page you can already poll inside this turn.

## How to schedule one

- Call \`schedule_followup\` with \`minutesFromNow\` (or \`at\` when you know the exact
  epoch milliseconds), a short \`note\`, and a \`prompt\`.
- The \`prompt\` is the whole instruction for the future turn, which does not see
  this conversation: name the counterparty, the ticket or case reference, what was
  asked for, what has already been tried, the page or tab to poll, and what counts
  as a resolution. Write it as an order to yourself.
- The wake resumes THIS thread, with its browser pages still open, so say which
  page to check and what to look for.
- One follow-up per thing you are waiting for. Use \`list_followups\` to see what is
  already armed, and \`cancel_followup\` when the answer arrived early or the user
  changed their mind.

## Saying it to the user

- Name the time, say what you will do then, and tell them they do not have to
  watch anything. That promise is the point of this capability.`

/** The operations the capability exposes through the utility gateway. */
export const FOLLOW_UP_OPERATIONS = [
  {
    name: 'schedule_followup',
    description:
      'Wake this thread once, at a time the user agreed to, to pick up work that is waiting on another party. Pass minutesFromNow, or at as epoch milliseconds, plus a note and a self-contained prompt naming what to check and what counts as resolved.',
    inputSchema: {
      type: 'object',
      properties: {
        minutesFromNow: {
          type: 'number',
          minimum: 1,
          maximum: FOLLOW_UP_MAX_HORIZON_MS / 60_000,
          description:
            'Minutes from now until the wake. The usual form: a support desk that reopens in nine hours is 540.'
        },
        at: {
          type: 'number',
          description:
            'Epoch milliseconds of the exact wake time, when you know it. Use minutesFromNow otherwise.'
        },
        note: {
          type: 'string',
          minLength: 1,
          maxLength: FOLLOW_UP_NOTE_LIMIT,
          description:
            'One short line naming what this wake is for, e.g. "Sales chat reopens, ask about the paid OCI account".'
        },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: FOLLOW_UP_PROMPT_LIMIT,
          description:
            'The instruction the future turn runs on. It cannot see this conversation, so name the counterparty, the reference, what was asked for, the page to poll, and what counts as resolved.'
        }
      },
      required: ['note', 'prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'list_followups',
    description:
      'List the wakes armed on this thread: their id, when they fire, and what they are for.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'cancel_followup',
    description:
      'Cancel an armed wake on this thread, by id, when the answer already arrived or the user changed their mind.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: 'The follow-up id from list_followups.' }
      },
      required: ['id'],
      additionalProperties: false
    }
  }
] as const
