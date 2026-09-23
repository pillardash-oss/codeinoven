import { CIO_ASK_USER_TOOL_NAME } from './core-tools'
import {
  ASK_SECRET_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_MANAGE_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME
} from './gateway-tools'
import type { Routine } from './types'

/**
 * The one system-prompt layer for a task that runs a routine: the routine's
 * how-to first, then the self-provisioning contract that refers to it.
 *
 * The order matters. The contract opens by calling the how-to its instruction
 * set, so the how-to has to precede it in the prompt.
 */
export function composeRoutineInstruction(
  howTo: string | undefined,
  contract: string | undefined
): string | undefined {
  const parts = [howTo?.trim(), contract?.trim()].filter(
    (part): part is string => part !== undefined && part.length > 0
  )
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/**
 * The self-provisioning contract for a turn on an assistant task whose routine
 * already has its how-to   a real run (scheduled or "Run now"), or a follow-up
 * on that same task thread.
 *
 * The how-to is the instruction set. This contract covers the one thing the
 * how-to cannot: a connection the routine needs is not set up in this session.
 * The agent is the user's assistant, so it sets that connection up itself with
 * the utility gateway   searching the app library, going online to find the
 * official source when the library has nothing, installing what it finds, and
 * asking the user for whatever only the user can supply. Pointing the user at
 * the Connections tab is the last resort, not the answer.
 *
 * The chat engine attaches this to the hidden context of every assistant task
 * turn (`routineRunHiddenContext`), so the behavior is a property of the thread
 * and not of one send path.
 */
export function routineRunContext(routine: Pick<Routine, 'name' | 'connections'>): string {
  const lines = [
    `This thread runs the routine "${routine.name}". Its how-to is your instruction set; follow it exactly.`,
    `Everything the routine needs should already be connected. Verify each connection the how-to relies on is actually available in this session before you use it. When one is missing, do not stop and do not send the user to another screen: as the user's assistant, supply it yourself.`,
    `How to supply a missing connection, in order:`,
    `1. Search the app utility library with ${UTILITY_SEARCH_TOOL_NAME} for a matching skill, MCP server, or plugin.`,
    `2. When the library has nothing, go online and find the official source yourself: use your own web tools when you have them, otherwise find a web/search capability in the library with ${UTILITY_SEARCH_TOOL_NAME} and activate it with ${UTILITY_ACTIVATE_TOOL_NAME}. Look up the official MCP endpoint, package, or install instructions and cite the source you used.`,
    `3. Install what you found with ${UTILITY_MANAGE_TOOL_NAME} (action install_bundle) after explaining plainly what it is and how you will set it up. Definitions must stay secret-free.`,
    `4. Collect any credential (API key, token, password) with ${ASK_SECRET_TOOL_NAME}   pass the installed id as utility_id and the variable the server expects as environment_variable. Never ask the user to paste a secret into chat.`,
    `5. Ask the user for any other choice or detail you need with ${CIO_ASK_USER_TOOL_NAME}; the user is here to supply it.`,
    'Only when you genuinely cannot install it yourself should you tell the user which connection is missing and that they can set it up from the routine\u2019s Connections tab. Never end a turn by telling the user to connect something you could have installed.'
  ]

  const connections = routine.connections.filter((connection) => connection.label.trim().length > 0)
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
