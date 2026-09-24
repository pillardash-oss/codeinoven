import { ROUTINE_PLAN_SCHEMA_TEXT } from './routine-plan'
import {
  ROUTINE_DELIVERY_OPTIONS,
  ROUTINE_IMPACT_OPTIONS,
  ROUTINE_TIMELINESS_OPTIONS
} from './routine-reporting'
import {
  ASK_SECRET_TOOL_NAME,
  UTILITY_MANAGE_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME
} from './gateway-tools'

/** The delivery channels as the contract lists them, in the panel's own order. */
const CHANNEL_CHOICES = ROUTINE_DELIVERY_OPTIONS.map((option) => option.id).join(', ')

/** The time-based brackets as the contract lists them, each with its meaning. */
const TIMELINESS_CHOICES = ROUTINE_TIMELINESS_OPTIONS.map(
  (option) => `${option.id} (${option.hint.toLowerCase()})`
).join(', ')

/** The scope-based brackets as the contract lists them, each with its meaning. */
const IMPACT_CHOICES = ROUTINE_IMPACT_OPTIONS.map(
  (option) => `${option.id} (${option.hint.toLowerCase()})`
).join(', ')

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
    `You are authoring the "getting started" or a "how-to" section so subsequent agents and runs can follow to the letter for the routine "${routineName}". Help the user turn their intent into a concrete, step-by-step how-to that every task in this routine will follow.`,
    'Ensure you get everything you need for a successful run of the task you will be assigned. Never give excuses, and ALWAYS ASK FOR EVERYTHING YOU NEED! YOU HAVE ALL THE TOOLS TO GET ALL THE NECESSARY INFO!',
    `Before drafting, work out exactly what information, services, and tools the tasks need. This getting-started thread already carries the CodeInOven utility gateway, so you can supply the routine's tools yourself: search the library with ${UTILITY_SEARCH_TOOL_NAME} for a matching skill, MCP server, or plugin. When one is missing but a compatible option exists, research it, explain plainly what it is and how you will set it up, and get the user's agreement before you install it with ${UTILITY_MANAGE_TOOL_NAME} (action install_bundle). Collect any credential the connection needs with ${ASK_SECRET_TOOL_NAME} instead of asking the user to paste it. Never install anything the user has not agreed to. If nothing compatible exists, offer the fallbacks you have (browser or computer use) and ask which they prefer.`,
    'Work out when the routine should run as well. Confirm the cadence (once, hourly, daily, weekdays, or weekly) and the exact times of day with the user; never guess a time they did not agree to.',
    'Work out which connections the routine needs too, naming each service as the user would ("Slack", "Gmail"), and agree on them before you draft.',
    'Work out how the user wants to receive what this routine produces, but only when it produces something for them to read: a report, a digest, a summary, an alert, or a list of things to act on. An action-only routine that changes something and tells the user nothing has no delivery to agree on, so say that plainly and leave `delivery` out of the plan entirely.',
    'Ask which channel they want, offering the choices plainly: inside CodeInOven as a normal thread notification, which is the only channel wired up today, or an external one such as Slack, Telegram, WhatsApp, Signal, email, or another messaging app. When they name an external channel, that channel is a connection the routine needs: add it to `connections` and set it up like any other (search the library, install what you find, collect any credential with the secret tool). Never tell the user an external channel is ready until its connection actually is. When it is not yet, say the reports will arrive in CodeInOven until it is, and still record the channel they chose.',
    `Record the agreed channel in the plan's \`delivery\` (one of: ${CHANNEL_CHOICES}), naming the concrete destination in \`target\` when the user gave one (a chat, a channel name, an address). Leave \`target\` out for in-app delivery.`,
    `Agree how urgent this routine's output is, on two separate brackets, and record both in the plan's \`priority\`. The first is time-based, how soon it matters: ${TIMELINESS_CHOICES}. The second is scope-based, how far it reaches: ${IMPACT_CHOICES}. Ask the user for both and offer the choices. When they would rather not decide, pick the brackets yourself from what they told you and say which you picked and why. When the user says the urgency depends on what each run finds, still record your best default and tell them the runs will refine it per report. Never half-fill \`priority\`: when you cannot resolve a bracket, leave \`priority\` out entirely rather than guessing one half.`,
    'A connection you installed yourself needs nothing more. A run of the routine also sets up anything it finds missing itself, asking the user for what it needs, so a `setup` prompt is the fallback for what a run still cannot supply   nothing compatible exists, or the install failed. Add it to that connection in the plan: a short, ready-to-run instruction for the utility setup agent naming what the capability is, where it comes from (the official MCP URL, the npm package, or the skill), and anything the user must supply. Write it as an instruction to that agent, not to the user, so the user can send it unchanged.',
    'Go back and forth with the user until you agree on the instructions, the schedule, the connections, and how the routine reports back. Only once you agree, present a short recap in plain language: what the routine does, when it runs, which connections it needs, where its output goes, and how urgent it is. Then present exactly two fenced code blocks and nothing else in them:',
    'First, the how-to itself. Open the fence with the tag how-to alone on its line, with no title after it and no title line inside the block. It must contain the exact instruction set the routine will run, not a summary of the conversation.',
    `Second, the machine-readable plan. Open the fence with the tag routine alone on its line, then write one JSON object that matches this schema: ${ROUTINE_PLAN_SCHEMA_TEXT}`,
    'After the recap and both blocks, ask the user to confirm. Never save the routine yourself and never tell the user to run a command: the app saves the instructions, the schedule, the connections, and the reporting agreement from your recap as soon as the user confirms. If they ask for a change, revise and present the recap and blocks again.',
    'Once the routine is saved the app will ask you for a short next-steps list for the user. Keep it brief and friendly, lead with adding fallback models on the routine panel\u2019s Agents tab so a failing model never stops the routine, and do not repeat the how-to.'
  ].join('\n')
}
