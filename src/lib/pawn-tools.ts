import type { GatewayToolDefinition } from './gateway-tools'
import { APP_NAME } from './brand'

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

/**
 * The permission tier a pawn starts at when the spawning agent names none.
 *
 * The app default, not the spawner's own tier: a background worker the user never
 * watches should not silently inherit full access from a conversation that had it.
 * An agent raises it to full_access only when the user instructed that, and the
 * permission card for anything below it reaches the agent, which is the one that
 * can decide.
 */
export const PAWN_DEFAULT_PERMISSION_LEVEL = 'auto_review'

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
        "Continue or steer a pawn you already spawned: its id, from a previous call. While the pawn is still working, the instruction reaches it as an update to the work in progress; once it has finished, the same call starts a new turn on the pawn's thread. Omit it to spawn a new pawn."
    },
    model: {
      type: 'string',
      description:
        "Model override as 'provider/model-id' or a model id. Omit it to run on the model this thread is using; a bare model id keeps this thread's provider, account and harness."
    },
    harnessId: {
      type: 'string',
      description:
        'Run the pawn on this harness instead of your own, e.g. claude-code, codex, opencode or pi. Read cio_orchestrate_targets for the harnesses this workstation can run, and name providerId and modelId with it. Omit it to inherit your harness.'
    },
    providerId: {
      type: 'string',
      description:
        'Provider for a model you are naming with modelId. Required whenever you name a harness or a provider, and ignored when you name neither.'
    },
    modelId: {
      type: 'string',
      description:
        'Exact model id from cio_orchestrate_targets. Required whenever you name a harness or a provider, and ignored when you name neither.'
    },
    accountId: {
      type: 'string',
      description:
        "Run the pawn on this saved account instead of this harness's default one, e.g. a second Claude subscription with capacity left. Read cio_orchestrate_targets for the real account ids."
    },
    ovenId: {
      type: 'string',
      description:
        'Run the pawn on this Oven (machine) instead of the one this thread runs on, so the work happens where the checkout and its tools live. Omit it to inherit the Oven this thread already runs on.'
    },
    permissionLevel: {
      type: 'string',
      enum: ['auto_review', 'full_access'],
      description:
        'How much the pawn may do without asking. Omit it to start at the app default (auto_review); raise it to full_access only when the user told you to let this work run unsupervised, because a permission card the pawn raises reaches you, not the user.'
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
    description: `Spawn or continue a pawn agent for ${APP_NAME}: an independent worker thread that answers only to you, the agent that spawned it. The user cannot prompt it; they can watch it work. Use a pawn when the work needs the project's real tools and its own full context   long implementations, broad refactors, independent verification, research that would otherwise flood your context   and hand back only a final report.

Where a pawn runs. With no target named, the pawn inherits everything you are: the same harness, the same account, the same model, the same Oven, so it is you working on a thread of your own. Name harnessId, providerId and modelId to run it on another harness, accountId to run it on another account of the same harness, ovenId to run it on another machine, and permissionLevel to change how much it may do unsupervised. That is the whole difference between the worker shapes: a sub-agent lives inside the harness that started it and can only ever be that harness on that account, while a pawn is a real thread, so a cross-harness, cross-account or cross-Oven worker is simply a thread opened there. Nothing about the work is special-cased per harness: the pawn reports its result back to you the same way wherever it ran.

Choosing the shape. Same harness, same account and no larger job than the harness's own sub-agent can carry: use cio_spawn_agent, whose workers stay nested in this harness and cost it nothing outside its own turn. Anything else   another harness, another account, another Oven, or more runs in flight than the four-worker cap   is a pawn. cio_create_assignment stays the tool for work the user wants to monitor and prompt personally.

You direct a pawn for as long as it lives: when the user answers, corrects or redirects work a pawn is doing, call this tool again with that pawn's pawn_id and their instruction, and the pawn takes it into the work in progress   never spawn a second pawn because you want to change direction. A pawn inherits the project rules: it must verify its own changes, it must list every file it touched, and it must not commit   committing stays with you, because you review its work before it lands.`,
    inputSchema: PAWN_INPUT_SCHEMA,
    outputSchema: { type: 'object', additionalProperties: true },
    route: '/pawn/agent',
    sentWhen:
      'Any agent turn that wants a task done end to end on its own thread without spending its own context'
  }
]
