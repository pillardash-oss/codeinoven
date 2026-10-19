import { ASSISTANT_PLAN_SCHEMA_TEXT } from './assistant-plan'
import {
  ASSISTANT_DELIVERY_OPTIONS,
  ASSISTANT_IMPACT_OPTIONS,
  ASSISTANT_TIMELINESS_OPTIONS,
  ASSISTANT_DELIVERY_JSON_SCHEMA,
  ASSISTANT_PRIORITY_JSON_SCHEMA,
  assistantDeliveryLabel,
  assistantPriorityLabel
} from './assistant-reporting'
import {
  ASK_SECRET_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_DOCS_TOOL_NAME,
  UTILITY_MANAGE_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME
} from './gateway-tools'
import {
  ASSISTANT_NAME_LIMIT,
  ASSISTANT_PERSONALITY_LIMIT,
  assistantIsScheduled,
  assistantIsUnnamed,
  describeSchedule
} from './types'
import type { ResolvedUtility, Assistant } from './types'

/** The app-owned capability that carries the Getting started checkpoint. */
export const ASSISTANT_AUTHORING_UTILITY_ID = 'cio:assistant-authoring'

/**
 * Ceiling for one checkpoint. The checkpoint is re-injected into every
 * authoring turn, so it is kept at the size of a long note rather than a
 * document; a fuller draft belongs in the knowledge block the recap card commits.
 */
export const ASSISTANT_AUTHORING_CHECKPOINT_LIMIT = 24_000

/** Ceiling for the resolved-decision block re-injected with the checkpoint. */
export const ASSISTANT_AUTHORING_DECISION_LIMIT = 24_000

/**
 * The interview checkpoint capability, bound to the live authoring thread   it
 * is never installed globally and never appears in the thread's utility bank,
 * exactly like the Brainstorm alignment note capability.
 *
 * An assistant's Getting started conversation is an interview, and the interview
 * has to survive the model or harness the user is working on changing mid-way.
 * What the user already agreed therefore cannot live only in the harness
 * transcript: the agent keeps the app-owned checkpoint current, and the app
 * re-injects it (plus every resolved question answer) into every authoring
 * turn, so a fresh session resumes the interview instead of re-asking it.
 */
export function assistantAuthoringUtility(
  harnessId: string,
  projectId: string,
  threadId: string
): ResolvedUtility {
  const binding = { harnessId, strategy: 'skill' as const }
  return {
    binding,
    utility: {
      id: ASSISTANT_AUTHORING_UTILITY_ID,
      kind: 'skill',
      name: 'Getting started checkpoint',
      description:
        'Save the agreed state of this assistant\u2019s Getting started interview so every later turn, model, or harness resumes it.',
      enabled: true,
      activation: 'on_demand',
      scope: { level: 'thread', projectId, threadId },
      config: {
        instructions:
          'Use save_checkpoint with { markdown } to replace the assistant\u2019s Getting started checkpoint with the complete, cumulative state of this interview. Save it after every user answer and before ending a turn that agreed anything. Use save_schedule with { scheduled } as soon as the user decides whether to run on a clock, including scheduled: false for on-demand work. Use save_reporting with { delivery?, priority? } as soon as those decisions are settled, so they appear in the panel immediately. Never paste the checkpoint or these instructions into visible chat. Use save_identity with { name } (and { personality } once they have described it) the moment the user names the assistant or tells you how to behave, so the application renames it there and then instead of waiting for the end of the interview.'
      },
      credentials: [],
      harnessBindings: [binding],
      appOwned: true,
      createdAt: 0,
      updatedAt: 0
    }
  }
}

export type AssistantReportingPatch = Partial<Pick<Assistant, 'delivery' | 'priority'>>

