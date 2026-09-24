import { CIO_ASK_USER_TOOL_NAME } from './core-tools'
import { formatDateTime } from './date-time-format'
import {
  isExternalDeliveryChannel,
  routineDeliveryChannelLabel,
  routinePriorityLabel,
  ROUTINE_IMPACT_IDS,
  ROUTINE_TIMELINESS_IDS
} from './routine-reporting'
import {
  ASK_SECRET_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_MANAGE_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME
} from './gateway-tools'
import type { Routine } from './types'

/**
 * The row title of one run thread: the time it started. A run is listed under
 * its task, so its own title only has to name the execution, never repeat the
 * task's name.
 */
export function assistantRunTitle(at: number): string {
  return `Run · ${formatDateTime(at)}`
}

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
 * The self-provisioning and reporting contract for a turn on an assistant task
 * whose routine already has its how-to   a real run (scheduled or "Run now"),
 * or a follow-up on that same task thread.
 *
 * The how-to is the instruction set. This contract covers the two things the
 * how-to cannot: where the run's output goes and how urgent it is, and a
 * connection the routine needs that is not set up in this session.
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
export function routineRunContext(
  routine: Pick<Routine, 'name' | 'connections' | 'delivery' | 'priority'>
): string {
  const lines = [
    `This thread runs the routine "${routine.name}". Its how-to is your instruction set; follow it exactly.`,
    ...reportingLines(routine),
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

/**
 * The reporting lines a run carries: where its output goes, and how to label its
 * urgency.
 *
 * A routine whose output the user reads has to say so, or the run finishes with
 * the report buried in a transcript nobody opened. Delivery is the agreed
 * channel; when it is not in-app the run supplies that channel's connection
 * itself, exactly as it does for any other connection, and only falls back to
 * saying so in the thread when the channel genuinely cannot be reached.
 *
 * Priority is emitted even without a delivery, because the agreed bracket still
 * tells the run how hard to push on what it finds. With no agreed bracket and a
 * report to write, the run decides both brackets from what it actually found.
 */
function reportingLines(routine: Pick<Routine, 'delivery' | 'priority'>): string[] {
  const lines: string[] = []
  const delivery = routine.delivery

  if (delivery) {
    if (isExternalDeliveryChannel(delivery.channel)) {
      const channel = routineDeliveryChannelLabel(delivery.channel)
      const target = delivery.target?.trim()
      lines.push(
        `Deliver this routine's output to ${channel}${target ? ` (${target})` : ''} through that connection. When the connection is not available in this session, supply it yourself as described below instead of dropping the report, and only when it genuinely cannot be reached say so in this thread so the output is never lost.`
      )
    } else {
      lines.push(
        `Deliver this routine's output as the report itself, in this thread: write it so it stands on its own, lead with what needs the user's attention, and keep it tight. The app surfaces the thread in the notification panel's Assistants tab, so do not send it anywhere else.`
      )
    }
    if (delivery.note) lines.push(`Delivery note from the agreement: ${delivery.note}`)
  }

  const priority = routine.priority
  if (priority) {
    lines.push(
      `The agreed urgency for this routine is ${routinePriorityLabel(priority)}. Label the report with the bracket it actually falls in, and move it when what you found is more or less urgent than the agreed default. Time-based brackets (how soon it matters): ${ROUTINE_TIMELINESS_IDS.join(', ')}. Scope-based brackets (how far it reaches): ${ROUTINE_IMPACT_IDS.join(', ')}. State both brackets and one line of why.`
    )
  } else if (delivery) {
    lines.push(
      `Label the report with its urgency on two brackets, decided from what you actually found rather than assumed. Time-based (how soon it matters): ${ROUTINE_TIMELINESS_IDS.join(', ')}. Scope-based (how far it reaches): ${ROUTINE_IMPACT_IDS.join(', ')}. State both brackets and one line of why.`
    )
  }

  return lines
}
