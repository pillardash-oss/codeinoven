/**
 * The hidden prompt the app posts into a routine's Getting started thread once
 * its how-to is saved.
 *
 * The user never picks fallback models up front   the primary is the model they
 * were already working on. This turn is how they learn the rest of the setup
 * exists: the agent replies with a short prose next-steps list, led by adding
 * fallbacks, and is told to touch no tools so the turn can never start a run.
 */
export const ROUTINE_NEXT_STEPS_PROMPT = [
  'The routine is saved. Do not call any tools and do not start the routine.',
  'Reply with a short "Next steps" message in plain prose for the user, a few sentences or a compact list. Cover:',
  '- Adding one or two fallback models to this routine on the Agents tab of the routine panel, so a model that fails or hits its limit never stops the routine.',
  '- Connecting any service the routine needs that is not connected yet, from the Connections tab or the Utilities page.',
  '- Anything else worth checking before the first run, such as the schedule or a test run from the panel.',
  'Do not repeat the how-to and do not re-present the recap. Keep it brief and friendly.'
].join('\n')