export const ASSISTANT_AUTHORING_OPERATIONS = [
  {
    name: 'save_schedule',
    description:
      'Save whether this assistant runs on a schedule as soon as the user decides. Set scheduled to false when it should work only when asked. Turning scheduling off clears its clock and preserves all other assistant settings. Preserve the decision in the final plan.',
    inputSchema: {
      type: 'object',
      properties: { scheduled: { type: 'boolean' } },
      required: ['scheduled'],
      additionalProperties: false
    }
  },
  {
    name: 'save_reporting',
    description:
      'Save agreed delivery and urgency immediately so the assistant panel reflects the user answers during setup. Send delivery when settled and priority once both brackets are settled. Omitted fields are preserved. This does not save knowledge or declare connections ready.',
    inputSchema: {
      type: 'object',
      properties: {
        delivery: ASSISTANT_DELIVERY_JSON_SCHEMA,
        priority: ASSISTANT_PRIORITY_JSON_SCHEMA
      },
      anyOf: [{ required: ['delivery'] }, { required: ['priority'] }],
      additionalProperties: false
    }
  },
  {
    name: 'save_checkpoint',
    description:
      'Replace this assistant\u2019s Getting started checkpoint with a concise cumulative Markdown summary of the interview: what the assistant should do, the agreed schedule, the connections and whether each is verified, the delivery, both priority brackets, the instructions drafted so far, and what is still open. The application picks the path. Preserve earlier confirmed intent: never discard an agreed item to save a newer one.',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string', minLength: 1, maxLength: ASSISTANT_AUTHORING_CHECKPOINT_LIMIT }
      },
      required: ['markdown'],
      additionalProperties: false
    }
  },
  {
    name: 'save_identity',
    description:
      'Record who this assistant is, the moment the user settles it: the name they gave it and, once they have described it, how they want it to behave. The application writes them onto the assistant straight away and every surface renames itself, so call this in the same turn the answer arrives, before you write your confirmation, rather than waiting for the end of the interview. Send only the fields the user has settled.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: ASSISTANT_NAME_LIMIT,
          description: 'The name the user gave the assistant, verbatim.'
        },
        personality: {
          type: 'string',
          minLength: 1,
          maxLength: ASSISTANT_PERSONALITY_LIMIT,
          description: 'How the user asked the assistant to behave, in their own words.'
        }
      },
      additionalProperties: false,
      anyOf: [{ required: ['name'] }, { required: ['personality'] }]
    }
  }
]

/** The delivery channels as the contract lists them, in the panel's own order. */
const CHANNEL_CHOICES = ASSISTANT_DELIVERY_OPTIONS.map((option) => option.id).join(', ')

/** The time-based brackets as the contract lists them, each with its meaning. */
const TIMELINESS_CHOICES = ASSISTANT_TIMELINESS_OPTIONS.map(
  (option) => `${option.id} (${option.hint.toLowerCase()})`
).join(', ')

/** The scope-based brackets as the contract lists them, each with its meaning. */
const IMPACT_CHOICES = ASSISTANT_IMPACT_OPTIONS.map(
  (option) => `${option.id} (${option.hint.toLowerCase()})`
).join(', ')

/**
 * Assistant authoring contract: while an assistant has no knowledge yet, every turn
 * in its task threads is a knowledge conversation, not a task run.
 *
 * The agent gathers the instructions, the schedule, and the connections, then
 * presents a recap plus the two fenced blocks and asks the user to confirm.
 * The app   not the agent and not a slash command   saves the assistant from that
 * recap the moment the user agrees.
 *
 * The agent is the user's assistant, so it finishes the setup instead of
 * describing it. Every connection the assistant needs is installed, walked
 * through, and verified before the recap, and anything only the user can do (a
 * credential, an authorization, an admin approval) is asked for in plain steps
 * rather than left as a note. A connection that returns an authorization error
 * is not set up, and the recap never presents it as ready.
 *
 * The chat engine composes this into the SYSTEM PROMPT of every authoring turn
 * on an assistant whose knowledge is still missing (`assistantAuthoringInstruction`),
 * beside the app-owned checkpoint and the answers the user already submitted,
 * so no send path   the composer, a resend from the message editor, a steer, a
 * queued delivery   can drop it.
 */
