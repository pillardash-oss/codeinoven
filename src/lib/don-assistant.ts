import { DON_ASSISTANT_ID, DON_ASSISTANT_NAME } from './types/assistant'
import type { AgentModelSelection } from './types/common'
import type { Assistant, AssistantAgents, CreateAssistantInput } from './types/assistant'

/**
 * Don, the app's orchestrator assistant.
 *
 * Don is the front door every conversation can reach without opening the
 * assistant view: the user says what they want, and Don either answers it
 * itself (a question it already knows) or hands it to the assistant whose
 * description and knowledge fit the request. Delegated work lands back in Don's
 * own group thread under the speaking assistant's name, so one thread reads as a
 * group chat between the user, Don and whoever took the job.
 *
 * This module owns everything that is Don's rather than the user's: its reserved
 * identity, the thread it lives on, the seeded greeting, and the instruction set
 * it runs on.
 */

/** Title of Don's one permanent thread. Never auto-titled. */
export const DON_THREAD_TITLE = 'Don'

/**
 * The greeting Don's thread opens with, once, when the app first seeds it.
 *
 * It is written as an ordinary assistant message rather than asked by a model
 * turn, so a fresh install does not spend a token before the user has said
 * anything, and so the question is on screen the first time the thread is
 * opened.
 */
export const DON_ADDRESS_QUESTION = 'How should I address you?'

/**
 * The instruction set Don runs on.
 *
 * It is the assistant's `knowledge`, so the existing prompt layers compose it
 * into every turn on Don's thread   nothing in the chat engine special-cases a
 * built-in assistant. Three rules do all the work: answer what it can, delegate
 * everything else, and say who took it.
 */
export const DON_KNOWLEDGE = `You are Don, the user's orchestrator.

You are the only assistant the user has to talk to directly. Everything else is
theirs, and yours is one job: put work in the right hands.

## Answer it yourself, or hand it over

Answer directly when the request is something you already know: a definition, a
fact, a short explanation, small talk, a question about how CodeInOven works. Keep
it brief and do not turn it into a task.

Delegate when the request needs work: research, reading or writing files, running
anything, checking something in a project, producing a document, watching for
changes later, or anything that will take more than a couple of sentences of
thinking. Do not do that work yourself. You are the orchestrator, not the worker.

## How to delegate

Call \`cio_delegate\` with the user's request in your own words. With no
\`assistant_id\` it returns the assistants you may delegate to, each with its name,
description and whether it is ready to run. Read them the way you would read a
list of skills: pick the one whose description and scope actually fits, and treat
"nothing fits well" as a real answer.

Then call it again with that \`assistant_id\` and the same request. The assistant
runs in its own thread, and its reply appears in this one under its own name.

Never name an assistant you were not given. Never delegate to yourself. If nothing
fits, say so plainly and offer to create an assistant for it, rather than quietly
doing work that belongs to someone else.

## What you say back

After delegating, one short line naming who took it and what they are doing. No
essay, no restating the request. The assistant's answer arrives on its own; you do
not need to summarise it, repeat it, or wait for it.

If a delegation cannot start (the assistant is not ready, paused or gone), say
which one and why in one line.

## Names

The user's own messages carry a name they chose. If you do not have it yet, ask
"${DON_ADDRESS_QUESTION}" and stop: nothing else in that turn. When they answer,
store it with \`cio_user_name\` and use it from then on. Never guess a name and
never ask twice.`

/**
 * The assistant row Don is seeded as, so the bootstrap has one definition of Don
 * rather than a literal spread across the manager and the IPC layer.
 *
 * The model comes from the caller: Don inherits the model the user was already
 * working on, exactly like an assistant created from a chat, so it can answer the
 * first time it is opened.
 */
export function donAssistantSeed(agents?: AssistantAgents): CreateAssistantInput {
  return {
    name: DON_ASSISTANT_NAME,
    description:
      'Your orchestrator. Tell Don what you want done and it puts the work in the right hands.',
    scheduled: false,
    knowledge: DON_KNOWLEDGE,
    connections: [],
    agents,
    builtin: true
  }
}

/** The reserved id Don's row is written under. */
export { DON_ASSISTANT_ID }
export const DON_ID = DON_ASSISTANT_ID

/** The model a built-in assistant runs on, when the caller resolved one. */
export function donPrimaryModel(assistant: Assistant | null): AgentModelSelection | undefined {
  return assistant?.agents?.primary
}
