import { isQuotedMentionPosition } from '../../lib/mention-context'

/**
 * The explicit design-session tag.
 *
 * A design session is user-started, never discovered: the user types
 * `@cio-design` (or picks `/cio-design`) and says what to design, exactly the
 * way `@cio-utility` starts a setup turn. What the tag grants is the app-owned
 * design capability (`cio:design`) as an *active* capability for the turn, so
 * the playbook is already in context and its `preview` operation is callable
 * without a search and an activation round trip. The user asked for a design;
 * making them watch the agent discover the tool that designs would be a bug.
 *
 * The session then continues for the rest of the thread: a later turn gets the
 * shorter continuation contract instead of the full briefing, and the design
 * capability stays active, because a design is edited over many messages rather
 * than produced in one.
 */

/** Stable built-in tag that opens a design session on an explicit turn. */
export const CIO_DESIGN_TAG = '@cio-design'

const CIO_DESIGN_TAG_PATTERN = /(^|\s)@cio-design(?=\s|$|[.,:;!?])/giu

/**
 * Whether this text opens a design session.
 *
 * A tag inside a quote or a blockquote is a mention of the tag rather than an
 * invocation of it, which is what keeps documentation about `@cio-design` from
 * starting a session. Shared with the utility tag through
 * `isQuotedMentionPosition` so both tags agree on what counts as quoting.
 */
export function isCioDesignRequest(text: string): boolean {
  for (const match of text.matchAll(CIO_DESIGN_TAG_PATTERN)) {
    const mentionStart = (match.index ?? 0) + (match[1]?.length ?? 0)
    if (!isQuotedMentionPosition(text, mentionStart)) return true
  }
  return false
}

/** Which design contract a turn carries: none, the first one, or a continuation. */
export type DesignSessionMode = 'off' | 'start' | 'continue'

/**
 * The first turn of a design session.
 *
 * Short on purpose: the design pass, the folder and the preview operation all
 * arrive with the capability's own playbook, so this only has to say how to run
 * the session and what the user is watching.
 */
export const CIO_DESIGN_TURN_PROMPT = `CodeInOven design session

The user opened this turn with @cio-design, so this is a design session. The
app-owned design capability is already active for it: its playbook is in your
context and its preview operation is callable now. Design is the work of this
turn, not a preliminary to it.

How to run the session:

1. Establish what the design is for before writing markup. Read whatever the
   user attached, named or pasted, and read the project. Ask one focused
   question only when a missing detail would change the design; otherwise pick
   the most plausible reading and say which one you picked.
2. A project with nothing in it is the normal case, not a problem. No framework,
   no package.json, no components: the design is plain HTML, CSS and JavaScript,
   and the preview serves it as it is.
3. Write the first screen, then preview it immediately. Do not save the preview
   for the end: the user is watching that tab, and seeing the design appear and
   change is the point of the session. Preview again after each round of edits.
4. Check the result yourself before you describe it: screenshot it, look at a
   phone width and a desktop width, and read the console for failed requests and
   runtime errors.
5. Reuse what the project already has when it has anything: its components,
   tokens, fonts and copy. A second visual language invented beside an existing
   one is a defect, not a design.
6. When the design needs something you cannot produce with your own tools, say
   so plainly and name what would produce it. Never leave a placeholder where
   the user asked for real content, and never present generated or placeholder
   content as the real thing.
7. Report in the user's terms: what a viewer sees, what they can try, the folder
   the design lives in, and the URL that shows it. If a decision was a guess,
   say which one and what would settle it.`

/** Every later turn of the same session. */
export const CIO_DESIGN_CONTINUE_PROMPT = `This thread's design session continues: the user opened it with @cio-design, and the design capability stays active. Keep working in the same design folder and keep the same preview tab current, previewing after each round of changes rather than at the end. Report what changed and what a viewer can now try.`