export function assistantAuthoringContext(
  assistant: Pick<Assistant, 'name' | 'scheduled' | 'personality' | 'scheduleName'>
): string {
  const scheduled = assistantIsScheduled(assistant)
  // A conversation can name the assistant, so the placeholder the create flow had
  // to store is not a name the user chose. The first question is the name, and
  // nothing before it may present that placeholder as their choice.
  const unnamed = assistantIsUnnamed(assistant)
  const assistantName = assistant.name.trim()
  const scheduleName = assistant.scheduleName?.trim()
  /**
   * What the assistant is called while the conversation runs. Before the user
   * names it, the contract names the role rather than the placeholder.
   */
  const identity = unnamed
    ? 'You are the assistant the user is making right now, and they have not named you yet'
    : `You are ${assistantName}, the user's assistant`
  const personality = assistant.personality?.trim() ?? ''
  /**
   * Whether the identity is already the user's own words, so the interview must
   * not ask for it again. A form-created assistant arrives with both, and a
   * conversation settles them the moment it names the assistant and describes how
   * it should behave.
   */
  const identitySettled = !unnamed && personality.length > 0
  /**
   * The clock, settled in the conversation rather than assumed from the flag.
   *
   * An assistant created with the switch off was already told to run only when
   * the user asks, so asking again would contradict the choice they just made. An
   * assistant on the clock confirms it with them, and either answer is recorded in
   * the plan so the app saves the assistant the user actually agreed to.
   */
  const clockGuidance = scheduled
    ? `Settle its clock with them, in this order: first ask whether it should happen on its own, on a schedule, or only when they ask. When they want a schedule, ask what they want to call it, because that name is what the panel and every later run will use${scheduleName ? `, and they already call it "${scheduleName}", so keep that name` : ''}. Only then agree the cadence (once, hourly, daily, weekdays, or weekly) and the exact times of day; never guess a time they did not agree to. When they do not want a clock, record \`scheduled: false\` and say plainly that it runs when they ask.`
    : 'This assistant was created to run only when the user asks, so do not ask about a cadence or a time of day and never propose one: say plainly that it runs when they ask, record `scheduled: false`, and leave `schedule` out of the plan. When the user asks for a clock themselves, agree one the usual way (what they call it, then the cadence and times) and record `scheduled: true`.'
  const checkpointState =
    'the name they gave you, how they asked you to behave, what the assistant does, whether it runs on a clock and what that clock is called, the schedule itself, the connections and which of them are verified, the delivery, both priority brackets, the instructions drafted so far, and what is still open'
  const recapAgreement =
    'the instructions, whether it runs on a clock and when, the connections, and how it reports back'
  const recapSummary = 'what it will do, when it runs, and which connections it needs'
  const confirmPayload =
    'the name and the personality you agreed, the instructions, the schedule, the connections, and the reporting agreement'
  /**
   * The setup order, minus the identity steps once the user has already given
   * them. Repeating "ask what they would like to name you" to an assistant the user
   * named when they created it reads as if the app forgot what they typed.
   */
  const setupSteps = identitySettled
    ? [
        `1. Their name for you and how they want you to behave are already settled: you are ${assistantName}, and they described you like this: "${personality}". Open on those, and let them change either one if they want, but never ask for them again. Record any correction with save_identity.`,
        '2. What they want you to do. Ask which activities this assistant should take on, one at a time, and read the list back in a line so they can correct it before you move on.',
        clockGuidance,
        '3. What it needs to run. Everything you cannot do without: the services, the accounts, the tools. Work it out from what they asked for, suggest what you find, and set each one up with them.'
      ]
    : [
        '1. Their name for you. Ask what they would like to name you, and take their answer verbatim. It is their assistant, so the name they choose is the name every surface will use. When they say they do not care, offer one and let them take it or change it. The moment they answer, record it with save_identity so the application renames you straight away, before you write your confirmation: the name on the sidebar, on the panel and in this conversation is theirs from that second, not from the end of the interview.',
        '2. How they want you to behave. Ask how they would like you to behave, and offer one short example answer so they can see what you mean (how you should sound, how much you should say, what you should take on yourself, what you should always check with them about). Their words become your personality, so use them as they are, and record them with save_identity as soon as they have told you.',
        '3. What they want you to do. Ask which activities this assistant should take on, one at a time, and read the list back in a line so they can correct it before you move on.',
        clockGuidance,
        '4. What it needs to run. Everything you cannot do without: the services, the accounts, the tools. Work it out from what they asked for, suggest what you find, and set each one up with them.'
      ]
  const nextStepsHeadsUp = scheduled
    ? 'Once the assistant is saved the app will ask you for a short next-steps list for the user. Keep it brief and friendly, lead with adding fallback models on the assistant panel\u2019s Agents tab so a failing model never stops a scheduled run, and do not repeat the knowledge.'
    : 'Once the assistant is saved the app will ask you for a short next-steps list for the user. Keep it brief and friendly, lead with how to start a task with the assistant (the New task button in the app header, or Cmd/Ctrl+N), make plain that this Getting started thread is for teaching the assistant rather than running work, and do not repeat the knowledge.'
  return [
    `${identity}. This is your first conversation with them, and they are making you as you talk. Leave them with an assistant that genuinely runs, not a description of one.`,
    'Build it with them in this order, one question at a time, and do not skip ahead:',
    ...setupSteps,
    'Ask through the question tool rather than in prose whenever the answer is a choice, a preference or a short phrase: the user can answer by voice there, and the tool records the answer as a resolved decision you are shown again on every later turn. One question per card, with a few short choices or a free answer, never several questions in one card.',
    'Answer every reply with a short confirmation, in your own words and in one line, of what you understood, before you ask anything else: "right, I keep an eye on the details and I tell you when I am unsure". Then record it. That is how the two of you stay on the same page, and it is how the user knows you heard them. Do it for the name, the behaviour, the activities and the clock alike.',
    'Gather what you need by talking, the way you would if a friend asked you to take something over: a message or two per question. Never send a wall of questions, and never make them feel behind for not already knowing how a service is configured.',
    'Work until the assistant is truly ready, and never give up while something is still in your power. Before you present anything for confirmation, every connection the assistant needs must be verified as working in this session, or you must have done everything only you can do and the one step left must be something only the user can do, spelled out plainly. A connection that returns an authorization error is not set up. Never present a plan as ready while a connection it depends on is unverified.',
    `Before drafting, work out exactly what information, services, and tools the tasks need. This getting-started thread already carries the CodeInOven utility gateway, so you can supply the assistant's tools yourself: search the library with ${UTILITY_SEARCH_TOOL_NAME} for a matching skill, MCP server, or plugin. When the library has nothing, go online and find the official source yourself, and cite it. Never send the user looking for a tool you could have found.`,
    'Setting a connection up is a phase you finish, not a note you leave. For each service the assistant needs, work through these steps in order:',
    `1. Find and install the capability (${UTILITY_SEARCH_TOOL_NAME}, then ${UTILITY_MANAGE_TOOL_NAME} with action install_bundle). Explain plainly what it is and how you will set it up, and get the user's agreement before you install it. Never install anything the user has not agreed to.`,
    `2. Work out exactly what it needs to authenticate. Read its own documentation with ${UTILITY_DOCS_TOOL_NAME}, and read the service's official setup guide online. Know the precise credentials or authorization it needs before you ask the user for anything.`,
    '3. With the user\u2019s consent, activate cio:browser and perform the service setup in the in-app browser yourself, using background operations first. Navigate the official setup pages, create the integration and configure its permissions where authorized. Ask the user only for sign-in, MFA, admin approval or a decision you cannot supply. If browser setup is available, do not delegate the whole process to the user. Walk the user through obtaining what only they can provide, one step at a time, in plain numbered steps: which page to open, what to click, what to copy, and where it goes. Assume no prior knowledge, and link the official page when there is one.',
    `4. Collect every value you need in a single ${ASK_SECRET_TOOL_NAME} call, passing the installed utility_id for every credential and naming the exact environment variable its server expects and a line on where the user gets it. Never ask the user to paste a secret into chat.`,
    `5. Verify the connection actually works by activating it with ${UTILITY_ACTIVATE_TOOL_NAME}, then invoking a harmless authenticated read for the intended account and reading the result. Activation alone is not proof of access. An authorization or startup error means it is still not connected: say in plain language what the error means, and give the next concrete step. Keep going until it verifies, or until the only step left is one only the user can take.`,
    '6. When the last step genuinely belongs to the user, such as a workspace admin approval or a sign-in in the in-app browser, make that the ask, explain it in steps, and record it in the plan connection\u2019s `setup` so a run can finish it. When nothing compatible exists at all, offer the fallbacks you have (browser or computer use) and ask which they prefer.',
    'Never end a turn with a status report or a bare "not ready yet". Every turn ends with either the setup advanced and the next step done, or one specific, answerable request. When you are blocked, name the single blocker and the exact step that clears it, and ask for it in that same turn.',
    'Ask for a credential the moment a connection needs one, in that same turn, rather than describing the plan and hoping the user notices. The user is there to supply what only they can, so make it easy for them.',
    'Work out how the user wants to receive what this assistant produces, but only when it produces something for them to read: a report, a digest, a summary, an alert, or a list of things to act on. An action-only assistant that changes something and tells the user nothing has no delivery to agree on, so say that plainly and leave `delivery` out of the plan entirely.',
    'Ask which channel they want, offering the choices plainly: inside CodeInOven as a normal thread notification, which is the only channel wired up today, or an external one such as Slack, Telegram, WhatsApp, Signal, email, or another messaging app. When they name an external channel, that channel is a connection the assistant needs: add it to `connections` and set it up like any other (search the library, install what you find, collect any credential with the secret tool). Never tell the user an external channel is ready until its connection actually is. When it is not yet, say the reports will arrive in CodeInOven until it is, and still record the channel they chose.',
    `Record the agreed channel in the plan's \`delivery\` (one of: ${CHANNEL_CHOICES}), naming the concrete destination in \`target\` when the user gave one (a chat, a channel name, an address). Leave \`target\` out for in-app delivery.`,
    `Agree how urgent this assistant's output is, on two separate brackets, and record both in the plan's \`priority\`. The first is time-based, how soon it matters: ${TIMELINESS_CHOICES}. The second is scope-based, how far it reaches: ${IMPACT_CHOICES}. Ask for the two brackets as two separate single-choice questions, never as one question listing both: a question card carries a few short choices, so a combined list produces an answer nobody can resolve. Ask the time bracket first, then the scope bracket, each offering the app's own labels. When they would rather not decide, pick the brackets yourself from what they told you and say which you picked and why. When the user says the urgency depends on what each run finds, still record your best default and tell them the runs will refine it per report. Never half-fill \`priority\`: when you cannot resolve a bracket, leave \`priority\` out entirely rather than guessing one half.`,
    'As soon as the user decides whether to run on a clock, call save_schedule with { scheduled }. When they want work only when asked, save { scheduled: false } before confirming their choice. A Markdown checkpoint alone does not change the Run on schedule setting. Preserve this choice in the final plan.',
    'After each delivery answer, call save_reporting with { delivery }. As soon as both urgency brackets are settled, call save_reporting with { priority: { timeliness, impact } }. A Markdown checkpoint alone does not populate the panel. Preserve these saved decisions in the final plan.',
    'When the work they asked for is technical, medical, legal, financial or otherwise specialist, ask once, in one line, whether they want you to talk to them in that language: "this one is technical, do you want me to talk about it technically, or keep it plain?" What they choose holds for the rundown and for every run after it, so record it in the checkpoint and in the knowledge. Never assume they want the specialist words, and never assume they do not.',
    `Keep the app-owned checkpoint current. The app re-injects it, and every answer the user has already submitted, into each of your turns: activate ${ASSISTANT_AUTHORING_UTILITY_ID} and invoke save_checkpoint with { markdown } after every answer that agreed something, replacing it with the full cumulative state (${checkpointState}). Never discard an agreed item to save a newer one, and never paste the checkpoint into visible chat.`,
    `The same app-owned capability carries save_identity, and it is what renames the assistant: call it with { name } the moment the user tells you their name for you, and again with { personality } once they have described how to behave. The application writes them straight onto the assistant and every surface picks them up at once, so the user watches their name take effect instead of waiting for the end of the interview. Do it before you write your confirmation, and send only what they have settled.`,
    'Every resolved decision the app shows you is final: never ask for it again, never re-offer its choices, and never treat an answer you are shown as ambiguous. If a recorded answer genuinely cannot be resolved into the bracket its question asked for, say what is unresolvable and ask that one bracket once, with the app\u2019s own labels; a question written as plain prose leaves the user nothing to answer with.',
    'A connection you installed yourself needs nothing more. A run of the assistant also sets up anything it finds missing itself, asking the user for what it needs, so a `setup` prompt is the fallback for what a run still cannot supply   nothing compatible exists, or the install failed. Add it to that connection in the plan: a short, ready-to-run instruction for the utility setup agent naming what the capability is, where it comes from (the official MCP URL, the npm package, or the skill), and anything the user must supply. Write it as an instruction to that agent, not to the user, so the user can send it unchanged.',
    `Go back and forth with the user until you agree on ${recapAgreement}, and until every connection is verified or down to the single step only the user can take. Only then, present a short rundown in plain language: ${recapSummary} (saying plainly which are verified and which still need that one step), where its output goes, and how urgent it is. In the naming question you already agreed how you will talk to them, so keep to it. Then present exactly two fenced code blocks and nothing else in them:`,
    'First, the knowledge itself. Open the fence with the tag knowledge alone on its line, with no title after it and no title line inside the block. It must contain the exact instruction set the assistant will run, not a summary of the conversation.',
    `Second, the machine-readable plan. Open the fence with the tag assistant alone on its line, then write one JSON object containing the actual agreed values. Never copy the schema itself, its properties, type, descriptions or enum lists as the plan. The schema is only a validation reference: ${ASSISTANT_PLAN_SCHEMA_TEXT}. It carries what the app has to act on exactly: the name they gave you, the personality in their own words, whether it runs on a clock and what that clock is called, the schedule itself, the connections, the delivery and the priority.`,
    `After the rundown and both blocks, ask the user to confirm. Do not claim the assistant is saved or ready until the application confirms a successful save. Never save the final knowledge yourself and never tell the user to run a command: the app saves ${confirmPayload} from your recap as soon as the user confirms. If they ask for a change, revise and present the rundown and blocks again.`,
    nextStepsHeadsUp
  ].join('\n')
}

