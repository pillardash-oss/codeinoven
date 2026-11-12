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
 * that carries the `@cio-hey` tag, and a turn without it cannot reach
 * a route that is not there.
 */

/** Read the machines, harnesses, models, accounts and profiles a dispatch may name. */
export const ORCHESTRATION_TARGETS_TOOL_NAME = 'cio_orchestrate_targets'
/** Create a real thread on a chosen machine and run a prompt in it. */
export const ORCHESTRATION_DISPATCH_TOOL_NAME = 'cio_orchestrate_dispatch'
/** Read the status and latest result of a thread this session dispatched. */
export const ORCHESTRATION_STATUS_TOOL_NAME = 'cio_orchestrate_status'
/**
 * Keep talking to a thread this session already dispatched: send it a follow-up
 * and/or change how it runs, without starting a new thread for every addition.
 */
export const ORCHESTRATION_CONTINUE_TOOL_NAME = 'cio_orchestrate_continue'
/**
 * Answer what a dispatched thread is waiting for: a question, a secret, or a
 * permission. It is how the decision a blocked thread needs gets back to it after
 * the dispatcher has asked the user in its own conversation.
 */
export const ORCHESTRATION_ANSWER_TOOL_NAME = 'cio_orchestrate_answer'

/** Every orchestration tool name, for gate checks and the Pi extension. */
export const ORCHESTRATION_TOOL_NAMES: readonly string[] = [
  ORCHESTRATION_TARGETS_TOOL_NAME,
  ORCHESTRATION_DISPATCH_TOOL_NAME,
  ORCHESTRATION_STATUS_TOOL_NAME,
  ORCHESTRATION_ANSWER_TOOL_NAME,
  ORCHESTRATION_CONTINUE_TOOL_NAME
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
    assistantId: {
      type: 'string',
      description:
        'Exact assistantId from the `assistants` list in cio_orchestrate_targets. Use this for research, ideas, writing and tasks that belong to an assistant. Omit it to dispatch work into a project. Never send both assistantId and projectId.'
    },
    projectId: {
      type: 'string',
      description:
        'Project the thread belongs to, from the `projects` list in cio_orchestrate_targets. Use this for coding and other work in a repository. Omit to dispatch inside the project this conversation is already working on, or when targeting an assistant.'
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
        'Exact harness id from cio_orchestrate_targets, for example pi, codex or claude-code. Omit to run on the model this conversation is already using.'
    },
    providerId: {
      type: 'string',
      description:
        'Exact provider id from the selected harness catalog in cio_orchestrate_targets. Omit to run on the model this conversation is already using.'
    },
    modelId: {
      type: 'string',
      description:
        'Exact model id from the selected provider in cio_orchestrate_targets. Omit to run on the model this conversation is already using, which is the right default unless the user asked for another model.'
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
  required: ['title', 'prompt'],
  additionalProperties: false
}

const STATUS_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    threadId: {
      type: 'string',
      description:
        'Thread id returned by cio_orchestrate_dispatch or cio_orchestrate_continue, or one of the ids this conversation dispatched. Omit it to list every thread this conversation dispatched, with their ids and current settings.'
    },
    projectId: {
      type: 'string',
      description:
        'Project the thread belongs to, when you know it. Omit to resolve the thread by its id alone.'
    }
  },
  additionalProperties: false
}

const CONTINUE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    threadId: {
      type: 'string',
      description:
        'The existing thread to continue, from cio_orchestrate_dispatch, cio_orchestrate_status, or the message that reported it. Never create a new thread to say one more thing to work you already dispatched.'
    },
    prompt: {
      type: 'string',
      description:
        'The follow-up instruction the thread receives, self-contained and written as if the user typed it into that thread. Omit it only to change how the thread runs before its next turn.'
    },
    harnessId: {
      type: 'string',
      description:
        'Exact harness id from cio_orchestrate_targets, to move this thread onto another harness. Requires providerId and modelId.'
    },
    providerId: {
      type: 'string',
      description: 'Exact provider id from the new harness catalog. Requires harnessId and modelId.'
    },
    modelId: {
      type: 'string',
      description: 'Exact model id from the new provider. Requires harnessId and providerId.'
    },
    accountId: {
      type: 'string',
      description:
        'Exact account id for the harness from cio_orchestrate_targets. Omit to keep the account the thread already uses for that harness.'
    },
    thinkingLevel: {
      type: 'string',
      enum: [...THINKING_LEVEL_ORDER],
      description: 'New reasoning effort for this thread. Omit to keep the one it uses.'
    },
    inferenceMode: {
      type: 'string',
      enum: [...MODEL_PROFILE_INFERENCE_MODES],
      description: 'New speed tier. Omit to keep the one the thread uses.'
    },
    permissionLevel: {
      type: 'string',
      enum: [...MODEL_PROFILE_PERMISSION_LEVELS],
      description: 'New permission tier for this thread. Omit to keep the one it uses.'
    },
    ovenId: {
      type: 'string',
      description:
        'Exact Oven id from cio_orchestrate_targets, to move this thread onto another machine. Omit to keep the machine it runs on.'
    },
    ovenPath: {
      type: 'string',
      description:
        "Absolute workspace path on a new Oven. Omit to keep the thread's current checkout."
    }
  },
  required: ['threadId'],
  additionalProperties: false
}

