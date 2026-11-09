import type { GatewayToolDefinition } from './gateway-tools'

/**
 * The app-owned tools Don, the orchestrator, works with.
 *
 * Don's whole job is to put work in the right hands, and these two calls are how
 * it does that: `cio_delegate` reads the assistants the app holds and then hands
 * the request to the one that fits, and `cio_user_name` reads or stores what the
 * user asked to be called. They are transported by the same utility gateway every
 * other app-owned tool uses, so the Pi extension, the generated MCP server and the
 * main-process bridge stay in step from this one list.
 *
 * The gate is the gateway's, not prose's: the tools are placed only on a turn whose
 * thread is Don's, and a turn without that flag cannot reach a route that is not
 * there. That is what stops every other assistant from delegating to its
 * siblings.
 */

/** Read the assistants the app holds, then hand the request to one of them. */
export const DON_DELEGATE_TOOL_NAME = 'cio_delegate'
/** Read or store what the user asked Don to call them. */
export const DON_USER_NAME_TOOL_NAME = 'cio_user_name'

/** Every Don tool name, for the gateway gate and the extension. */
export const DON_TOOL_NAMES: readonly string[] = [DON_DELEGATE_TOOL_NAME, DON_USER_NAME_TOOL_NAME]

/** Whether a gateway tool name belongs to Don's own tools. */
export function isDonTool(name: string): boolean {
  return DON_TOOL_NAMES.includes(name)
}

/** The single operation a Don tool call names. */
export type DonToolOperation = 'delegate' | 'user-name'

/** Read the operation a tool name stands for. */
export function donToolOperation(name: string): DonToolOperation | null {
  if (name === DON_DELEGATE_TOOL_NAME) return 'delegate'
  if (name === DON_USER_NAME_TOOL_NAME) return 'user-name'
  return null
}

/**
 * The result shape every Don operation answers with.
 *
 * Deliberately open: the gateway must never reshape a result a handler produced,
 * and a harness that runs scripts reads real fields from it.
 */
const DON_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true
}

const DELEGATE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    request: {
      type: 'string',
      description:
        'The work to hand over, in your own words, self-contained: the assistant receives it as the whole task and cannot see this conversation. Omit only when you are calling to read the roster.'
    },
    assistantId: {
      type: 'string',
      description:
        'Exact assistant id from the roster this tool returns when you call it without one. Omit to read the roster instead of delegating.'
    }
  },
  additionalProperties: false
}

const USER_NAME_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'The name to remember. Omit to read the current name and change nothing. Only pass this with a name the user actually gave you.'
    }
  },
  additionalProperties: false
}

export const DON_TOOLS: GatewayToolDefinition[] = [
  {
    name: DON_DELEGATE_TOOL_NAME,
    description:
      'Put work in the right hands. Called with no assistantId it returns the assistants this user has, each with its name, description, whether it is ready to run and the id to use; read them the way you read a list of skills and pick the one whose description actually fits. Called with an assistantId and the request it starts that assistant on its own thread, and its reply appears in this conversation under its own name and icon. Never name an assistant the roster did not return, and never delegate to yourself. The call returns as soon as the work is accepted: do not wait for it and do not claim it is finished.',
    inputSchema: DELEGATE_INPUT_SCHEMA,
    outputSchema: DON_RESULT_SCHEMA,
    route: '/don-delegate',
    sentWhen: "A request on Don's thread that needs real work rather than a direct answer"
  },
  {
    name: DON_USER_NAME_TOOL_NAME,
    description:
      'Read or store what the user asked to be called. It is what their own messages are labelled with in this thread. Called with no name it answers with the current name, or that there is none. Called with a name it stores it. Only store a name the user gave you: never invent one, and never ask twice.',
    inputSchema: USER_NAME_INPUT_SCHEMA,
    outputSchema: DON_RESULT_SCHEMA,
    route: '/don-user-name',
    sentWhen: "Don's thread, when the user answers how they should be addressed"
  }
]
