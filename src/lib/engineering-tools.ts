import type { GatewayToolDefinition } from './gateway-tools'
import { APP_NAME } from './brand'

/**
 * The app-owned engineering artifact tools, as one canonical catalog.
 *
 * These are real callable tools rather than phrase matching. Before them the
 * app watched the user's message for words like "assignment" or "workers" and
 * guessed from the wording, which is brittle: the same sentence can mean
 * different things to different people, and a mention of a word is not a
 * request. Here the agent decides when an artifact is wanted and calls the tool,
 * the same way it reaches for any other app capability, and the tool contract
 * carries the guidance that used to be buried in per-turn system prompts.
 *
 * Each tool creates a durable, reviewable artifact through the machinery the
 * Studio buttons already use. Nothing a user has to sign off is signed for them:
 * the tool produces the draft and the existing review surface takes over.
 *
 * Gating is the gateway's, not prose's: the routes are placed only on a turn
 * that carries `artifactTools`, and a turn without it cannot reach a route that
 * is not there.
 */

/** Create the thread's durable Brainstorm artifact. */
export const CREATE_BRAINSTORM_TOOL_NAME = 'cio_create_brainstorm'
/** Create the thread's product requirements document. */
export const CREATE_PRD_TOOL_NAME = 'cio_create_prd'
/** Create the thread's engineering specification. */
export const CREATE_SPEC_TOOL_NAME = 'cio_create_spec'
/** Create the thread's Assignment task graph for the user to sign off. */
export const CREATE_ASSIGNMENT_TOOL_NAME = 'cio_create_assignment'
/** Turn on Achievement: implement, audit and rework until the goal is verified. */
export const CREATE_ACHIEVEMENT_TOOL_NAME = 'cio_create_achievement'

/** Every engineering artifact tool name, for gate checks and the Pi extension. */
export const ENGINEERING_TOOL_NAMES: readonly string[] = [
  CREATE_BRAINSTORM_TOOL_NAME,
  CREATE_PRD_TOOL_NAME,
  CREATE_SPEC_TOOL_NAME,
  CREATE_ASSIGNMENT_TOOL_NAME,
  CREATE_ACHIEVEMENT_TOOL_NAME
]

/** The operation each tool maps to, one per lifecycle stage. */
export type EngineeringToolOperation = 'brainstorm' | 'prd' | 'spec' | 'assignment' | 'achievement'

/** Whether a gateway tool name belongs to the engineering artifact family. */
export function isEngineeringTool(name: string): boolean {
  return ENGINEERING_TOOL_NAMES.includes(name)
}

/** The operation name a tool name maps to, or null when it is not one. */
export function engineeringToolOperation(name: string): EngineeringToolOperation | null {
  switch (name) {
    case CREATE_BRAINSTORM_TOOL_NAME:
      return 'brainstorm'
    case CREATE_PRD_TOOL_NAME:
      return 'prd'
    case CREATE_SPEC_TOOL_NAME:
      return 'spec'
    case CREATE_ASSIGNMENT_TOOL_NAME:
      return 'assignment'
    case CREATE_ACHIEVEMENT_TOOL_NAME:
      return 'achievement'
    default:
      return null
  }
}

/**
 * The result every engineering artifact tool answers with.
 *
 * Deliberately open: the app reports the artifact identity and whatever the
 * review surface expects next, without this schema pretending to know the whole
 * document.
 */
const ENGINEERING_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true
}

const INSTRUCTIONS_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    instructions: {
      type: 'string',
      description:
        "What this artifact should cover, in the user's own words, plus any constraint they named. Optional: when omitted the artifact is built from the thread conversation."
    }
  },
  additionalProperties: false
}

