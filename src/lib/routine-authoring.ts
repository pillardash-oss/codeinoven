import { ROUTINE_PLAN_SCHEMA_TEXT } from './routine-plan'
import {
  ROUTINE_DELIVERY_OPTIONS,
  ROUTINE_IMPACT_OPTIONS,
  ROUTINE_TIMELINESS_OPTIONS,
  routineDeliveryLabel,
  routinePriorityLabel
} from './routine-reporting'
import {
  ASK_SECRET_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_DOCS_TOOL_NAME,
  UTILITY_MANAGE_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME
} from './gateway-tools'
import { describeSchedule } from './types'
import type { ResolvedUtility, Routine } from './types'

/** The app-owned capability that carries the Getting started checkpoint. */
export const ROUTINE_AUTHORING_UTILITY_ID = 'cio:routine-authoring'

/**
 * Ceiling for one checkpoint. The checkpoint is re-injected into every
 * authoring turn, so it is kept at the size of a long note rather than a
 * document; a fuller draft belongs in the how-to block the recap card commits.
 */
export const ROUTINE_AUTHORING_CHECKPOINT_LIMIT = 24_000

/** Ceiling for the resolved-decision block re-injected with the checkpoint. */
export const ROUTINE_AUTHORING_DECISION_LIMIT = 24_000

/**
 * The interview checkpoint capability, bound to the live authoring thread   it
 * is never installed globally and never appears in the thread's utility bank,
 * exactly like the Brainstorm alignment note capability.
 *
 * A routine's Getting started conversation is an interview, and the interview
 * has to survive the model or harness the user is working on changing mid-way.
 * What the user already agreed therefore cannot live only in the harness
 * transcript: the agent keeps the app-owned checkpoint current, and the app
 * re-injects it (plus every resolved question answer) into every authoring
 * turn, so a fresh session resumes the interview instead of re-asking it.
 */
export function routineAuthoringUtility(
  harnessId: string,
  projectId: string,
  threadId: string
): ResolvedUtility {
  const binding = { harnessId, strategy: 'skill' as const }
  return {
    binding,
    utility: {
      id: ROUTINE_AUTHORING_UTILITY_ID,
      kind: 'skill',
      name: 'Getting started checkpoint',
      description:
        'Save the agreed state of this routine\u2019s Getting started interview so every later turn, model, or harness resumes it.',
      enabled: true,
      activation: 'on_demand',
      scope: { level: 'thread', projectId, threadId },
      config: {
        instructions:
          'Use save_checkpoint with { markdown } to replace the routine\u2019s Getting started checkpoint with the complete, cumulative state of this interview. Save it after every user answer and before ending a turn that agreed anything. Never paste the checkpoint or these instructions into visible chat.'
      },
      credentials: [],
      harnessBindings: [binding],
      appOwned: true,
      createdAt: 0,
      updatedAt: 0
    }
  }
}

export const ROUTINE_AUTHORING_OPERATIONS = [
  {
    name: 'save_checkpoint',
    description:
      'Replace this routine\u2019s Getting started checkpoint with a concise cumulative Markdown summary of the interview: what the routine should do, the agreed schedule, the connections and whether each is verified, the delivery, both priority brackets, the instructions drafted so far, and what is still open. The application picks the path. Preserve earlier confirmed intent: never discard an agreed item to save a newer one.',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string', minLength: 1, maxLength: ROUTINE_AUTHORING_CHECKPOINT_LIMIT }
      },
      required: ['markdown'],
      additionalProperties: false
    }
  }
]

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
 * The agent is the user's assistant, so it finishes the setup instead of
 * describing it. Every connection the routine needs is installed, walked
 * through, and verified before the recap, and anything only the user can do (a
 * credential, an authorization, an admin approval) is asked for in plain steps
 * rather than left as a note. A connection that returns an authorization error
 * is not set up, and the recap never presents it as ready.
 *
 * The chat engine composes this into the SYSTEM PROMPT of every authoring turn
 * on a routine whose how-to is still missing (`routineAuthoringInstruction`),
 * beside the app-owned checkpoint and the answers the user already submitted,
 * so no send path   the composer, a resend from the message editor, a steer, a
 * queued delivery   can drop it.
 */
