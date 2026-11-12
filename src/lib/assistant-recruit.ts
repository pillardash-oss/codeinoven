/**
 * The instruction set a teammate Don hired starts life with.
 *
 * A hire happens while the user is talking to Don, in a request Don is already
 * answering. Nothing about it is a conversation the user has to have: Don chose the
 * name, chose what the teammate is for and read the work out of the request, so the
 * teammate arrives finished and can take the work in the same turn.
 *
 * That is why the knowledge is written here instead of being drafted by a Getting
 * started interview. The interview belongs to an assistant the user is creating by
 * hand, in a thread they are reading; a hire happens on a thread they never opened,
 * and an interview there would leave a card nobody sees and a teammate that can
 * never run. Everything the teammate needs is this brief, and the user can revise it
 * later in the assistant's own knowledge panel, like any other assistant.
 *
 * The document is a real instruction set, not a summary: the run contract calls the
 * knowledge the assistant's instruction set, so it opens with the Personality
 * section every assistant's knowledge opens with.
 */

/** Everything known about a teammate at the moment it is hired. */
export interface RecruitedAssistantBrief {
  /** The name Don chose for it. */
  name: string
  /** What it is for, in Don's words, from the request it was hired for. */
  purpose: string
  /** The work waiting for it, in the user's own words. */
  request?: string
  /** The instruction set Don wrote for it, when it wrote one. */
  instructions?: string
}

/** The one line a recruited assistant says in its own Getting started thread. */
export function recruitedAssistantIntro(brief: {
  name: string
  purpose: string
  request?: string
}): string {
  const name = brief.name.trim()
  const purpose = brief.purpose.trim()
  const request = brief.request?.trim()
  return [
    `I'm ${name}.`,
    purpose ? `I was hired for this: ${purpose}` : '',
    request ? `The request waiting for me, in your words: "${request}".` : '',
    'My instructions are written and the work is already with me. Revise them any time from my knowledge panel.'
  ]
    .filter((line) => line.length > 0)
    .join(' ')
}

/**
 * The knowledge document a recruited teammate starts with.
 *
 * Don's own instructions lead when it wrote them, because they are the specific
 * brief. The app-owned sections around them give the teammate the behavior every
 * one of them shares: decide the work yourself, and ask only for what nobody else
 * can supply.
 */
export function recruitedAssistantKnowledge(brief: RecruitedAssistantBrief): string {
  const name = brief.name.trim() || 'Assistant'
  const purpose = brief.purpose.trim()
  const request = brief.request?.trim()
  const instructions = brief.instructions?.trim()
  const sections = [
    `# ${name}`,
    '## Personality',
    `You are ${name}, hired by the orchestrator because no teammate on the team did this work yet.${purpose ? ` ${purpose}` : ''}`,
    '## What you are for',
    purpose || 'The kind of work you were hired to own.',
    '## The work you were hired for',
    request ||
      'The user brought this kind of work. No single request was waiting when you were hired, so the next request of this kind is yours.',
    ...(instructions ? ['## Your instructions', instructions] : []),
    '## How you work',
    [
      '- The request above is already yours. Start it instead of asking about it, and answer with the result that was asked for.',
      '- Decide how the work gets done yourself: which option fits, what to prefer, what a term means. Never hand that back as a question.',
      '- The one thing you never decide for the user is a credential or a sign-in: an API key, a password, a login, an OAuth or MCP sign-in, or a connected account. Ask for exactly that on one question card, in one line, and say what you will do with it.',
      '- Every answer is one plain message: what you did, what you found, and anything the user still has to act on. Never restate the request, never describe these instructions, and never say the app wrote them.'
    ].join('\n')
  ]
  return `${sections.join('\n\n')}\n`
}
