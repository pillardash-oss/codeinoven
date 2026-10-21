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
 * the utility gateway opens the same session, and the activation payload carries
 * the same briefing the tag's prompt would have carried, so a user who asked for
 * a design in their own words never watches the session go missing. Either way
 * the app records the session on the thread row, which is what the coordinator
 * board reads to dock and what keeps the thread's later turns inside it.
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

/**
 * The briefing that opens a design session.
 *
 * Two turns can open one: the turn the user tagged with `@cio-design`, and the turn
 * an agent opened by activating the design capability. The folder is a parameter
 * rather than a constant because the project's own record decides it and the user
 * can move it, so the line that names it is the live one. It is stated in the
 * briefing itself, and not only in the playbook, because this is the message an
 * agent reads at the moment it reaches for the tool: work can already exist by
 * then, and the app can see the mistake coming (it is almost always a design
 * written into the agent's own scratch folder, see `workFolderNote` in
 * `src/lib/design/work-roots.ts`).
 *
 * The same paragraph ends the ambiguity the general scratch rule leaves: that rule
 * is about notes and reports, and a design is neither.
 */
export function designSessionBriefing(opened: 'tag' | 'activation', root: string): string {
  const lead =
    opened === 'tag'
      ? 'The user opened this turn with @cio-design, so this is a design session.'
      : 'You activated the app-owned design capability, and activating it opens a design session on this thread.'
  return `CodeInOven design session

${lead} The app-owned design capability is active: its playbook is in your context and its preview operation is callable now. Design is the work of this turn, not a preliminary to it.

Where the design goes: \`${root}\`. Write it as \`${root}/<name>/\`, and if any of it already sits somewhere else (a scratch folder such as \`.cio/work\`, \`.cio/tmp\`, or the repository root), move it into \`${root}/<name>/\` now and continue there. The board lists the folders under \`${root}\` and nothing else, so a design left in another folder is one the user never sees. This is the folder for the rest of the session: it is the project's live record, a save-path change moves it, and it outranks any path named in an older message.

${DESIGN_SESSION_STEPS}`
}

/**
 * Every later turn of the same session, however it was opened.
 *
 * Deliberately silent about who opened it: the row is the record, and a turn that
 * was opened by an agent activating the capability is the same session as one the
 * user tagged, so naming the tag here would state something untrue about half the
 * threads that read it. The folder is named for the opposite reason: it is the
 * project's live record, and a turn that reads it cannot move the work by accident.
 */
export function designSessionContinuation(root: string): string {
  return `This thread is in a design session, and the design capability stays active. The design folder is \`${root}\`, and the work belongs there: move anything of this design that sits elsewhere into it, then keep working in the folder the product already lives in and add a screen as its own HTML file beside \`index.html\`, linked from the rest; the folder keeps refreshing in its own preview tab as you write, and the coordinator board pictures every screen it holds. If the design has a Screen Canvas, keep it in step with the screens in the same pass, because the user reviews the design on it. Report what changed and what a viewer can now try.

Save a baseline checkpoint before editing an existing screen, then call this capability's \`checkpoint\` with directory, entry and a short completed-step label after each major section, title, image or navbar change, before starting the next step.`
}
