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
/**
 * Hire the teammate a request needs when nothing on the roster was built for it.
 *
 * The assistant is created here, with the work already waiting in its Getting
 * started conversation, so the user never leaves this chat to go and make one by
 * hand. That is the whole point of the orchestrator: it can build the team it
 * needs instead of reporting that the team is missing.
 */
export const DON_CREATE_ASSISTANT_TOOL_NAME = 'cio_create_assistant'
/**
 * Answer a question a teammate's run is blocked on, in that teammate's own thread.
 *
 * The question belongs to the work, not to the person: Don settles what it can so
 * the team keeps moving. A credential is the one exception, because only the user
 * can supply it.
 */
export const DON_ANSWER_TEAMMATE_TOOL_NAME = 'cio_answer_teammate'

/** Every Don tool name, for the gateway gate and the extension. */
export const DON_TOOL_NAMES: readonly string[] = [
  DON_USER_NAME_TOOL_NAME,
  GROUP_CHAT_REPLY_TOOL_NAME,
  DON_CREATE_ASSISTANT_TOOL_NAME,
  DON_ANSWER_TEAMMATE_TOOL_NAME
]

/** Whether a gateway tool name belongs to Don's own tools. */
export function isDonTool(name: string): boolean {
  return DON_TOOL_NAMES.includes(name)
}

/** The single operation a Don tool call names. */
export type DonToolOperation =
  'user-name' | 'reply-in-chat' | 'create-assistant' | 'answer-teammate'

/** Read the operation a tool name stands for. */
export function donToolOperation(name: string): DonToolOperation | null {
  if (name === DON_USER_NAME_TOOL_NAME) return 'user-name'
  if (name === GROUP_CHAT_REPLY_TOOL_NAME) return 'reply-in-chat'
  if (name === DON_CREATE_ASSISTANT_TOOL_NAME) return 'create-assistant'
  if (name === DON_ANSWER_TEAMMATE_TOOL_NAME) return 'answer-teammate'
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

const CREATE_ASSISTANT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'The name to give the new teammate, short and human. Use the name the user said; invent one in the same spirit only when they gave none.'
    },
    purpose: {
      type: 'string',
      description:
        'What this teammate is for, in one or two sentences: the kind of work it owns, so its instructions and its row read plainly later.'
    },
    request: {
      type: 'string',
      description:
        "The work that is waiting for it, in the user's own words and with the detail they gave. It is carried into the new assistant's first conversation, so nothing has to be explained twice."
    }
  },
  required: ['name', 'purpose'],
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

const ANSWER_TEAMMATE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    threadId: {
      type: 'string',
      description:
        'The thread of the teammate whose run is waiting, exactly as the question names it.'
    },
    requestId: {
      type: 'string',
      description: 'The question request id, exactly as the question names it.'
    },
    answers: {
      type: 'array',
      description:
        'One entry per question, in the order the question asks them. Each entry is the answer you chose, as a single-item array holding exactly one answer text from the options offered, or your own wording when the question allows a custom answer.',
      items: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    note: {
      type: 'string',
      description:
        "One short line for the user, in your own words, saying what you decided and why. It is written into this conversation under the teammate's name."
    }
  },
  required: ['threadId', 'requestId', 'answers'],
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
    name: DON_CREATE_ASSISTANT_TOOL_NAME,
    description:
      'Create the teammate this request needs, and only after the roster has answered. Read cio_orchestrate_targets on this turn and check every assistant first: hire only when the request is assistant-category work and not one assistant fits it, never when one plausibly fits, never for codebase work that belongs to a project, and never when the user has asked you not to create assistants. It gives the assistant the name and purpose you chose, and the new teammate writes its own instructions and takes the waiting request without interviewing anyone. The teammate introduces itself in this conversation under its own name the moment it exists, and anything it needs to ask reaches this conversation for you to settle. Say one line afterwards naming who was created and that the work is already with them.',
    inputSchema: CREATE_ASSISTANT_INPUT_SCHEMA,
    outputSchema: DON_RESULT_SCHEMA,
    route: '/don-create-assistant',
    sentWhen: "Don's thread, when the request needs work no existing assistant was built for"
  },
  {
    name: DON_ANSWER_TEAMMATE_TOOL_NAME,
    description:
      "Answer the question a teammate's run is waiting on, so the work continues without the user. Use it whenever a teammate stops on a question about how the work should be done, what to prefer, which option to pick or what something means: those are yours to decide. Fill the answers in the order the question asks them, using one of the offered options word for word. A capability the app offered to install is settled the same way, and never by accepting the install: decline it when the work does not need it, or answer in your own words telling the teammate how to finish with what the app already has. Never use it for a credential, a login, an OAuth or MCP sign-in, or a connected account: only the user can supply those, so say one line about what you need with cio_reply_in_chat and leave the card for them.",
    inputSchema: ANSWER_TEAMMATE_INPUT_SCHEMA,
    outputSchema: DON_RESULT_SCHEMA,
    route: '/don-answer-teammate',
    sentWhen: "Don's thread, when a teammate's run stops on a question Don can settle"
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
