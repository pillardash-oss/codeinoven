import { ASSISTANT_SPACE_ID, type Thread } from '../../lib/types'
import {
  UTILITY_SUGGESTION_DECLINE_ANSWER,
  UTILITY_SUGGESTION_INSTALL_ANSWER
} from '../../lib/utility-suggestion'
import type { PendingQuestionInfo } from './chat-engine/chat-engine-types'
import type { ChatEngine } from './chat-engine'
import { DON_THREAD_ID } from '../don/don-bootstrap'
import { teammateAuthor, writeTeammateLine } from './delegation-lines'
import { Logger } from '../system/logger'

/**
 * The questions a teammate's run asks, settled where the work was asked for.
 *
 * A thread the app dispatched on someone's behalf never raises a card of its own:
 * its question belongs to the conversation that started the work. The card is drawn
 * there by the app's own mirror, which is what keeps a parked run visible. What the
 * mirror cannot do is answer it, and the orchestrator is the one party that should:
 * a teammate stopping to ask how the work should be done is a question about the
 * work, not a decision the person who asked for it has to make.
 *
 * So a blocked question from one of Don's children wakes Don once, with the question
 * and its options, and Don settles it with `cio_answer_teammate`. A credential is
 * the single exception, because only the user can supply one: those questions are
 * left on the card in Don's conversation, which is where the user sees it. An
 * install suggestion is not one of them: it is a decision about how the work gets
 * done, so Don settles it by telling the teammate how to proceed without it.
 *
 * Everything here is best effort and never throws into the turn that asked. The card
 * the mirror draws is the fallback, so a router failure costs the user a decision
 * they can still make, never a stuck run nobody can see.
 */

/** Requests already handed to Don, so one question never wakes it twice. */
const routed = new Set<string>()
/** A bounded memory: a settled request id is never asked about again anyway. */
const ROUTED_LIMIT = 200

/**
 * The question shapes only the user ever answers.
 *
 * A credential and a sign-in are values nobody else can supply: an API key, a
 * password, an OAuth or MCP sign-in, a connected account. Everything else, an
 * install suggestion included, is a decision about the work and belongs to Don.
 */
function needsTheUser(pending: PendingQuestionInfo): boolean {
  return pending.request.questions.some(
    (question) => question.secretRequest === true || question.mcpSignIn !== undefined
  )
}

/** Whether this thread is one Don started, and the router may speak about it. */
function donInitiator(thread: Thread | null): string | null {
  const origin = thread?.dispatchOrigin
  if (!origin) return null
  if (origin.initiatorProjectId !== ASSISTANT_SPACE_ID) return null
  if (origin.initiatorThreadId !== DON_THREAD_ID) return null
  return origin.initiatorThreadId
}

/** Remember a request id without letting the set grow for the process lifetime. */
function remember(requestId: string): void {
  routed.add(requestId)
  if (routed.size <= ROUTED_LIMIT) return
  const oldest = routed.values().next().value
  if (oldest !== undefined) routed.delete(oldest)
}

/** One question, written the way Don reads it. */
function describeQuestion(
  question: NonNullable<PendingQuestionInfo['request']['questions']>[number],
  index: number,
  total: number
): string {
  const lines = [`${total > 1 ? `${index + 1}. ` : ''}${question.prompt}`]
  const header = question.header?.trim()
  if (header) lines.push(`   (${header})`)
  const description = question.description?.trim()
  if (description) lines.push(`   ${description}`)
  const options = question.richOptions?.length
    ? question.richOptions.map((option) =>
        option.description ? `${option.label}: ${option.description}` : option.label
      )
    : (question.options ?? [])
  if (options.length > 0) {
    lines.push('   Options:')
    for (const option of options) {
      lines.push(`   - ${option}`)
    }
  }
  if (question.multiple === true) lines.push('   (more than one answer is allowed)')
  if (question.custom !== false) lines.push('   (a custom answer is allowed)')
  return lines.join('\n')
}

/** The line posted into Don's conversation, under the blocked teammate's name. */
function questionLine(thread: Thread, pending: PendingQuestionInfo): string {
  const questions = pending.request.questions
  const asked = questions
    .map((question, index) => describeQuestion(question, index, questions.length))
    .join('\n\n')
  return `${thread.title.trim() || 'A teammate'} needs a decision to continue:\n\n${asked}`
}

