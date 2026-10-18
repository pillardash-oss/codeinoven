import type { GatewayToolDefinition } from './gateway-tools'
import { APP_NAME } from './brand'
import { CREATE_ASSIGNMENT_TOOL_NAME } from './engineering-tools'

/**
 * The pawn agent tool, as its own app-owned catalog.
 *
 * A pawn is the hybrid of the two worker shapes the app already has: it runs on
 * a real, independent thread the way an Assignment worker does, and it answers
 * to the agent that spawned it the way a sub-agent does. The user can watch its
 * trace, and cannot type into it.
 *
 * What separates it from `cio_spawn_agent` is capability, not ownership: a
 * sub-agent is a nested session inside the harness with a small tool allowlist,
 * while a pawn is a full thread with the thread's whole tool surface, so it is
 * the one to reach for when the work needs the project's real tools. What
 * separates it from an Assignment is who is in charge: Assignment workers exist
 * for the user to prompt, pawns exist for an agent to direct.
 *
 * Committing stays with the spawning agent, exactly as it does for a sub-agent,
 * because the spawner is the one that reviews the work before it lands.
 */

/** Spawns or continues a pawn agent: a background thread owned by the calling agent. */
export const PAWN_AGENT_TOOL_NAME = 'cio_pawn_agent'

/** Whether a gateway tool name belongs to the pawn family. */
export function isPawnTool(name: string): boolean {
  return name === PAWN_AGENT_TOOL_NAME
}

/** The thinking level a pawn runs at when the spawning agent names none. */
export const PAWN_DEFAULT_THINKING_LEVEL = 'minimal'

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

const PAWN_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    instructions: {
      type: 'string',
      description:
        'The complete, self-contained task for the pawn: the goal, the files or areas it owns, how to verify its own work, and what it must report. In continue mode this is the next instruction for the pawn named by pawn_id.'
    },
    purpose: {
      type: 'string',
      description:
        'Short task category, e.g. implement, verify, refactor, investigate. Used in the pawn thread title and in your own trace.'
    },
    pawn_id: {
      type: 'string',
      description:
        'Continue a pawn you already spawned: its id, from a previous call. Omit it to spawn a new pawn.'
    },
    model: {
      type: 'string',
      description:
        "Model override as 'provider/model-id' or a model id. Defaults to the user's pawn default when one is configured, otherwise your own model."
    },
    thinking_level: {
      type: 'string',
      enum: [...THINKING_LEVELS],
      description:
        'Thinking level for the pawn. Defaults to the lowest level; raise it only when the task genuinely needs deeper reasoning.'
    },
    background: {
      type: 'boolean',
      description:
        "Run in the background and return immediately with the pawn id; the pawn steers you its final message when it finishes. Omit it to block until the pawn answers and receive that answer as this call's result."
    }
  },
  required: ['instructions'],
  additionalProperties: false
}

export const PAWN_TOOLS: GatewayToolDefinition[] = [
  {
    name: PAWN_AGENT_TOOL_NAME,
    description: `Spawn or continue a pawn agent for ${APP_NAME}: an independent worker thread that answers only to you, the agent that spawned it. The user cannot prompt it; they can watch it work. Use a pawn when the work needs the project's real tools and its own full context   long implementations, broad refactors, independent verification, research that would otherwise flood your context   and hand back only a final report. Choose between the three by ownership and power: ${PAWN_AGENT_TOOL_NAME} is a full thread you direct yourself, cio_spawn_agent is a lighter nested sub-agent with a small tool allowlist, and ${CREATE_ASSIGNMENT_TOOL_NAME} is for work the user wants to monitor and prompt personally. A pawn inherits the project rules: it must verify its own changes, it must list every file it touched, and it must not commit   committing stays with you, because you review its work before it lands.`,
    inputSchema: PAWN_INPUT_SCHEMA,
    outputSchema: { type: 'object', additionalProperties: true },
    route: '/pawn/agent',
    sentWhen:
      'Any agent turn that wants a task done end to end on its own thread without spending its own context'
  }
]