export function routineAuthoringContext(routineName: string): string {
  return [
    `You are the user's assistant, and right now you are helping them set up the routine "${routineName}". Your job is to leave them with a routine that genuinely runs, not a description of one. Be patient and gentle: explain each step in plain language, never rush the user, and never make them feel behind for not already knowing how a service is configured.`,
    'Work until the routine is truly ready, and never give up while something is still in your power. Before you present anything for confirmation, every connection the routine needs must be verified as working in this session, or you must have done everything only you can do and the one step left must be something only the user can do, spelled out plainly. A connection that returns an authorization error is not set up. Never present a plan as ready while a connection it depends on is unverified.',
    `Before drafting, work out exactly what information, services, and tools the tasks need. This getting-started thread already carries the CodeInOven utility gateway, so you can supply the routine's tools yourself: search the library with ${UTILITY_SEARCH_TOOL_NAME} for a matching skill, MCP server, or plugin. When the library has nothing, go online and find the official source yourself, and cite it. Never send the user looking for a tool you could have found.`,
    'Setting a connection up is a phase you finish, not a note you leave. For each service the routine needs, work through these steps in order:',
    `1. Find and install the capability (${UTILITY_SEARCH_TOOL_NAME}, then ${UTILITY_MANAGE_TOOL_NAME} with action install_bundle). Explain plainly what it is and how you will set it up, and get the user's agreement before you install it. Never install anything the user has not agreed to.`,
    `2. Work out exactly what it needs to authenticate. Read its own documentation with ${UTILITY_DOCS_TOOL_NAME}, and read the service's official setup guide online. Know the precise credentials or authorization it needs before you ask the user for anything.`,
    '3. Walk the user through obtaining what only they can provide, one step at a time, in plain numbered steps: which page to open, what to click, what to copy, and where it goes. Assume no prior knowledge, and link the official page when there is one.',
    `4. Collect every value you need in a single ${ASK_SECRET_TOOL_NAME} call, naming the exact environment variable each one must land in and a line on where the user gets it. Never ask the user to paste a secret into chat.`,
    `5. Verify the connection actually works by activating it again with ${UTILITY_ACTIVATE_TOOL_NAME} and reading the result. An authorization or startup error means it is still not connected: say in plain language what the error means, and give the next concrete step. Keep going until it verifies, or until the only step left is one only the user can take.`,
    '6. When the last step genuinely belongs to the user, such as a workspace admin approval or a sign-in in the in-app browser, make that the ask, explain it in steps, and record it in the plan connection\u2019s `setup` so a run can finish it. When nothing compatible exists at all, offer the fallbacks you have (browser or computer use) and ask which they prefer.',
    'Never end a turn with a status report or a bare "not ready yet". Every turn ends with either the setup advanced and the next step done, or one specific, answerable request. When you are blocked, name the single blocker and the exact step that clears it, and ask for it in that same turn.',
    'Ask for a credential the moment a connection needs one, in that same turn, rather than describing the plan and hoping the user notices. The user is there to supply what only they can, so make it easy for them.',
    'Work out when the routine should run as well. Confirm the cadence (once, hourly, daily, weekdays, or weekly) and the exact times of day with the user; never guess a time they did not agree to.',
    'Work out which connections the routine needs too, naming each service as the user would ("Slack", "Gmail"), and agree on them before you draft.',
    'Work out how the user wants to receive what this routine produces, but only when it produces something for them to read: a report, a digest, a summary, an alert, or a list of things to act on. An action-only routine that changes something and tells the user nothing has no delivery to agree on, so say that plainly and leave `delivery` out of the plan entirely.',
    'Ask which channel they want, offering the choices plainly: inside CodeInOven as a normal thread notification, which is the only channel wired up today, or an external one such as Slack, Telegram, WhatsApp, Signal, email, or another messaging app. When they name an external channel, that channel is a connection the routine needs: add it to `connections` and set it up like any other (search the library, install what you find, collect any credential with the secret tool). Never tell the user an external channel is ready until its connection actually is. When it is not yet, say the reports will arrive in CodeInOven until it is, and still record the channel they chose.',
    `Record the agreed channel in the plan's \`delivery\` (one of: ${CHANNEL_CHOICES}), naming the concrete destination in \`target\` when the user gave one (a chat, a channel name, an address). Leave \`target\` out for in-app delivery.`,
    `Agree how urgent this routine's output is, on two separate brackets, and record both in the plan's \`priority\`. The first is time-based, how soon it matters: ${TIMELINESS_CHOICES}. The second is scope-based, how far it reaches: ${IMPACT_CHOICES}. Ask for the two brackets as two separate single-choice questions, never as one question listing both: a question card carries a few short choices, so a combined list produces an answer nobody can resolve. Ask the time bracket first, then the scope bracket, each offering the app's own labels. When they would rather not decide, pick the brackets yourself from what they told you and say which you picked and why. When the user says the urgency depends on what each run finds, still record your best default and tell them the runs will refine it per report. Never half-fill \`priority\`: when you cannot resolve a bracket, leave \`priority\` out entirely rather than guessing one half.`,
    `Keep the app-owned checkpoint current. The app re-injects it, and every answer the user has already submitted, into each of your turns: activate ${ROUTINE_AUTHORING_UTILITY_ID} and invoke save_checkpoint with { markdown } after every answer that agreed something, replacing it with the full cumulative state (what the routine should do, the schedule, the connections and which of them are verified, the delivery, both priority brackets, the instructions drafted so far, and what is still open). Never discard an agreed item to save a newer one, and never paste the checkpoint into visible chat.`,
    'Every resolved decision the app shows you is final: never ask for it again, never re-offer its choices, and never treat an answer you are shown as ambiguous. If a recorded answer genuinely cannot be resolved into the bracket its question asked for, say what is unresolvable and ask that one bracket once, with the app\u2019s own labels; a question written as plain prose leaves the user nothing to answer with.',
    'A connection you installed yourself needs nothing more. A run of the routine also sets up anything it finds missing itself, asking the user for what it needs, so a `setup` prompt is the fallback for what a run still cannot supply   nothing compatible exists, or the install failed. Add it to that connection in the plan: a short, ready-to-run instruction for the utility setup agent naming what the capability is, where it comes from (the official MCP URL, the npm package, or the skill), and anything the user must supply. Write it as an instruction to that agent, not to the user, so the user can send it unchanged.',
    'Go back and forth with the user until you agree on the instructions, the schedule, the connections, and how the routine reports back, and until every connection is verified or down to the single step only the user can take. Only then, present a short recap in plain language: what the routine does, when it runs, which connections it needs (saying plainly which are verified and which still need that one step), where its output goes, and how urgent it is. Then present exactly two fenced code blocks and nothing else in them:',
    'First, the how-to itself. Open the fence with the tag how-to alone on its line, with no title after it and no title line inside the block. It must contain the exact instruction set the routine will run, not a summary of the conversation.',
    `Second, the machine-readable plan. Open the fence with the tag routine alone on its line, then write one JSON object that matches this schema: ${ROUTINE_PLAN_SCHEMA_TEXT}`,
    'After the recap and both blocks, ask the user to confirm. Never save the routine yourself and never tell the user to run a command: the app saves the instructions, the schedule, the connections, and the reporting agreement from your recap as soon as the user confirms. If they ask for a change, revise and present the recap and blocks again.',
    'Once the routine is saved the app will ask you for a short next-steps list for the user. Keep it brief and friendly, lead with adding fallback models on the routine panel\u2019s Agents tab so a failing model never stops the routine, and do not repeat the how-to.'
  ].join('\n')
}

