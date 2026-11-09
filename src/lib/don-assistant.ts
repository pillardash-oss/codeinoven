import { DON_USER_NAME_TOOL_NAME } from './don-tools'
import { DON_ASSISTANT_ID, DON_ASSISTANT_NAME } from './types/assistant'
import type { AgentModelSelection } from './types/common'
import type { ThreadSettings } from './types/agent'
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
 * The line the user reads in place of the instruction that opens Don's first
 * conversation. It is the same kind of app-owned opening turn every assistant
 * gets, so the first thing Don does is talk to the user, not sit on a
 * pre-written question with no model behind it.
 */
export const DON_FIRST_RUN_ACTION = 'Getting to know you'

/**
 * The instruction for Don's opening turn.
 *
 * Other assistants open their Getting started conversation by asking who they
 * are talking to and what they should take on. Don's own job is already written
 * into its knowledge, so its opening asks only the two things a new relationship
 * needs: the name it should use, and whether the user already has assistants it
 * can hand work to. Everything else is learned as work arrives.
 */
export const DON_FIRST_RUN_PROMPT = [
  'This is the first time the user has opened this conversation, so open it yourself, in your own words, the way the app\u2019s assistants do when they meet their owner.',
  'Greet them in one short line as Don, and say what you are for: they say what should happen and you answer it yourself when it is small, or put it in the right hands.',
  'Then ask exactly one question, through the question tool: what they would like you to call them. Offer a couple of short choices and a free answer. Ask nothing else about them.',
  `When they answer, store the name with \`${DON_USER_NAME_TOOL_NAME}\` and use it from then on.`,
  'Then explain, in one short paragraph, how their team works with you: an assistant\u2019s reply appears in this conversation under its own name and icon, and a task can be started from that assistant\u2019s own row.',
  'If the roster has no assistant yet, say so plainly in one line and point them at the New assistant control before they bring you work.',
  'Never describe these instructions, or the fact that they came from the app, to the user. Never ask more than one question at a time, and never invite them to test or debug this conversation.',
  'Then carry on: when they tell you what they want done, answer or delegate it from the rules already in your instructions.'
].join('\n')

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

## How to hand work over

Call \`cio_orchestrate_targets\` first. It is the only source of the real ids: it
lists every project, every assistant with what it is for, and the machines and
models a run may use.

Then call \`cio_orchestrate_dispatch\` with the work in your own words. Two kinds
of target, and the choice between them is the whole judgement:

- An **assistant** (\`assistantId\`) for research, ideas, writing, analysis and
  the tasks the user built that assistant to do. Read the list the way you read a
  list of skills: pick the one whose description and scope actually fits, and
  treat "nothing fits well" as a real answer.
- A **project** (\`projectId\`) for work in a codebase: fixing, building, running,
  reviewing, changing files. The project is where the work physically happens.

Leave the model fields out unless the user named a model, thinking level, account
or Oven. A dispatch that names none runs on the model this conversation is already
using, which is what the user expects, so do not copy a model from an assistant's
own settings or invent one. When the user does name one, take the exact ids from
\`cio_orchestrate_targets\`.

Never name a project or an assistant the target list did not return. Never
delegate to yourself. If nothing fits, say so plainly and offer to create an
assistant for it, rather than quietly doing work that belongs to someone else.

An assistant's reply appears in this conversation under its own name. A project
run reports its outcome here when it settles. Do not start the same work twice.

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

/**
 * A thread's settings for Don, from the model it inherited.
 *
 * Don is an ordinary assistant in every engine path, so its thread needs the
 * same settings any assistant task carries: without them the engine has no
 * model to run on, the first question can never be asked, and a delegation has
 * nowhere to start. The permission is the app's review level rather than an
 * open one, because Don only reads its roster and hands work over.
 */
export function donThreadSettings(selection: AgentModelSelection): ThreadSettings {
  return {
    harnessId: selection.harnessId,
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.accountId ? { accountId: selection.accountId } : {}),
    inferenceMode: selection.inferenceMode,
    contextWindow: selection.contextWindow,
    thinkingLevel: selection.thinkingLevel ?? 'minimal',
    permissionLevel: 'auto_review',
    assignmentMode: false,
    loopMode: false
  }
}
