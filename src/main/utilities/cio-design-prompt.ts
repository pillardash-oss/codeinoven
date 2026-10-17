import { CIO_DESIGN_TAG, isCioDesignRequest, type DesignSessionMode } from '../../lib/session-tags'

/**
 * How a design session opens, and the contract a turn inside one carries.
 *
 * A design session opens one of two ways, and it is the same session either way.
 * The user types `@cio-design` (or picks `/cio-design`) and says what to design,
 * exactly the way `@cio-utility` starts a setup turn. That is the fast path:
 * what the tag grants is the app-owned design capability (`cio:design`) as an
 * *active* capability for the turn, so the playbook is already in context and
 * its `preview` operation is callable without a search and an activation round
 * trip.
 *
 * The other way is the agent reaching for the tool. Activating `cio:design` from
 * the utility gateway opens the same session for the turn and hands back the
 * same briefing, so a user who asked for a design in their own words never
 * watches the session go missing. Activation only reads the playbook: the app
 * records the session on the thread row when the work actually happens, which is
 * the first preview into a design folder. That row is what the coordinator board
 * reads to dock and what keeps the thread's later turns inside the session, so a
 * thread the agent only read the playbook on stays an ordinary thread.
 *
 * The session then continues for the rest of the thread: a later turn gets the
 * shorter continuation contract instead of the full briefing, and the design
 * capability stays active, because a design is edited over many messages rather
 * than produced in one.
 */

/**
 * The tag, its predicate and the turn mode are shared with the renderer and with
 * the design service, so the copy that decides whether a send opens a design
 * session is the same code everywhere it is asked. Re-exported here because this
 * module is where the rest of the main process already looks for them.
 */
export { CIO_DESIGN_TAG, isCioDesignRequest }
export type { DesignSessionMode }

/**
 * How to run a design session.
 *
 * One copy, used by both ways a session opens, so the turn the user tagged and
 * the turn an agent opened by activating the capability cannot describe the
 * session differently. Short on purpose: the design pass, the folder and the
 * preview operation all arrive with the capability's own playbook, so this only
 * has to say how to run the session and what the user is watching.
 */
const DESIGN_SESSION_STEPS = `How to run the session:

1. Establish what the design is for before writing markup. Read whatever the
   user attached, named or pasted, and read the project. Ask one focused
   question only when a missing detail would change the design; otherwise pick
   the most plausible reading and say which one you picked.
2. A project with nothing in it is the normal case, not a problem. No framework,
   no package.json, no components: the design is plain HTML, CSS and JavaScript,
   and the preview serves it as it is.
3. Write the first screen, then preview it immediately. Do not save the preview
   for the end: the user is watching that tab, and seeing the design appear and
   change is the point of the session. The tab refreshes itself as you write, so
   you do not re-preview after every edit; preview again when you move to another
   screen, another folder, or another entry file. Keep the product in one design
   folder with one HTML file per screen, linked from \`index.html\`: a website is
   several pages and a dashboard is several screens, and the coordinator board
   shows a picture of every screen in that folder. A Screen Canvas
   (\`canvas.html\`) is the page that shows the whole product at once; write it
   once a few screens exist and keep it in step, because the board shows it and
   the user reviews the design on it.
4. Check the result yourself before you describe it, in this thread's own in-app
   browser: preview the folder so the tab has its served URL, activate the
   \`cio:browser\` capability, and use its \`screenshot\` for a phone width and a
   desktop width and its \`console\` for failed requests and runtime errors. Never
   render it with a browser of your own, such as a cached headless Chrome or
   \`npx playwright\`, because the tab the user is watching is the one that
   answers whether the screen works.
5. Reuse what the project already has when it has anything: its components,
   tokens, fonts and copy. A second visual language invented beside an existing
   one is a defect, not a design.
6. The work that is not markup is staffed, not improvised. The user puts a
   model on each craft in Settings, Design, and the playbook names them: the
   copy goes to the model you pick with \`delegate\`, which runs the exact one
   they assigned. A picture, a clip or a track is a file rather than an answer,
   so it comes from a generation capability in the app's utilities bank, and
   \`save-media\` writes what it returns beside the design so the markup can
   reference a file of its own. When neither an assignment nor a capability
   exists, say which work needs one and ask; never choose a model yourself.
   Never leave a placeholder where the user asked for real content, and never
   present generated or placeholder content as the real thing.
7. Report in the user's terms: what a viewer sees, what they can try, the folder
   the design lives in, and the URL that shows it. If a decision was a guess,
   say which one and what would settle it.

Checkpoint the screen scaffold or the existing screen before editing. After every major section, title, image, navbar or scene change, call the active authored-work capability's \`checkpoint\` operation with directory, entry and a short label describing the completed step, before moving on. Do not wait for the end of the turn.`

/** The briefing for the turn the user opened with the tag. */
export const CIO_DESIGN_TURN_PROMPT = `CodeInOven design session

The user opened this turn with @cio-design, so this is a design session. The
app-owned design capability is already active for it: its playbook is in your
context and its preview operation is callable now. Design is the work of this
turn, not a preliminary to it.

${DESIGN_SESSION_STEPS}`

/**
 * The briefing for the turn an agent opened itself.
 *
 * Activating `cio:design` from the utility gateway opens the session the tag
 * opens, so the activation hands back the same instructions the tag's turn
 * carries. This is the only way the turn that opened a session can receive its
 * contract after the fact: the prompt was composed before the agent reached for
 * the tool, and the activation result is the turn's next place to read. The
 * session becomes durable on the thread when the work does, at the first
 * preview, so reading the playbook alone never marks the thread as a design
 * thread.
 */
export const CIO_DESIGN_ACTIVATION_PROMPT = `CodeInOven design session

You activated the app-owned design capability, and activating it opens a design
session for this turn: the playbook you just received is the session's contract
and its preview operation is callable now. Writing the first screen is what opens
the session on the thread, which is what makes the coordinator board appear and
what keeps this thread's later turns inside the session, so do not treat this as
a preliminary: design is the work of this turn.

${DESIGN_SESSION_STEPS}`

/**
 * Every later turn of the same session, however it was opened.
 *
 * Deliberately silent about who opened it: the row is the record, and a turn
 * that was opened by an agent activating the capability is the same session as
 * one the user tagged, so naming the tag here would state something untrue about
 * half the threads that read it.
 */
export const CIO_DESIGN_CONTINUE_PROMPT = `This thread is in a design session, and the design capability stays active. Keep working in the design folder the product already lives in and add a screen as its own HTML file beside \`index.html\`, linked from the rest; the folder keeps refreshing in its own preview tab as you write, and the coordinator board pictures every screen it holds. If the design has a Screen Canvas, keep it in step with the screens in the same pass, because the user reviews the design on it. Report what changed and what a viewer can now try.

Save a baseline checkpoint before editing an existing screen, then call this capability's \`checkpoint\` with directory, entry and a short completed-step label after each major section, title, image or navbar change, before starting the next step.`