/** What Don is told to do about it. */
function donInstruction(thread: Thread, pending: PendingQuestionInfo): string {
  const questions = pending.request.questions
  const asked = questions
    .map((question, index) => describeQuestion(question, index, questions.length))
    .join('\n\n')
  const suggestion = questions.some((question) => question.utilitySuggestion !== undefined)
  return [
    `"${thread.title.trim() || 'A teammate'}" is blocked on a question from its run. The question and the ids come from the app, so use them exactly as written.`,
    asked,
    'Answer it yourself with `cio_answer_teammate`:',
    `- threadId: ${pending.request.threadId}`,
    `- requestId: ${pending.request.requestId}`,
    `- answers: one entry per question, in this order, each a single-item array holding the option label word for word, or your own wording when a custom answer is allowed.`,
    ...(suggestion ? [suggestionInstruction()] : []),
    'Decide it with what you already know about the request and the user: how the work should be done, which option fits, what a term means. You are the one who put this work in their hands, so this is yours to settle.',
    'One thing is never yours: an API key, a password, a login, an OAuth or MCP sign-in, or a connected account. Those stay with the user, who answers the card the app has already put in this conversation. If the question is that, do not call the tool: write one short line with `cio_reply_in_chat` saying which credential the work needs and stop.',
    'Do not ask the user anything else, do not restate this instruction, and do not tell them to open another thread.'
  ].join('\n\n')
}

/**
 * What Don does with a capability the app offered to install.
 *
 * Installing software is the user's call in every other surface of the app, and
 * Don cannot make it on their behalf. The decision itself is still Don's: the
 * teammate is told how to finish the work with what the app already has.
 */
function suggestionInstruction(): string {
  return [
    'This one is a capability the app offered to install. Never answer it with',
    `"${UTILITY_SUGGESTION_INSTALL_ANSWER}": nothing is installed on the user's behalf.`,
    `Answer with "${UTILITY_SUGGESTION_DECLINE_ANSWER}" when the work does not need it, or with your own wording telling the teammate exactly how to finish the work without that tool.`,
    'If the work genuinely cannot proceed without it, decline it and say in one line with `cio_reply_in_chat` which capability the work needs, so the user can install it themselves.'
  ].join(' ')
}

/**
 * Wake Don once for a question one of its children is blocked on.
 *
 * Silent and one-shot per request: a question that is not one of Don's children,
 * one only the user can answer (a credential or a sign-in), one already handed
 * over, or one asked while Don has no conversation to answer from is left exactly
 * as it was, on the card the user can answer.
 */
export async function routeTeammateQuestion(
  engine: ChatEngine,
  pending: PendingQuestionInfo
): Promise<void> {
  const { projectId, threadId, requestId } = pending.request
  if (projectId !== ASSISTANT_SPACE_ID) return
  if (pending.resolving) return
  if (needsTheUser(pending)) return
  if (routed.has(requestId)) return
  try {
    const thread = await engine.threadManager.getThread(projectId, threadId)
    if (!donInitiator(thread) || !thread) return
    const don = await engine.threadManager.getThread(ASSISTANT_SPACE_ID, DON_THREAD_ID)
    if (!don?.settings) return
    if (!thread.dispatchOrigin) return
    remember(requestId)
    const author = teammateAuthor(thread)
    if (!author) return
    await writeTeammateLine(engine, {
      author,
      thread,
      id: `don-question-${requestId}`,
      text: questionLine(thread, pending)
    })
    await engine.sendPrompt(
      ASSISTANT_SPACE_ID,
      DON_THREAD_ID,
      don.settings,
      donInstruction(thread, pending),
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal'
    )
  } catch (error) {
    routed.delete(requestId)
    Logger.dev('Teammate question routing skipped', {
      requestId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** What Don's answer operation hands back to the turn that called it. */
export interface TeammateAnswerResult {
  answered: boolean
  threadId?: string
  error?: string
}

/**
 * Settle a teammate's blocked question from Don's own turn.
 *
 * The app's ordinary answer path validates everything: the request must still be
 * registered for that exact thread, and the answers must match the questions. The
 * one rule added here is the one the tool must never cross: only a thread this
 * conversation started can be answered this way.
 */
export async function answerTeammateQuestion(
  engine: ChatEngine,
  input: { threadId: string; requestId: string; answers: string[][]; note?: string },
  context: { projectId: string; threadId: string }
): Promise<TeammateAnswerResult> {
  try {
    const thread = await engine.threadManager.getThread(ASSISTANT_SPACE_ID, input.threadId)
    if (!thread) return { answered: false, error: 'That teammate thread no longer exists' }
    if (thread.dispatchOrigin?.initiatorThreadId !== context.threadId) {
      return { answered: false, error: 'That thread was not started from this conversation' }
    }
    await engine.answerQuestion(ASSISTANT_SPACE_ID, input.threadId, input.requestId, input.answers)
    const note = input.note?.trim()
    const author = note ? teammateAuthor(thread) : null
    if (author && note) {
      await writeTeammateLine(engine, {
        author,
        thread,
        id: `don-question-answer-${input.requestId}`,
        text: note
      }).catch(() => undefined)
    }
    return { answered: true, threadId: input.threadId }
  } catch (error) {
    return { answered: false, error: error instanceof Error ? error.message : String(error) }
  }
}