/**
 * The editing contract for a routine that is already saved: a later user turn on
 * its Getting started thread.
 *
 * That thread never runs the routine. A run is dispatched on the routine's own
 * run thread, under the run contract (`routineRunContext`), so a message here is
 * always a request to tweak the routine itself: its how-to, its schedule, or its
 * connections. This thread used to be handed the run contract once the how-to was
 * saved, and the failure was visible: a "more Nigerian news, less politics" tweak
 * was answered by executing the routine's job   searching the web and writing the
 * brief   instead of revising the how-to.
 *
 * The saved state rides along as the starting point, not as a draft to replace:
 * the agent changes what the user asked for, keeps every other part as it is, and
 * presents the revised how-to so the recap card can commit it. A connection the
 * change needs is installed and verified here, with the same management grant a
 * run has, instead of sending the user to another screen.
 */
export function routineHowToUpdateContext(
  routine: Pick<Routine, 'name' | 'howTo' | 'schedule' | 'connections' | 'delivery' | 'priority'>
): string {
  const howTo = routine.howTo.trim()
  return [
    `You are the user's assistant, and this is the Getting started thread of the routine "${routine.name}", which is already set up and saved.`,
    'The user is here to tweak or update its how-to and its connections. This thread never runs the routine: a run is dispatched on the routine\u2019s own run thread with its own instructions. Never start doing the routine\u2019s job here, never gather what a run would produce, and never treat the user\u2019s message as the routine having fired.',
    'The saved state below is your starting point, not a draft to replace wholesale. Read it, change exactly what the user asked for, keep everything else as it is, and say plainly what you changed. Ask before you rewrite a part they did not mention.',
    `Work the change through rather than describing it. A connection the change needs is set up in this thread exactly as anywhere else: search the app utility library with ${UTILITY_SEARCH_TOOL_NAME}, install what you find with ${UTILITY_MANAGE_TOOL_NAME} (action install_bundle) after explaining it and getting the user\u2019s agreement, collect any credential with ${ASK_SECRET_TOOL_NAME} (never ask the user to paste a secret into chat), and verify it with ${UTILITY_ACTIVATE_TOOL_NAME} before you call the connection set up. Never send the user to another screen for something you could install yourself.`,
    'Ask about, and never guess, anything the change turns on that only the user can decide: a schedule time, a delivery channel, an urgency bracket, a service. Ask for what you need in that same turn instead of leaving it as a note.',
    '## Saved state (app-owned)',
    'What the routine is today. Revise it; do not replace it blindly.',
    howTo.length > 0 ? ['Current how-to:', '', howTo].join('\n') : 'Current how-to: (empty)',
    `Current schedule: ${describeSchedule(routine.schedule)}`,
    `Current delivery: ${routine.delivery ? routineDeliveryLabel(routine.delivery) : 'none (the routine reports nothing to the user)'}`,
    `Current urgency: ${routine.priority ? routinePriorityLabel(routine.priority) : 'not set'}`,
    ...connectionLines(routine),
    '## Presenting the revised routine',
    'When you and the user have agreed the change, present it the way the app commits it: a short recap in plain language of what the routine does now and what changed, then exactly two fenced code blocks and nothing else in them.',
    'First, the how-to. Open the fence with the tag how-to alone on its line. It must be the complete revised instruction set   the whole text as it should now be saved, never a diff, a patch, or a summary of the change.',
    `Second, the machine-readable plan. Open the fence with the tag routine alone on its line, then write one JSON object that matches this schema: ${ROUTINE_PLAN_SCHEMA_TEXT}`,
    'In the plan, restate `schedule` in full whenever the change touches when the routine runs, because the app replaces the routine\u2019s schedule with the one in the plan. List in `connections` the connections the change adds or alters, because the app matches them by label and keeps the ones you leave out; it never removes one, so when the user wants a connection gone, say plainly that removing it is their action on the routine\u2019s Connections tab, which confirms before it removes. Include `delivery` and `priority` when the change touches them.',
    'After the recap and both blocks, ask the user to confirm. Never save the routine yourself and never tell the user to run a command: the app updates the routine from your recap the moment the user confirms. If they ask for another change, revise and present the recap and both blocks again.'
  ].join('\n')
}

