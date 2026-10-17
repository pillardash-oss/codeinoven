import { CIO_VIDEO_TAG, isCioVideoRequest, type VideoSessionMode } from '../../lib/session-tags'

/**
 * How a video session opens, and the contract a turn inside one carries.
 *
 * A video session opens one of two ways, and it is the same session either way,
 * exactly as a design session does. The user types `@cio-video` (or picks
 * `/cio-video`) and says what to make; that is the fast path, because the tag
 * promotes the app-owned video capability (`cio:video`) to an *active*
 * capability for the turn, so its playbook is already in context and its
 * `preview` and `capture` operations are callable without a search and an
 * activation round trip.
 *
 * The other way is the agent reaching for the tool: activating `cio:video` from
 * the utility gateway opens the same session and hands back the same briefing,
 * so a user who asked for a video in their own words never watches the session
 * go missing. Either way the app records the session on the thread row, which is
 * what the coordinator board reads to dock and what keeps the thread's later
 * turns inside it.
 *
 * The session continues for the rest of the thread: later turns get the shorter
 * continuation contract and the capability stays active, because an edit is
 * worked on over many messages rather than produced in one.
 */

/**
 * The tag, its predicate and the turn mode live in the shared layer, because the
 * renderer asks the same question about the draft the user is about to send.
 * Re-exported here because this module is where main already looks for them.
 */
export { CIO_VIDEO_TAG, isCioVideoRequest }
export type { VideoSessionMode }

/**
 * How to run a video session.
 *
 * One copy, used by both ways a session opens, so the turn the user tagged and
 * the turn an agent opened by activating the capability cannot describe the
 * session differently. Short on purpose: the contract, the folder and both
 * operations arrive with the capability's own playbook, so this only has to say
 * how to run the session and what the user is watching.
 */
const VIDEO_SESSION_STEPS = `How to run the session:

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
4. Capture frames and look at them, in this thread's own in-app browser:
   \`capture\` hands you the picture, and activating the \`cio:browser\` capability
   lets you click, scrub and measure on the preview tab. Never render the
   composition with a browser of your own, such as a cached headless Chrome or
   \`npx playwright\`. This is the loop the session exists for:
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
   decision was a guess, say which one and what would settle it.

Checkpoint the screen scaffold or the existing screen before editing. After every major section, title, image, navbar or scene change, call the active authored-work capability's \`checkpoint\` operation with directory, entry and a short label describing the completed step, before moving on. Do not wait for the end of the turn.`

/** The briefing for the turn the user opened with the tag. */
export const CIO_VIDEO_TURN_PROMPT = `CodeInOven video session

The user opened this turn with @cio-video, so this is a video session. The
app-owned video capability is already active for it: its playbook is in your
context and its preview and capture operations are callable now. Making this
video is the work of this turn, not a preliminary to it.

${VIDEO_SESSION_STEPS}`

/**
 * The briefing for the turn an agent opened itself.
 *
 * Activating `cio:video` from the utility gateway opens the session the tag
 * opens, so the activation hands back the same instructions the tag's turn
 * carries. This is the only way the turn that opened a session can receive its
 * contract after the fact: the prompt was composed before the agent reached for
 * the tool, and the activation result is the turn's next place to read.
 */
export const CIO_VIDEO_ACTIVATION_PROMPT = `CodeInOven video session

You activated the app-owned video capability, and activating it opens a video
session on this thread: the playbook you just received is the session's contract,
its preview and capture operations are callable now, the app records the session
so this thread's later turns stay inside it, and the coordinator board shows the
user the composition as you write into it. Making this video is the work of this
turn, not a preliminary to it.

${VIDEO_SESSION_STEPS}`

/**
 * Every later turn of the same session, however it was opened.
 *
 * Deliberately silent about who opened it: the row is the record, and a turn
 * that was opened by an agent activating the capability is the same session as
 * one the user tagged, so naming the tag here would state something untrue about
 * half the threads that read it.
 */
export const CIO_VIDEO_CONTINUE_PROMPT = `This thread is in a video session, and the video capability stays active. Keep working in the same composition folder, which keeps refreshing in its own preview tab as you write, and capture frames as you change them. Report what changed and what a viewer now sees.

Checkpoint the screen scaffold or the existing screen before editing. After every major section, title, image, navbar or scene change, call the active authored-work capability's \`checkpoint\` operation with directory, entry and a short label describing the completed step, before moving on. Do not wait for the end of the turn.`
