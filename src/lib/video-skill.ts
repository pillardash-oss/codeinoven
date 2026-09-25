import { expertDelegationGuidance, NO_EXPERTS, type EffectiveExperts } from './experts'

/**
 * The video capability's playbook, and the constants the surfaces that list it
 * need.
 *
 * A capability is knowledge with an interface attached, and this is the
 * knowledge: what a composition is, the one function the app calls on it, and
 * how to run an edit so the result is a piece of work rather than a slideshow.
 * The interface is `preview` and `capture` from `src/main/video/`, which is why
 * this text can promise them.
 *
 * Like the design playbook, the paragraph about the models the user staffed is
 * rebuilt from live settings, because the same experts staff both: a video is
 * words, pictures, clips and sound, and which model does each is the user's
 * decision rather than the app's. The rest of the text is a constant, because the
 * composition's contract is not a setting.
 */

/** Display name shown in a search result, the Utilities UI and the thread bank. */
export const VIDEO_CAPABILITY_NAME = 'Video studio (compositions)'

/** One-line summary, shown with the name wherever the capability is listed. */
export const VIDEO_CAPABILITY_SUMMARY =
  "Cuts and composites a video as a small web project: a timeline drawn by the browser, watched live in this project and thread's preview tab, with any exact frame capturable so the work can be looked at while it is being made."

/**
 * Search query advertised in the turn instructions. One word on purpose: the
 * gateway scores a query by token and the registry matches it as a substring,
 * so a multi-word phrase that only works on one of the two paths would be a
 * discovery bug.
 */
export const VIDEO_CAPABILITY_SEARCH_QUERY = 'video'

/** Where a composition goes when nobody names a folder. */
export { VIDEO_PROJECT_ROOT as VIDEO_OUTPUT_ROOT } from './video/project'

/**
 * What the agent is handed when the capability is activated.
 *
 * The order is the order the work happens in: what a composition is, where it
 * lives, the contract that makes it renderable, how to watch it and check it,
 * and only then the craft notes that decide whether the result is good.
 */
