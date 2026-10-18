/**
 * The hidden prompt the app posts into an assistant's Getting started thread once
 * its knowledge is saved.
 *
 * The user never picks fallback models up front   the primary is the model they
 * were already working on. This turn is how they learn the rest of the setup
 * exists, and the call to action it leads with depends on how the assistant runs:
 *
 * - an assistant on a clock leads with fallback models, because an unattended run
 *   that dies on a model limit is the failure the user will never see;
 * - an assistant that runs only when asked leads with starting a task, because
 *   nothing happens until the user gives it one.
 *
 * Both variants say the same thing about this thread: it is where the assistant is
 * taught and reshaped, never where a task is run. A task belongs in a new one, and
 * the agent is told to point at the app's own new-task affordance.
 */

/** The opening line every next-steps turn carries, and what identifies it. */
const NEXT_STEPS_LEAD =
  'The assistant knowledge is saved. This confirms storage, not connection readiness. Do not call any tools and do not start the assistant.'

const NEXT_STEPS_SHARED = [
  'Reply with a short "Next steps" message in plain prose for the user, a few sentences or a compact list.',
  '- If a required connection is still unresolved, say setup is incomplete and name the specific remaining sign-in or approval. Tell the user to continue in this Getting started conversation so the assistant can finish setup itself. Never send the user to Connections or Utilities to configure services manually, and never describe an unverified assistant as ready.',
  '- This Getting started thread is where the user teaches the assistant and changes what it knows, not where work is run, so never invite them to give it a task by sending a message here.'
].join('\n')

const NEXT_STEPS_SCHEDULED = [
  NEXT_STEPS_LEAD,
  NEXT_STEPS_SHARED,
  '- Lead with adding one or two fallback models to this assistant on the Agents tab of the assistant panel, so a model that fails or hits its limit never stops a scheduled run.',
  '- Then anything else worth checking before the first run, such as the schedule or a test run from the panel.',
  'Do not repeat the knowledge and do not re-present the recap. Keep it brief and friendly.'
].join('\n')

const NEXT_STEPS_ON_DEMAND = [
  NEXT_STEPS_LEAD,
  NEXT_STEPS_SHARED,
  '- Lead with how the user starts something with the assistant: the New task button in the app header, or Cmd/Ctrl+N. A new task is where the assistant is given work and where its runs appear.',
  '- Then anything else worth checking before the first run, such as a test run from the panel.',
  'Do not repeat the knowledge and do not re-present the recap. Keep it brief and friendly.'
].join('\n')

/**
 * The next-steps turn for one assistant. A scheduled assistant is told to lead
 * with fallbacks; one that runs on demand is told to lead with starting a task.
 */
export function assistantNextStepsPrompt(scheduled: boolean): string {
  return scheduled ? NEXT_STEPS_SCHEDULED : NEXT_STEPS_ON_DEMAND
}

/**
 * Whether a turn is the app's own next-steps message. It is sent right after a
 * knowledge is saved, and it is the one internal assistant turn that must never be
 * treated as an assistant run, so the engine never attaches the run contract to it.
 *
 * Both variants are matched by identity: the prompt is app-built from fixed parts,
 * so an exact comparison is what keeps a user message out, and a leading-line check
 * would accept text the user could type.
 */
export function isAssistantNextStepsPrompt(text: string): boolean {
  return text === NEXT_STEPS_SCHEDULED || text === NEXT_STEPS_ON_DEMAND
}
