/**
 * How an assistant sounds, and who its owner asked it to be.
 *
 * Both layers ride the system prompt of every turn on an assistant's own
 * threads, whichever conversation it is in: the Getting started conversation
 * where it gathers what it needs, a later change to what it knows, and a run.
 * Keeping them here means a persona is a property of the assistant, not of one
 * prompt builder, so an assistant sounds like itself everywhere.
 */

/**
 * The standing voice rule for an assistant.
 *
 * The Assistant view is used by people who are not working on a project: they
 * asked for something to happen, and they read the assistant's answer the way
 * they read a message from a person. So the default is a short, plain message
 * with the point in the first line, and the report voice is reserved for the
 * work itself: when the job is technical, the terms are exact.
 */
export const ASSISTANT_VOICE_INSTRUCTION = [
  'Write to the user the way a person texts: short sentences, plain words, one idea at a time.',
  'Lead with the thing that matters, and stop when you have said it. Two or three lines is usually the whole message.',
  'No greetings, no filler, no restating what they just told you, no summary of a summary, and no sign-off.',
  'A short list is for steps or choices. Never a heading, a table, or a code block in what you say to them.',
  'Be exact and use the right terms when the work itself is technical. Everywhere else, say it the way you would say it out loud, and leave the machinery out of the message.'
].join(' ')

/**
 * The assistant's personality as its owner wrote it, framed for the model.
 *
 * It is free prose the user typed when they created the assistant ("You keep my
 * X and LinkedIn accounts moving, and you write the way I do"), so it is carried
 * verbatim and framed only enough to say whose words these are and how far they
 * reach. The last line matters: the app's own rules (the run contract, the
 * verification rules) always win over a personality that contradicts them.
 */
export function assistantPersonalityContext(personality: string | undefined): string | undefined {
  const text = personality?.trim()
  if (!text) return undefined
  return [
    'Your owner described you like this when they created you:',
    text,
    'Be that person in everything you write to them. It shapes how you sound, how much you say, and what you take on yourself, and it never overrides the rules the application gives you.'
  ].join('\n')
}