export function videoCapabilityDocs(experts: EffectiveExperts = NO_EXPERTS): string {
  return `# Video studio

Make a video as a small web project, then watch it in this app while the turn is still running. A title sequence, a product walkthrough, a captioned social cut, an explainer, an animated chart, a montage: anything that is a piece of motion rather than a page.

## Why it is a web project

A timeline document can only describe arrangement. An edit needs to compute: twelve cards generated from a list, a number counting up, a caption timed to a beat, a chart drawn from real figures. Those are programs, and the browser already runs programs, typesets text, loads fonts and draws at any size. So a composition is HTML, CSS and JavaScript, and the app supplies the two things a page cannot do alone: an exact frame at an exact time, and a way to watch the work while it is still changing.

## Where a composition lives

Write one composition per folder under \`.cio/videos/<name>/\`:

- \`index.html\`, the stage the app loads.
- \`composition.json\`, the manifest it reads before the page runs.
- Whatever else the composition needs beside them: scripts, stylesheets, fonts, images, audio, all referenced with relative paths.

\`.cio/\` is ignored by Git, so a composition stays scratch until the user asks for it in the source tree. Do not write into \`.cio/specs/<feature>/prototypes/\`, which belongs to the engineering prototype phase.

## The manifest

\`composition.json\` declares the frame, because the app has to know it before the page runs:

- \`width\`, \`height\`, in pixels, both even. Video encoders subsample colour, so an odd dimension is an encoding failure rather than a smaller frame.
- \`fps\`, \`1\` to \`120\`. \`30\` is a safe default; \`60\` for motion, \`24\` for a filmic feel.
- \`duration\`, in seconds.
- \`background\`, optional \`#rrggbb\`, default black.
- \`audio\`, optional list of project-relative sound files, in the order they layer.

Common frames: landscape 1920x1080, portrait 1080x1920, square 1080x1080.

## The render contract

Define one global function:

\`\`\`js
window.cioRenderFrame = (seconds) => {
  // draw the frame at that time, from scratch, on every call
}
\`\`\`

That is the entire contract. It must be deterministic: the same \`seconds\` must draw the same frame, every time, with no dependence on how long the page has been open, on \`Date.now()\`, on a random number, or on accumulated state. Every frame is drawn from the timeline position alone, because that is the only thing the app promises to set. This is what makes a capture the frame you asked for rather than the frame that happened to be on screen.

The app sets two things when it wants one frozen frame: the query parameters \`cio-capture=1\` and \`cio-time=<seconds>\`. A well-behaved project reads them, draws that frame once, and starts no animation loop. The app calls \`cioRenderFrame\` itself before it captures, so a project that ignores both parameters is still captured correctly; honouring them only removes the race between the page settling and the capture.

For a viewing, animate: drive \`cioRenderFrame\` from \`requestAnimationFrame\`, looping at \`duration\`, unless \`cio-capture\` is set.

While the app is showing your composition it owns the clock. The preview tab has play, pause, seek, stop, a frame step and a loop toggle, so the user watches a video rather than a page that plays itself, and the playhead is kept across the reload an edit causes. Two consequences for your code:

- Call \`window.cioRenderFrame\` through the global. Never hold the function in a variable and call that: the player replaces the global so the page's own loop cannot fight it for the frame, and a cached copy would draw behind the user's playhead.
- Keep animating the page yourself, because the same folder is also opened outside this app, where nothing else drives it. Your draws are simply ignored while the app is showing the composition.

Your soundtrack is paused and re-timed with the picture when the user pauses or seeks. It is not re-scored frame by frame, so do not key a beat to a time only you can compute: put the timing in the render function, where the app can reach it.

## The stage

- Draw on a \`<canvas>\` sized to the manifest, in CSS pixels, and scale the backing store by \`devicePixelRatio\` so text is not soft. Canvas is what makes a frame deterministic and what keeps a capture sharp.
- DOM and CSS are fine for a scene that is genuinely a layout, but a DOM scene animates through style recalculation, which is slower and less predictable than drawing, so prefer canvas for anything moving.
- Clear the whole canvas at the start of every frame. A frame that inherits the previous one is the most common way a composition stops being deterministic.
- Never scale text by the viewport. A composition has a fixed frame; write sizes as fractions of \`height\`, so a preview at any panel width shows the same design.
- Put nothing important in the outer 5% of the frame. A player crops, a phone rounds corners, and a social feed overlays its own controls there.

## Sound

The page plays the files named in \`audio\` for a viewing. The app reads the same list from the manifest to mux them into an exported file, because a page cannot hand back its own mixed audio. Name them in the order they should layer, and keep speech above music by a wide margin.

## Watching it, and checking your own work

Invoke this capability with operation \`preview\`:

- \`directory\`, project-relative, defaults to \`.cio/videos\`.
- \`entry\`, a file inside that folder, defaults to \`index.html\`.
- \`attention\`, \`focus\` (the default) to bring the tab to the user, \`background\` to leave them where they are.

The tab keeps itself current: the app watches the served folder and refreshes the preview shortly after a file changes, so an edit appears without re-previewing and without the viewer losing their place in the timeline. Preview again only when you move to a different folder.

The tab is a player. The user can pause it, drag the scrubber, step a frame, stop it back to the start and turn looping off, and the playhead survives the refresh an edit triggers. So a composition is written to be watched at any second rather than only from the beginning: every frame has to be correct on its own, which is the same determinism the capture loop already demands.

Then use operation \`capture\` to look at an exact frame: give it \`time\` in seconds, and it freezes the composition there and hands the picture back to you as an image you can see.

**This is the loop that makes the work possible, and it is not optional.** Write a scene, capture it, look at it, fix what is wrong, capture again. A capture is the only way to know what your composition actually looks like: text that overflows, a caption against a busy area, a colour that disappears into the background, a chart whose labels collide. None of those are visible in the code. Look at the first frame, the last frame, the middle, and every moment where something changes. Before you describe a cut as finished, you have looked at it.

Never reason about a frame you have not captured, and never report a composition as done on the strength of its code.

## The edit pass

Video is not a stack of slides. Work in this order.

1. Decide the shape before the content: the aspect (portrait for a phone, landscape for a screen, square for a feed), the length, and the pace. A 15-second cut and a 90-second explainer are different crafts.
2. Give it a spine: an opening that states the subject, a middle that develops one idea at a time, and an ending that lands. A composition with no ending reads as a loop.
3. Length follows the words. A title is on screen for about 2 to 3 seconds, a caption long enough to read aloud and then a beat longer. Anything a viewer cannot finish reading is not on screen long enough, and that is the most common fault in a generated edit.
4. One idea per beat. Cutting to a new scene every 2 to 4 seconds holds attention; a scene that sits for 12 seconds loses it.
5. Type: a display size for a title, a clearly smaller body, and nothing in between by accident. Text must be legible at the phone size the video will be watched at, which is much smaller than the frame you are looking at.
6. Contrast: white on a mid-grey, or thin type over busy footage, will fail. Give text a solid backing or a scrim, and keep body text at least 4.5:1 against it.
7. Motion has a reason: an entrance, a transition, a reveal that shows a change. Everything easing in on every scene is noise. Keep a move between 200ms and 500ms, and hold a still frame long enough to be seen.
8. Ease. Nothing in a real edit moves at a constant speed from a standing start; a linear move reads as cheap, and an ease-out reads as deliberate.
9. Sound carries as much as picture. Speech forward and clean, music well under it, and a level change at a cut unless the cut is meant to be invisible.
10. Real content, always. Real names, real numbers, real copy. A placeholder frame or a lorem ipsum caption hides exactly the layout problems it pretends to expose.
11. Accessibility: caption anything spoken, never carry meaning in colour alone, and keep a burned-in caption inside the safe area.
12. Skip the generated tells: a purple gradient, a slow zoom on a static card, a wall of text fading in, three equal panels, and a payoff that never arrives.

## The work that is not markup

Copy, a script, a storyboard, an SEO pass: those are words, and the user assigns a model to each craft in Settings, Design. The design studio's \`delegate\` operation is the lane that runs the model they chose.

${expertDelegationGuidance(experts, 'video')}

Pictures, clips and sound are files rather than answers, so they come from a generation capability the user installed in Utilities: find it with the search tool the turn instructions name, activate it, call it, and save what it returns as a file beside the composition. Generation links expire, so never reference one from a composition.

When neither an assignment nor a capability exists for work the composition needs, say which work needs one and ask. Never choose a model yourself, never stand in for a generator, and never leave an empty frame where the user asked for a real asset.`
}

/**
 * The seeded copy of the playbook, written into the utilities registry so a
 * reader of that file sees a complete contract. Every activation replaces the
 * experts paragraph with the live list, so this copy is a default rather than
 * the text a turn receives.
 */
export const VIDEO_CAPABILITY_DOCS = videoCapabilityDocs()
