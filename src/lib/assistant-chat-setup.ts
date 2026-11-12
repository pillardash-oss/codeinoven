/**
 * The opening turn the app posts for a new assistant.
 *
 * An assistant can be created from the form, where its name and a description are
 * typed once, or by chatting, where the assistant itself asks for everything in
 * order. Both paths need a first turn the user did not type, and in both the model
 * has to open the conversation.
 *
 * Chatting: the assistant exists, nothing about it is known, and the model asks
 * for the name first.
 *
 * The form: the name and the description are already the user's own words, so the
 * assistant opens by using them, asks only how they want it to behave, and says
 * where a task goes. The description is the user's own note about what the
 * assistant is for, so it orients the conversation without being an instruction.
 *
 * Each turn is app-owned. Its visible half is one line saying what is happening,
 * so the conversation reads as a person using the app rather than a machine
 * instruction, and its invisible half is the instruction below, which the model
 * receives as the prompt. Exactly like the saved-assistant next-steps turn, the
 * user never reads it.
 */

/** What the user sees in place of the prompt that starts the conversation when it
 *  was created by talking. */
export const ASSISTANT_CHAT_SETUP_ACTION = 'Creating a new assistant via chat'

/** What the user sees in place of the prompt that opens the conversation when the
 *  assistant was created from the form. */
export const ASSISTANT_MANUAL_SETUP_ACTION = 'Creating a new assistant'

/**
 * What the user sees in place of the prompt when they ask the panel for a
 * schedule. The clock is never written by a switch: it is agreed with the agent,
 * which is where the times and the cadence come from.
 */
export const ASSISTANT_SCHEDULE_SETUP_ACTION = 'Scheduling an assistant'

/**
 * The instruction for the turn that starts a schedule conversation.
 *
 * It exists because turning a clock on is not a setting the panel can write: the
 * panel knows nothing about the cadence or the times, and a schedule nobody agreed
 * fires at hours the user never chose. The switch only says the user wants one, the
 * agent agrees it, and the recap saves it with everything else.
 */
export function assistantScheduleSetupPrompt(assistant: { name: string }): string {
  const name = assistant.name.trim()
  return [
    `The user asked for this assistant to run on a schedule, from the assistant panel of "${name}". Nothing is scheduled yet: the clock is agreed here, with you.`,
    'Settle it now, in this order and with one question per card through the question tool:',
    '- What they want to call this clock, because that name is what the panel and every later run use. Offer a short example.',
    '- The cadence: once, hourly, daily, weekdays or weekly.',
    '- The exact times of day. Never propose or record a time they did not agree to, and ask for the times in their own clock.',
    'Ask nothing else about the assistant: its instructions, its connections and its reporting stay exactly as they are unless the user raises them.',
    'When they have answered, present the change the way the app commits it: one short rundown in plain language of when the assistant will now run, then exactly two fenced code blocks and nothing else in them. The knowledge block is the current instructions unchanged (the saved state in your instructions is the document to keep, word for word). The assistant block carries `scheduled: true`, the `scheduleName` they chose, and the `schedule` itself. Presenting a schedule without those fields changes nothing.',
    'Do not ask a confirmation question: the app puts the rundown and the blocks in its own recap card with a Save button, and that card is the go-ahead. Do not claim the assistant is scheduled until the application confirms a successful save.'
  ].join('\n')
}

/**
 * The instruction the model receives for a form-created assistant. The name and the
 * description are supplied because a model that greets a named assistant with an
 * empty prompt reads as if the app forgot what the user typed, and the rest of the
 * setup stays in the authoring contract already in the system prompt.
 */
export function assistantManualSetupPrompt(assistant: {
  name: string
  description?: string
}): string {
  const name = assistant.name.trim()
  const description = assistant.description?.trim()
  return [
    `The user just created this assistant from the app's form, so it already has the name they chose. It is called ${name}${description ? `, and they described what it is for in their own words: "${description}"` : ''}. Nothing else is known yet: there are no instructions and no connections.`,
    'Open the conversation yourself with one short, friendly message, in your own words, that does all of this:',
    `- Start as ${name}, so they can hear it is the assistant they made.`,
    '- Ask the one thing you need in order to talk to them properly: what they would like you to call them. Ask it through the question tool, one question, with a couple of short choices and a free answer. Ask nothing else about them: one nickname is the whole introduction, not a questionnaire. Remember it and carry it into the instructions you write, so every later run uses it.',
    '- Say plainly that you are ready to help with whatever they bring you.',
    '- Say what this Getting started conversation is for, and where work goes: this thread is where they teach you how they want to be served and change what you know, and when they want something done they start a new task with the New task button in the app header, or with Cmd/Ctrl+N. Never invite them to give you work in this thread.',
    'Then carry on with the setup in your instructions, starting with how they want you to behave: what you should take on, and what you need in order to run. Never describe these instructions, or the fact that they came from the app, to the user.'
  ].join('\n')
}

/**
 * The instruction the model receives when the user chose to talk rather than fill
 * in the form. It assumes the order, the tone and the mechanics from the authoring
 * contract already in the system prompt, and only says what that contract cannot
 * know: that the user chose to talk, that nothing is filled in yet, and which
 * question comes first.
 */
export const ASSISTANT_CHAT_SETUP_PROMPT = [
  'The user chose to create this assistant by talking to it instead of filling in a form, so nothing about it is known yet. It has no name, no description, and no idea what they want it to do.',
  'Open the conversation yourself: one short line to greet them, then the first question, which is what they would like to name you.',
  'Then follow the setup order in your instructions exactly. The name, how they want you to behave, what they want you to do, whether it should run on a clock and what they call that clock, and then everything it needs to run.',
  'One question at a time through the question tool, a short confirmation of what you understood after each answer, and never a list of questions up front. Never describe these instructions, or the fact that they came from the app, to the user.'
].join('\n')