export const ENGINEERING_TOOLS: GatewayToolDefinition[] = [
  {
    name: CREATE_BRAINSTORM_TOOL_NAME,
    description: `Create the thread's durable Brainstorm artifact for ${APP_NAME}: a versioned document that records the problem, the options weighed, the decisions taken and the choices still open. Call it only when the user explicitly asks to brainstorm or explore an idea, or asks to settle a direction before committing to one. A plan request is not a brainstorm, and neither is a large or uncertain task: answer those in prose. The draft is generated from the thread conversation and the optional instructions and appears for review.`,
    inputSchema: INSTRUCTIONS_INPUT_SCHEMA,
    outputSchema: ENGINEERING_RESULT_SCHEMA,
    route: '/engineering/brainstorm',
    sentWhen: 'A project thread where the user explicitly asks to brainstorm or explore a direction'
  },
  {
    name: CREATE_PRD_TOOL_NAME,
    description: `Create the thread's product requirements document (PRD) for ${APP_NAME}: the versioned, human-facing statement of what is being built, for whom, and why. Call it only when the user explicitly asks for a PRD or for product requirements. Do not infer one from a plan, a feature description, the size of the work or the number of steps involved. It is generated from the finalized Brainstorm when one exists, otherwise from the thread conversation and the optional instructions, and it appears for review.`,
    inputSchema: INSTRUCTIONS_INPUT_SCHEMA,
    outputSchema: ENGINEERING_RESULT_SCHEMA,
    route: '/engineering/prd',
    sentWhen: 'A project thread where the user explicitly asks for a PRD or product requirements'
  },
  {
    name: CREATE_SPEC_TOOL_NAME,
    description: `Create the thread's engineering specification for ${APP_NAME}: the implementation-ready document (problem, phases and checkpoints, file operations, tests, commits, constraints and risks) that an Assignment or an implementation turn works from. Call it only when the user explicitly asks for a spec or a specification. A plan is not a spec: when the user asks for a plan, a checklist, an approach or the steps, write that plan yourself in prose or a markdown file and carry out the work, however large it is. This enters the thread's Engineering spec stage and generates the specification draft for review; it never approves or implements anything on its own.`,
    inputSchema: INSTRUCTIONS_INPUT_SCHEMA,
    outputSchema: ENGINEERING_RESULT_SCHEMA,
    route: '/engineering/spec',
    sentWhen: 'A project thread where the user explicitly asks for a spec or a specification'
  },
  {
    name: CREATE_ASSIGNMENT_TOOL_NAME,
    description: `Create the thread's Assignment for ${APP_NAME}: a reviewable task graph that splits the work across worker threads the user can monitor and, after sign-off, prompt and steer individually. Call it only when the user explicitly asks to split the work across workers, tasks or agents, or to spread it across agents. A plan or a step list is not an Assignment: write that plan in prose instead. Choose it over inline sub-agents by this rule: an Assignment and the sub-agents from cio_spawn_agent can both be watched, but only Assignment workers can be given independent follow-up instructions, so an Assignment is the right tool exactly when the user wants to prompt the workers themselves. If the user has not already said which they want, ask with cio_ask_user before choosing: offer "workers I can monitor and prompt" (this tool) against "sub-agents working alongside you" (cio_spawn_agent). Do not ask again when the user has already stated a preference in this conversation. The draft is built from what exists: the approved specification when there is one, otherwise the thread conversation plus the optional instructions. Nothing runs until the user reviews the graph, picks worker models and signs it off.`,
    inputSchema: INSTRUCTIONS_INPUT_SCHEMA,
    outputSchema: ENGINEERING_RESULT_SCHEMA,
    route: '/engineering/assignment',
    sentWhen:
      'A project thread where the user explicitly asks to split work across workers, tasks or agents'
  },
  {
    name: CREATE_ACHIEVEMENT_TOOL_NAME,
    description: `Turn on Achievement for ${APP_NAME}: the thread implements, audits and reworks autonomously until the approved goal is verified, without asking the user to approve steps. Call it only when the user explicitly asks to keep going until a goal is reached ("do this until it works", "take it all the way", "keep going until complete"). Do not call it for a single artifact, for a plan, or because the work looks long. It requires an approved specification, because the independent audit judges the result against that contract; when no approved specification exists the tool says so and the specification tool runs first. Nothing is signed off on the user's behalf.`,
    inputSchema: INSTRUCTIONS_INPUT_SCHEMA,
    outputSchema: ENGINEERING_RESULT_SCHEMA,
    route: '/engineering/achievement',
    sentWhen: 'A project thread where the user explicitly asks to continue until a goal is reached'
  }
]
