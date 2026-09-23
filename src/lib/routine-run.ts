import { CIO_ASK_USER_TOOL_NAME } from './core-tools'
import {
  ASK_SECRET_TOOL_NAME,
  UTILITY_MANAGE_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME
} from './gateway-tools'
import type { Routine } from './types'

/**
 * The self-provisioning contract for a turn on an assistant task whose routine
 * already has its how-to   a real run (scheduled or "Run now"), or a follow-up
 * on that task.
 *
 * The how-to is the instruction set. This contract covers the one thing the
 * how-to cannot: a connection the routine needs is not set up in this session.
 * The agent running the routine is the user's assistant, so it sets that
 * connection up itself with the utility gateway and asks the user for whatever
 * only the user can supply. Pointing the user at the Connections tab is the
 * last resort, not the answer.
 *
 * The chat engine attaches this to the hidden context of every assistant run
 * (`routineRunHiddenContext`), so the behavior is a property of the thread and
 * not of one send path.
 */
export function routineRunContext(routine: Pick<Routine, 'name' | 'connections'>): string {
  const lines = [
    `You are running the routine "${routine.name}". The how-to above is your instruction set; follow it exactly.`,
    `Everything the routine needs should already be connected. When something it needs is not available in this session, do not stop and do not send the user to another screen: set it up yourself. Search the app utility library with ${UTILITY_SEARCH_TOOL_NAME}, research the official source when you must, explain plainly what it is and how you will set it up, then install it with ${UTILITY_MANAGE_TOOL_NAME} (action install_bundle). Collect any credential with ${ASK_SECRET_TOOL_NAME} instead of asking the user to paste it. Use ${CIO_ASK_USER_TOOL_NAME} for any other choice or detail you need; the user is here to supply it.`,
    'Only when you genuinely cannot install it yourself should you tell the user which connection is missing and that they can set it up from the routine\u2019s Connections tab. Never end a run by telling the user to connect something you could have installed.'
  ]

  const connections = routine.connections.filter(
    (connection) => connection.label.trim().length > 0
  )
  if (connections.length > 0) {
    lines.push('Connections this routine records (verify each is available before you rely on it):')
    for (const connection of connections) {
      const setup = connection.setup?.trim()
      const note = connection.required ? ' (required, not yet linked to a library utility)' : ''
      lines.push(`- ${connection.label}${note}${setup ? `\n  setup note: ${setup}` : ''}`)
    }
  }

  return lines.join('\n')
}
