/**
 * Contract for the app-owned MCP sign-in card.
 *
 * A remote MCP server that accepts neither anonymous nor API-key requests
 * answers with an OAuth challenge instead of a tool result. That refusal is not
 * something the agent can fix and not something the user should have to read off
 * a trace: the app turns it into a card that names the server, explains what it
 * wants, and signs the user in through the browser. The grant lands in the
 * encrypted vault, so the same server never asks again on another thread or in
 * another project, and the agent's own tool call resumes once the sign-in lands.
 *
 * The card is a pending question in the app's own vocabulary so it rides the
 * same surface as `cio_ask_secret` and the capability suggestion: registered by
 * the engine, broadcast to the renderer, settled by the user. Nothing about the
 * server is installed or changed by the answer, only its authorization.
 */

import type { AgentMcpSignInTarget, AgentQuestion } from './types'

/**
 * Answer the card submits after a sign-in that really finished.
 *
 * The card authorizes through the same main-process flow the Utilities page
 * uses, so this text is a report rather than the grant: the engine verifies the
 * grant itself when it retries the connection.
 */
export const MCP_SIGN_IN_COMPLETED_ANSWER = 'Signed in'

/** Answer the card submits when the user declines, and what an expired card settles as. */
export const MCP_SIGN_IN_DECLINED_ANSWER = 'Not now'

/** What the user did about one server's authorization request. */
export type AgentMcpSignInResolution = { status: 'signed_in' } | { status: 'declined' }

/** Whether accepting this card makes the server usable everywhere in the app. */
export function mcpSignInGrantIsGlobal(target: AgentMcpSignInTarget): boolean {
  return target.grantScope === 'global'
}

/**
 * The reach of the grant in the user's own words.
 *
 * The answer matters to the decision: a global server is one sign-in for the
 * whole app, while a project- or thread-scoped server is one sign-in for the work
 * in front of the user, and a card that promised "everywhere" for the latter
 * would be lying.
 */
export function mcpSignInGrantSentence(target: AgentMcpSignInTarget): string {
  switch (target.grantScope) {
    case 'global':
      return 'The grant is stored in your encrypted vault, so this server stays signed in on every thread and in every project.'
    case 'project':
      return 'The grant is stored in your encrypted vault for this project only, because this server is installed for it.'
    case 'thread':
      return 'The grant is stored in your encrypted vault for this thread only, because this server is installed for it.'
  }
}

/**
 * The question the sign-in card renders.
 *
 * It carries no options: a sign-in is one action with one refusal, and the two
 * are the card's own controls so progress, cancellation and errors can live
 * beside them. The dashboard switches to the dedicated card on `mcpSignIn`, so
 * the prompt is the card's body rather than a question with answers.
 */
export function mcpSignInQuestion(target: AgentMcpSignInTarget): AgentQuestion {
  const endpoint = target.endpoint?.trim()
  const lines = [
    target.reason?.trim() ||
      'This MCP server refused the request and asked the app to authorize it first.',
    '',
    'Signing in opens the authorization page in your browser and keeps the result only on this device.'
  ]
  lines.push(mcpSignInGrantSentence(target))
  if (endpoint) lines.push('', `**Server**`, `\`${endpoint}\``)
  return {
    prompt: `Sign in to ${target.name}`,
    header: 'MCP authorization',
    description: lines.join('\n'),
    custom: false,
    mcpSignIn: target
  }
}

/** Whether one pending question is an MCP server asking to be signed in. */
export function isMcpSignInQuestion(question: AgentQuestion): boolean {
  return question.mcpSignIn !== undefined
}

/**
 * Read the card's answer.
 *
 * Only the completion answer counts as a sign-in: a card that expired, was
 * dismissed, or answered with anything else settles as a decline, so a silently
 * abandoned card can never be reported to the agent as authorized.
 */
export function mcpSignInResolution(
  answers: readonly (readonly string[])[] | undefined
): AgentMcpSignInResolution {
  const submitted = (answers ?? []).flat().map((value) => value.trim())
  return submitted.includes(MCP_SIGN_IN_COMPLETED_ANSWER)
    ? { status: 'signed_in' }
    : { status: 'declined' }
}
