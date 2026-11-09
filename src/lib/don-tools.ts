import type { GatewayToolDefinition } from './gateway-tools'

/**
 * The app-owned tools Don, the orchestrator, works with beyond dispatching work.
 *
 * Starting work is the orchestration tool's job, shared with every agent that
 * may dispatch, so there is one place that knows about projects, assistants,
 * models and Ovens. What remains here is Don's own bookkeeping: the name the user
 * asked to be called, and the one line an assistant may say inside the group
 * chat while it works. They travel through the same utility gateway every other
 * app-owned tool uses, so the Pi extension, the generated MCP server and the
 * main-process bridge stay in step from this one list.
 *
 * The gate is the gateway's, not prose's: the name tool is placed only on a turn
 * whose thread is Don's, and the reply tool only on a turn started from a group
 * chat. A turn without that flag cannot reach the route.
 */

/** Read or store what the user asked Don to call them. */
export const DON_USER_NAME_TOOL_NAME = 'cio_user_name'
/**
 * Say something in the group chat this conversation is part of, while the work
 * is still running, under this assistant's own name and mark.
 */
export const GROUP_CHAT_REPLY_TOOL_NAME = 'cio_reply_in_chat'

/** Every Don tool name, for the gateway gate and the extension. */
export const DON_TOOL_NAMES: readonly string[] = [
  DON_USER_NAME_TOOL_NAME,
  GROUP_CHAT_REPLY_TOOL_NAME
]

/** Whether a gateway tool name belongs to Don's own tools. */
export function isDonTool(name: string): boolean {
  return DON_TOOL_NAMES.includes(name)
}

/** The single operation a Don tool call names. */
export type DonToolOperation = 'user-name' | 'reply-in-chat'

/** Read the operation a tool name stands for. */
export function donToolOperation(name: string): DonToolOperation | null {
  if (name === DON_USER_NAME_TOOL_NAME) return 'user-name'
  if (name === GROUP_CHAT_REPLY_TOOL_NAME) return 'reply-in-chat'
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

const GROUP_CHAT_REPLY_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description:
        'What to say in the group chat, in your own words, one short message. It is shown to the person who asked for the work.'
    }
  },
  required: ['text'],
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
    name: GROUP_CHAT_REPLY_TOOL_NAME,
    description:
      'Say something in the group chat this conversation was started from, while your work is still running. Use it as soon as you have your first useful answer or a short progress line, so the person who asked is not left waiting in silence, and again when a step changes what you found. Your message appears under your own name and mark, exactly like a reply in a chat. This is not the final answer: when the work ends, your result is delivered on its own, so do not use this tool to restate it. Never use it outside a group chat.',
    inputSchema: GROUP_CHAT_REPLY_INPUT_SCHEMA,
    outputSchema: DON_RESULT_SCHEMA,
    route: '/group-chat-reply',
    sentWhen:
      'A conversation started from a group chat, when the assistant has something useful to say before finishing'
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
