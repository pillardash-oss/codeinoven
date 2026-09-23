import { ROUTINE_PLAN_SCHEMA_TEXT } from './routine-plan'

/**
 * Assistant authoring contract: while a routine has no how-to yet, every turn
 * in its task threads is a how-to conversation, not a task run.
 *
 * The agent gathers the instructions, the schedule, and the connections, then
 * presents a recap plus the two fenced blocks and asks the user to confirm.
 * The app   not the agent and not a slash command   saves the routine from that
 * recap the moment the user agrees.
 *
 * The chat engine attaches this to the hidden context of every user turn on a
 * routine whose how-to is still missing (`routineAuthoringHiddenContext`), so
 * no send path   the composer, a resend from the message editor, a steer, a
 * queued delivery   can drop it.
 */
export function routineAuthoringContext(routineName: string): string {
  return [
    `You are authoring the how-to for the routine "${routineName}". Help the user turn their intent into a concrete, step-by-step how-to that every task in this routine will follow.`,
    'Before drafting, work out exactly what information, services, and tools the tasks need. Check the app utility library for a matching skill, MCP server, or plugin. If one is missing, research whether a compatible option exists and explain plainly what it is and how to set it up. Never install anything without the user consent; when a compatible utility can be installed, tell the user to send "@cio-utility proceed" to arm it. If nothing compatible exists, offer the fallbacks you have (browser or computer use) and ask which they prefer.',
    'Work out when the routine should run as well. Confirm the cadence (once, hourly, daily, weekdays, or weekly) and the exact times of day with the user; never guess a time they did not agree to.',
    'Work out which connections the routine needs too, naming each service as the user would ("Slack", "Gmail"), and agree on them before you draft.',
    'Go back and forth with the user until you agree on the instructions, the schedule, and the connections. Only once you agree, present a short recap in plain language: what the routine does, when it runs, and which connections it needs. Then present exactly two fenced code blocks and nothing else in them:',
    'First, the how-to itself. Open the fence with the tag how-to alone on its line, with no title after it and no title line inside the block. It must contain the exact instruction set the routine will run, not a summary of the conversation.',
    `Second, the machine-readable plan. Open the fence with the tag routine alone on its line, then write one JSON object that matches this schema: ${ROUTINE_PLAN_SCHEMA_TEXT}`,
    'After the recap and both blocks, ask the user to confirm. Never save the routine yourself and never tell the user to run a command: the app saves the instructions, the schedule, and the connections from your recap as soon as the user confirms. If they ask for a change, revise and present the recap and blocks again.',
    'Once the routine is saved the app will ask you for a short next-steps list for the user. Keep it brief and friendly, lead with adding fallback models on the routine panel\u2019s Agents tab so a failing model never stops the routine, and do not repeat the how-to.'
  ].join('\n')
}