const ANSWER_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['question', 'secret', 'permission'],
      description:
        'What the blocked thread is waiting for, exactly as this conversation was told when it stopped.'
    },
    requestId: {
      type: 'string',
      description: 'The request id from the message that told you this thread stopped.'
    },
    threadId: {
      type: 'string',
      description: 'The blocked thread id, from the same message. Never invent one.'
    },
    projectId: {
      type: 'string',
      description: 'The project the blocked thread lives in, from the same message.'
    },
    answers: {
      type: 'array',
      description:
        'kind "question": one entry per question, in the order they were asked. Each entry holds the answer the user gave for that question, as one or more strings (a single choice is a one-item array).',
      items: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    secrets: {
      type: 'array',
      description:
        'kind "secret": one entry per requested secret. The value itself never travels here: it stays in the vault and is read by the app.',
      items: {
        type: 'object',
        properties: {
          secretId: { type: 'string', description: 'The secret id the blocked thread asked for.' },
          environmentVariable: {
            type: 'string',
            description:
              'The variable you collected this value under with cio_ask_secret, in this conversation.'
          }
        },
        required: ['secretId', 'environmentVariable'],
        additionalProperties: false
      }
    },
    permission: {
      type: 'string',
      enum: ['once', 'always', 'reject'],
      description: 'kind "permission": the decision the user gave.'
    }
  },
  required: ['kind', 'requestId', 'threadId', 'projectId'],
  additionalProperties: false
}

export const ORCHESTRATION_TOOLS: GatewayToolDefinition[] = [
  {
    name: ORCHESTRATION_TARGETS_TOOL_NAME,
    description:
      "Read the CodeInOven workstation: every project with its id, every assistant with its id and what it is for, the Ovens (machines) and which harnesses each one has installed, the harness catalog, the model catalogs with the thinking levels each model offers, the saved model profiles, and the accounts per harness with the one the app marks as default. Each account also carries its remaining subscription capacity when the user allows it to be seen. When accounts carry no capacity the user has turned that off: run on this thread's own account and model, and inherit the same for sub-agents, instead of hunting for another account. Call this before cio_orchestrate_dispatch: it is the only source of the exact ids a dispatch accepts. Its results also carry the current project, the default Oven and the default harness, so a request that names none of them still has a real value to propose and confirm with the user.",
    inputSchema: TARGETS_INPUT_SCHEMA,
    outputSchema: ORCHESTRATION_RESULT_SCHEMA,
    route: '/orchestrate-targets',
    sentWhen: 'An @cio-hey turn, before dispatching work to a machine or a model'
  },
  {
    name: ORCHESTRATION_DISPATCH_TOOL_NAME,
    description:
      'Start real work from this conversation, on another assistant or in a project. Pass `assistantId` from cio_orchestrate_targets for research, ideas, writing and tasks that belong to an assistant; pass `projectId` for coding and other work in a repository. The thread is created with the first prompt already in it, so the user never sees an empty thread, and it appears in the sidebar like any other. Omit harnessId, providerId and modelId to run on the model this conversation is already using, which is the right default; name them only when the user asked for another model, thinking level, account or Oven. Use only exact ids read from cio_orchestrate_targets. Use this only for new work: to add to a thread this conversation already dispatched, or to change its model, thinking level, harness or permission level, call cio_orchestrate_continue instead. The call returns as soon as the run is accepted: do not block, and do not claim the work is finished. An assistant answers here under its own name; a project run reports its outcome here when it settles.',
    inputSchema: DISPATCH_INPUT_SCHEMA,
    outputSchema: ORCHESTRATION_RESULT_SCHEMA,
    route: '/orchestrate-dispatch',
    sentWhen: 'An @cio-hey turn once every dispatch field is resolved or confirmed'
  },
  {
    name: ORCHESTRATION_ANSWER_TOOL_NAME,
    description:
      'Hand the user\'s decision back to a dispatched thread that stopped to ask for it. Use the ids from the message that told you the thread stopped, and the answer the user gave in this conversation, never one you chose for them. A question takes `answers`; a secret takes `secrets` naming the vault variable you collected it under, so the value never enters a conversation; a permission takes "once", "always" or "reject". The blocked thread continues on its own once the answer is accepted.',
    inputSchema: ANSWER_INPUT_SCHEMA,
    outputSchema: ORCHESTRATION_RESULT_SCHEMA,
    route: '/orchestrate-answer',
    sentWhen:
      'A dispatched thread stopped on a question, a secret or a permission and the user answered here'
  },
  {
    name: ORCHESTRATION_CONTINUE_TOOL_NAME,
    description:
      'Continue a thread this conversation already dispatched: send it a follow-up instruction, and/or change how it runs (harness, model, thinking level, account, permission tier, machine). The thread keeps its own history and its id, so nothing has to be started over. Use this every time the user adds to work already in flight or settled, or asks that a dispatched thread change model, thinking level, harness or permission level. Only call cio_orchestrate_dispatch when the user wants genuinely new work. A change made while the thread is running applies to its next turn, and the follow-up steers the live turn.',
    inputSchema: CONTINUE_INPUT_SCHEMA,
    outputSchema: ORCHESTRATION_RESULT_SCHEMA,
    route: '/orchestrate-continue',
    sentWhen:
      'The user adds to work already dispatched, or asks to change how an existing dispatched thread runs'
  },
  {
    name: ORCHESTRATION_STATUS_TOOL_NAME,
    description:
      "Read one dispatched thread's status, latest result and current settings by its id. Use it for a follow-up question about work already dispatched. Omit threadId to list every thread this conversation dispatched, with their ids, titles, statuses and the model, thinking level and permission tier each one runs with: that list is where the threadId for cio_orchestrate_continue comes from.",
    inputSchema: STATUS_INPUT_SCHEMA,
    outputSchema: ORCHESTRATION_RESULT_SCHEMA,
    route: '/orchestrate-status',
    sentWhen: 'An @cio-hey follow-up about work already dispatched'
  }
]