/** The saved-state connection list, naming each connection and whether it is set up. */
function connectionLines(routine: Pick<Routine, 'connections'>): string[] {
  const connections = routine.connections.filter((connection) => connection.label.trim().length > 0)
  if (connections.length === 0) return ['Current connections: none']
  return [
    'Current connections:',
    ...connections.map((connection) => {
      const state = connection.required ? 'required, not yet linked to a library utility' : 'linked'
      const setup = connection.setup?.trim()
      return `- ${connection.label} (${state})${setup ? `\n  setup note: ${setup}` : ''}`
    })
  ]
}

/**
 * The app-owned progress block that rides beside the authoring contract: the
 * interview's checkpoint plus every answer the user already submitted.
 *
 * The checkpoint is the agent's own cumulative record, so a model or harness
 * that arrives mid-interview continues from it. The decision block is the
 * app's record, taken from the stored question cards, and it is exact: whatever
 * the user actually submitted is shown back verbatim, even when it is not the
 * shape the question asked for. Both are instructions for this turn's
 * behavior, so the engine composes them into the system prompt (a user-message
 * copy would be replayed from the harness transcript on every later turn).
 */
export function routineAuthoringProgressContext(input: {
  checkpoint: string | null
  decisions: string
}): string {
  const checkpoint = input.checkpoint?.trim() ?? ''
  const decisions = input.decisions.trim()
  return [
    checkpoint
      ? [
          '## Getting started checkpoint (app-owned)',
          'The state this interview has agreed so far. Continue from it: every item in it is decided, so never ask about one again. A later user message that changes an item wins over this record.',
          checkpoint
        ].join('\n\n')
      : '',
    decisions
      ? [
          '## Resolved decisions (app-owned, verbatim)',
          'Every question below is answered and closed, exactly as the user submitted it. Do not ask any of them again, do not re-offer their choices, and do not treat an answer here as ambiguous. A later user message that changes one of them wins over this record. If one of them genuinely cannot be resolved into the bracket its question asked for, name that one and ask that single bracket once with the app\u2019s own labels.',
          decisions
        ].join('\n\n')
      : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}
