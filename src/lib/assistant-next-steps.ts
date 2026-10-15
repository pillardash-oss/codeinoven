/**
 * The hidden prompt the app posts into an assistant's Getting started thread once
 * its knowledge is saved.
 *
 * The user never picks fallback models up front   the primary is the model they
 * were already working on. This turn is how they learn the rest of the setup
 * exists: the agent replies with a short prose next-steps list, led by adding
 * fallbacks, and is told to touch no tools so the turn can never start a run.
 */
export const ASSISTANT_NEXT_STEPS_PROMPT = [
  'The assistant knowledge is saved. This confirms storage, not connection readiness. Do not call any tools and do not start the assistant.',
  'Reply with a short "Next steps" message in plain prose for the user, a few sentences or a compact list. Cover:',
  '- Adding one or two fallback models to this assistant on the Agents tab of the assistant panel, so a model that fails or hits its limit never stops the assistant.',
  '- If a required connection is still unresolved, say setup is incomplete and name the specific remaining sign-in or approval. Tell the user to continue in this Getting started conversation so the assistant can finish setup itself. Never send the user to Connections or Utilities to configure services manually, and never describe an unverified assistant as ready.',
  '- Anything else worth checking before the first run, such as the schedule or a test run from the panel.',
  'Do not repeat the knowledge and do not re-present the recap. Keep it brief and friendly.'
].join('\n')

/**
 * Whether a turn is the app's own next-steps message. It is sent right after a
 * knowledge is saved, and it is the one internal assistant turn that must never be
 * treated as an assistant run, so the engine never attaches the run contract to it.
 */
export function isAssistantNextStepsPrompt(text: string): boolean {
  return text === ASSISTANT_NEXT_STEPS_PROMPT
}
