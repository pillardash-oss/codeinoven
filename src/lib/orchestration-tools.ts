import type { GatewayToolDefinition } from './gateway-tools'
import { THINKING_LEVEL_ORDER } from './thinking-presets'
import { MODEL_PROFILE_INFERENCE_MODES, MODEL_PROFILE_PERMISSION_LEVELS } from './model-profiles'

/**
 * The app-owned orchestration tools, as one canonical catalog.
 *
 * These tools let an agent act on the workstation the way the user does: read
 * what machines, harnesses, models and accounts exist, then dispatch real work
 * onto a chosen machine with a chosen model. They are transported by the same
 * utility gateway every other app-owned tool uses, so `GATEWAY_TOOLS` spreads
 * them in and the Pi extension, the generated MCP server and the main-process
 * bridge all stay in step from this one list.
 *
 * Two rules shape the contract:
 *
 * 1. The agent resolves, the app validates. A request such as "use sol on the
 *    Codex oven" is fuzzy in ways only a language model should judge, so the
 *    read tool hands the model the real catalog and the dispatch tool accepts
 *    only exact ids from it. The app never guesses a model, an account or a
 *    machine on the user's behalf.
 * 2. Missing or ambiguous inputs become a question, not a default. When the
 *    user did not name an account, or a model name matches more than one entry,
 *    the agent asks with the harness question tool and offers the real options
 *    from the read tool's result.
 *
 * Gating is the gateway's, not prose's: the tools are only placed on a turn
 * that carries the `@cio-orchestrate` tag, and a turn without it cannot reach
 * a route that is not there.
 */

/** Read the machines, harnesses, models, accounts and profiles a dispatch may name. */
export const ORCHESTRATION_TARGETS_TOOL_NAME = 'cio_orchestrate_targets'
/** Create a real thread on a chosen machine and run a prompt in it. */
export const ORCHESTRATION_DISPATCH_TOOL_NAME = 'cio_orchestrate_dispatch'
/** Read the status and latest result of a thread this session dispatched. */
export const ORCHESTRATION_STATUS_TOOL_NAME = 'cio_orchestrate_status'

/** Every orchestration tool name, for gate checks and the Pi extension. */
export const ORCHESTRATION_TOOL_NAMES: readonly string[] = [
  ORCHESTRATION_TARGETS_TOOL_NAME,
  ORCHESTRATION_DISPATCH_TOOL_NAME,
  ORCHESTRATION_STATUS_TOOL_NAME
]

/** Whether a gateway tool name belongs to the orchestration family. */
export function isOrchestrationTool(name: string): boolean {
  return ORCHESTRATION_TOOL_NAMES.includes(name)
}

/**
 * The result shape every orchestration operation answers with.
 *
 * Deliberately open: the gateway must never reshape a result a handler
 * produced, and a harness that runs scripts reads real fields from it.
 */
const ORCHESTRATION_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true
}

const TARGETS_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    harnessId: {
      type: 'string',
      description:
        'Limit model, account and saved-profile results to this harness id. Omit to read every harness.'
    },
    ovenId: {
      type: 'string',
      description:
        'Limit the Oven list and its installed-harness inventory to this Oven id. Omit to read every Oven.'
    },
    includeModels: {
      type: 'boolean',
      description:
        'Include the model catalogs. Defaults to true. Send false for a call that only needs machines, accounts or profiles.'
    }
  },
  additionalProperties: false
}

const DISPATCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Short thread title, written for the user, naming the work being dispatched.'
    },
    prompt: {
      type: 'string',
      description:
        'The complete instruction the dispatched agent receives, self-contained and written as if the user typed it into that thread.'
    },
    projectId: {
      type: 'string',
      description:
        'Project the thread belongs to. Omit to dispatch inside the project this conversation is already working on.'
    },
    ovenId: {
      type: 'string',
      description:
        'Exact Oven id from cio_orchestrate_targets. `local` or omitted runs on this computer.'
    },
    ovenPath: {
      type: 'string',
      description:
        'Absolute workspace path on the Oven. Omit to let the app prepare the Oven checkout for the project.'
    },
    harnessId: {
      type: 'string',
      description:
        'Exact harness id from cio_orchestrate_targets, for example pi, codex or claude-code.'
    },
    providerId: {
      type: 'string',
      description: 'Exact provider id from the selected harness catalog in cio_orchestrate_targets.'
    },
    modelId: {
      type: 'string',
      description: 'Exact model id from the selected provider in cio_orchestrate_targets.'
    },
    accountId: {
      type: 'string',
      description:
        'Exact account id from cio_orchestrate_targets for the selected harness. Omit to use the account the app already marks as default for that harness, and ask the user when no default exists and the user did not name one.'
    },
    thinkingLevel: {
      type: 'string',
      enum: [...THINKING_LEVEL_ORDER],
      description:
        'Reasoning effort. Omit to let the app apply the model choice its own default rule resolves to.'
    },
    inferenceMode: {
      type: 'string',
      enum: [...MODEL_PROFILE_INFERENCE_MODES],
      description: 'Speed tier. Omit for the standard tier.'
    },
    permissionLevel: {
      type: 'string',
      enum: [...MODEL_PROFILE_PERMISSION_LEVELS],
      description: 'Permission tier for the dispatched run. Omit to inherit the requesting thread.'
    }
  },
  required: ['title', 'prompt', 'harnessId', 'providerId', 'modelId'],
  additionalProperties: false
}

const STATUS_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    threadId: {
      type: 'string',
      description: 'Thread id returned by cio_orchestrate_dispatch or listed in this project.'
    },
    projectId: {
      type: 'string',
      description:
        'Project the thread belongs to. Omit to look in the project this conversation is working on.'
    }
  },
  required: ['threadId'],
  additionalProperties: false
}

export const ORCHESTRATION_TOOLS: GatewayToolDefinition[] = [
  {
    name: ORCHESTRATION_TARGETS_TOOL_NAME,
    description:
      'Read the CodeInOven workstation: the Ovens (machines) and which harnesses each one has installed, the harness catalog, the model catalogs with the thinking levels each model offers, the saved model profiles, and the accounts per harness with the one the app marks as default. Call this before cio_orchestrate_dispatch: it is the only source of the exact ids a dispatch accepts. Its results also carry the current project, the default Oven and the default harness, so a request that names none of them still has a real value to propose and confirm with the user.',
    inputSchema: TARGETS_INPUT_SCHEMA,
    outputSchema: ORCHESTRATION_RESULT_SCHEMA,
    route: '/orchestrate-targets',
    sentWhen: 'An @cio-orchestrate turn, before dispatching work to a machine or a model'
  },
  {
    name: ORCHESTRATION_DISPATCH_TOOL_NAME,
    description:
      'Create a real CodeInOven thread and run a prompt in it, on a chosen Oven with a chosen harness, provider, model, thinking level, account and permission tier. The thread appears in the sidebar like any other, bound to the Oven and streaming its status, exactly as if the user had configured and started it by hand. Use only exact ids read from cio_orchestrate_targets. Before calling, resolve every field the user named; for a field the user left out and the app has no default for, ask the user with the harness question tool and offer the real options. The call returns as soon as the run is accepted: do not block, and do not claim the work is finished. The app reports back into this conversation when the dispatched thread settles.',
    inputSchema: DISPATCH_INPUT_SCHEMA,
    outputSchema: ORCHESTRATION_RESULT_SCHEMA,
    route: '/orchestrate-dispatch',
    sentWhen: 'An @cio-orchestrate turn once every dispatch field is resolved or confirmed'
  },
  {
    name: ORCHESTRATION_STATUS_TOOL_NAME,
    description:
      "Read one dispatched thread's status and latest result by its id. Use it for a follow-up question about work already dispatched. A thread that is still running answers with its working status; a settled one answers with its final status, its title and the machine it ran on.",
    inputSchema: STATUS_INPUT_SCHEMA,
    outputSchema: ORCHESTRATION_RESULT_SCHEMA,
    route: '/orchestrate-status',
    sentWhen: 'An @cio-orchestrate follow-up about work already dispatched'
  }
]
