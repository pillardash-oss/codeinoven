/**
 * Contract for the app-owned `cio_util_suggest` gateway tool.
 *
 * The tool lets an agent propose a capability it found for the user to install:
 * a skill, an MCP server, or a plugin bundle of both. The app turns the proposal
 * into an actionable card on the canonical pending-question surface, and installs
 * the bundle through the Utilities registry on every harness only when the user
 * accepts. The bundle never carries a secret; a credential the capability needs
 * is collected afterwards with `cio_ask_secret`, exactly as for `install_bundle`.
 */

import type { AgentQuestion, AgentUtilitySuggestionEntry } from './types'

/** What the user decided about one proposed capability. */
export type UtilitySuggestionDecision = 'accepted' | 'declined'

/** Option label that means "install the proposal". Anything else is a decline. */
export const UTILITY_SUGGESTION_INSTALL_ANSWER = 'Install in CodeInOven'

/** Option label that means "do not install the proposal". */
export const UTILITY_SUGGESTION_DECLINE_ANSWER = 'Not now'

/**
 * The single question the suggestion card renders.
 *
 * Installing software is never automatic, so the card offers exactly two
 * answers with no free-text field: an abandoned or expired card settles as a
 * decline rather than inventing consent.
 */
export function utilitySuggestionQuestion(entry: AgentUtilitySuggestionEntry): AgentQuestion {
  const summary = entry.kinds.length > 0 ? ` (${entry.kinds.join(', ')})` : ''
  return {
    prompt: `Install ${entry.name}${summary}?`,
    header: 'Suggested capability',
    description: entry.reason,
    richOptions: [
      {
        label: UTILITY_SUGGESTION_INSTALL_ANSWER,
        description: `Add ${entry.name} to Utilities so it is available on every harness, present and future.`
      },
      {
        label: UTILITY_SUGGESTION_DECLINE_ANSWER,
        description: 'Leave it out for now. You can install it yourself from Utilities later.'
      }
    ],
    custom: false,
    utilitySuggestion: entry
  }
}

/** Whether one pending question is an agent-proposed capability installation. */
export function isUtilitySuggestionQuestion(question: AgentQuestion): boolean {
  return question.utilitySuggestion !== undefined
}

/** Whether the user's answer to a suggestion question means "install it". */
export function isUtilitySuggestionAccepted(answers: readonly string[]): boolean {
  return answers.includes(UTILITY_SUGGESTION_INSTALL_ANSWER)
}
