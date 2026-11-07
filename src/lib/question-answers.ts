import type { AgentMessage } from './types'

/**
 * Stable id prefix the app gives the transcript record it writes when the
 * reader answers an agent question.
 *
 * The record is the app's own ledger of what the reader decided, and answering
 * resumes the provider turn that asked the question instead of starting a new
 * one. Grouping it as a turn boundary is what split a running trace into a
 * finished one above the answer and a second trace below it, so both the
 * transcript and the working trace treat it as transparent to turn grouping.
 */
export const QUESTION_ANSWER_MESSAGE_PREFIX = 'question-answer-'

/** True for the app-written record of an answer the reader gave. */
export function isQuestionAnswerRecord(message: AgentMessage): boolean {
  return message.role === 'user' && message.id.startsWith(QUESTION_ANSWER_MESSAGE_PREFIX)
}