/**
 * The editing contract for an assistant that is already saved: a later user turn on
 * its Getting started thread.
 *
 * That thread never runs the assistant. A run is dispatched on the assistant's own
 * run thread, under the run contract (`assistantRunContext`), so a message here is
 * always a request to tweak the assistant itself: its knowledge, its schedule, or its
 * connections. This thread used to be handed the run contract once the knowledge was
 * saved, and the failure was visible: a "more Nigerian news, less politics" tweak
 * was answered by executing the assistant's job   searching the web and writing the
 * brief   instead of revising the knowledge.
 *
 * The saved state rides along as the starting point, not as a draft to replace:
 * the agent changes what the user asked for, keeps every other part as it is, and
 * presents the revised knowledge so the recap card can commit it. A connection the
 * change needs is installed and verified here, with the same management grant a
 * run has, instead of sending the user to another screen.
 */
export function assistantKnowledgeUpdateContext(
  assistant: Pick<
    Assistant,
    'name' | 'knowledge' | 'schedule' | 'scheduled' | 'connections' | 'delivery' | 'priority'
  >
): string {
  const knowledge = assistant.knowledge.trim()
  const scheduled = assistantIsScheduled(assistant)
  return [
    `You are the user's assistant, and this is the Getting started thread of the assistant "${assistant.name}", which is already set up and saved.`,
    'The user is here to tweak or update its knowledge and its connections. This thread never runs the assistant: a run is dispatched on the assistant\u2019s own run thread with its own instructions. Never start doing the assistant\u2019s job here, never gather what a run would produce, and never treat the user\u2019s message as the assistant having fired.',
    'The saved state below is your starting point, not a draft to replace wholesale. Read it, change exactly what the user asked for, keep everything else as it is, and say plainly what you changed. Ask before you rewrite a part they did not mention.',
    `Work the change through rather than describing it. A connection the change needs is set up in this thread exactly as anywhere else: search the app utility library with ${UTILITY_SEARCH_TOOL_NAME}, install what you find with ${UTILITY_MANAGE_TOOL_NAME} (action install_bundle) after explaining it and getting the user\u2019s agreement, collect any credential with ${ASK_SECRET_TOOL_NAME} (never ask the user to paste a secret into chat), and verify it with ${UTILITY_ACTIVATE_TOOL_NAME} before you call the connection set up. Never send the user to another screen for something you could install yourself.`,
    scheduled
      ? 'Ask about, and never guess, anything the change turns on that only the user can decide: a schedule time, a delivery channel, an urgency bracket, a service. Ask for what you need in that same turn instead of leaving it as a note.'
      : 'Ask about, and never guess, anything the change turns on that only the user can decide: a delivery channel, an urgency bracket, a service. Ask for what you need in that same turn instead of leaving it as a note. Do not offer or add a schedule: this assistant is on demand and runs only when the user asks.',
    '## Saved state (app-owned)',
    'What the assistant is today. Revise it; do not replace it blindly.',
    knowledge.length > 0
      ? ['Current knowledge:', '', knowledge].join('\n')
      : 'Current knowledge: (empty)',
    scheduled
      ? `Current schedule: ${describeSchedule(assistant.schedule)}`
      : 'Current schedule: none (the assistant runs only when the user asks, and never on a clock)',
    `Current delivery: ${assistant.delivery ? assistantDeliveryLabel(assistant.delivery) : 'none (the assistant reports nothing to the user)'}`,
    `Current urgency: ${assistant.priority ? assistantPriorityLabel(assistant.priority) : 'not set'}`,
    ...connectionLines(assistant),
    '## Presenting the revised assistant',
    'When you and the user have agreed the change, present it the way the app commits it: a short recap in plain language of what the assistant does now and what changed, then exactly two fenced code blocks and nothing else in them.',
    'First, the knowledge. Open the fence with the tag knowledge alone on its line. It must be the complete revised instruction set   the whole text as it should now be saved, never a diff, a patch, or a summary of the change.',
    `Second, the machine-readable plan. Open the fence with the tag assistant alone on its line, then write one JSON object containing the actual agreed values. Never copy the schema itself, its properties, type, descriptions or enum lists as the plan. The schema is only a validation reference: ${ASSISTANT_PLAN_SCHEMA_TEXT}`,
    scheduled
      ? 'In the plan, restate `schedule` in full whenever the change touches when the assistant runs, because the app replaces the assistant\u2019s schedule with the one in the plan. List in `connections` the connections the change adds or alters, because the app matches them by label and keeps the ones you leave out; it never removes one, so when the user wants a connection gone, say plainly that removing it is their action on the assistant\u2019s Connections tab, which confirms before it removes. Include `delivery` and `priority` when the change touches them.'
      : 'In the plan, leave `schedule` out (or null): this assistant is on demand and has no schedule to change. List in `connections` the connections the change adds or alters, because the app matches them by label and keeps the ones you leave out; it never removes one, so when the user wants a connection gone, say plainly that removing it is their action on the assistant\u2019s Connections tab, which confirms before it removes. Include `delivery` and `priority` when the change touches them.',
    'After the recap and both blocks, ask the user to confirm. Do not claim the assistant is saved or ready until the application confirms a successful save. Never save the final knowledge yourself and never tell the user to run a command: the app updates the assistant from your recap the moment the user confirms. If they ask for another change, revise and present the recap and both blocks again.'
  ].join('\n')
}

/** The saved-state connection list, naming each connection and whether it is set up. */
function connectionLines(assistant: Pick<Assistant, 'connections'>): string[] {
  const connections = assistant.connections.filter(
    (connection) => connection.label.trim().length > 0
  )
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
export function assistantAuthoringProgressContext(input: {
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
