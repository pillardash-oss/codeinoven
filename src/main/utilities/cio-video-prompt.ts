import { isQuotedMentionPosition } from '../../lib/mention-context'

/**
 * The explicit video-session tag.
 *
 * A video session is user-started, never discovered, exactly the way
 * `@cio-design` starts a design session and `@cio-utility` starts a setup turn:
 * the user types `@cio-video` (or picks `/cio-video`) and says what to make.
 * The tag promotes the app-owned video capability (`cio:video`) to an *active*
 * capability for the turn, so its playbook is already in context and its
 * `preview` and `capture` operations are callable without a search and an
 * activation round trip. A user who asked for a video should not watch the
 * agent hunt for the tool that makes one.
 *
 * The session continues for the rest of the thread: later turns get the shorter
 * continuation contract and the capability stays active, because an edit is
 * worked on over many messages rather than produced in one.
 */

/** Stable built-in tag that opens a video session on an explicit turn. */
export const CIO_VIDEO_TAG = '@cio-video'

const CIO_VIDEO_TAG_PATTERN = /(^|\s)@cio-video(?=\s|$|[.,:;!?])/giu

/**
 * Whether this text opens a video session.
 *
 * A tag inside a quote or a blockquote is a mention of the tag rather than an
 * invocation of it, which keeps documentation about `@cio-video` from starting
 * a session. Shared with the other tags through `isQuotedMentionPosition` so
 * every tag agrees on what counts as quoting.
 */
export function isCioVideoRequest(text: string): boolean {
  for (const match of text.matchAll(CIO_VIDEO_TAG_PATTERN)) {
    const mentionStart = (match.index ?? 0) + (match[1]?.length ?? 0)
    if (!isQuotedMentionPosition(text, mentionStart)) return true
  }
  return false
}

/** Which video contract a turn carries: none, the first one, or a continuation. */
export type VideoSessionMode = 'off' | 'start' | 'continue'

/**
 * The first turn of a video session.
 *
 * Short on purpose: the contract, the folder and both operations arrive with
 * the capability's own playbook, so this only has to say how to run the session
 * and what the user is watching.
 */
export const CIO_VIDEO_TURN_PROMPT = `CodeInOven video session

The user opened this turn with @cio-video, so this is a video session. The
app-owned video capability is already active for it: its playbook is in your
context and its preview and capture operations are callable now. Making this
video is the work of this turn, not a preliminary to it.

How to run the session:

1. Establish the brief before writing a frame: what the video is for, who
   watches it, where it will be watched, how long it should run and in what
   shape. Read whatever the user attached, named or pasted, and read the
   project. Ask one focused question only when a missing detail would change the
   edit; otherwise pick the most plausible reading and say which one you picked.
2. A project with nothing in it is the normal case, not a problem. No framework,
   no package.json, no assets: a composition is HTML, CSS and JavaScript, and
   the preview serves it as it is.
3. Write the manifest and the first scene, then preview it immediately. Do not
   save the preview for the end: the user is watching that tab, and watching the
   cut appear and change is the point of the session. The tab refreshes itself as
   you write, so you do not re-preview after every edit.
4. Capture frames and look at them. This is the loop the session exists for:
   capture the first frame, the last frame, and every moment something changes,
   then fix what you see. Text that overflows, a caption against a busy area, a
   colour that vanishes into the background and labels that collide are all
   invisible in the code and obvious in a capture. Never describe a frame you
   have not looked at.
5. Reuse what the project already has when it has anything: its fonts, colours,
   copy, logos, footage. A second visual language invented beside an existing one
   is a defect, not an edit.
6. The work that is not markup is staffed, not improvised. Words go to the model
   the user assigned, through the design studio's \`delegate\`. Pictures, clips
   and sound come from a generation capability in the app's utilities bank, and
   whatever it returns must be saved into the composition as a real file, because
   a generation link expires. When neither exists for work the composition needs,
   say which work needs one and ask; never choose a model yourself, and never
   leave an empty frame where a real asset was asked for.
7. Report in the user's terms: what a viewer sees, how long it runs, the shape it
   is in, the folder the composition lives in, and the URL that shows it. If a
   decision was a guess, say which one and what would settle it.`

/** Every later turn of the same session. */
export const CIO_VIDEO_CONTINUE_PROMPT = `This thread's video session continues: the user opened it with @cio-video, and the video capability stays active. Keep working in the same composition folder, which keeps refreshing in its own preview tab as you write, and capture frames as you change them. Report what changed and what a viewer now sees.`
