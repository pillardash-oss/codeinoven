import { authoredWorkCheckpointGuidance } from './design/checkpoint-guidance'
import {
  expertDelegationGuidance,
  EXPERT_FALLBACK_GUIDANCE,
  NO_EXPERTS,
  type EffectiveExperts
} from './experts'
import {
  DEFAULT_WORK_ROOTS,
  workRootGuidance,
  workRootForKind,
  type WorkRoots
} from './design/work-roots'

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

/**
 * Where a composition goes when nobody names a folder, which is the user's
 * setting.
 *
 * Read through a function rather than a constant so the playbook states the
 * folder the app will actually write into, not the default it ships with.
 */
export function videoOutputRoot(roots: WorkRoots = DEFAULT_WORK_ROOTS): string {
  return workRootForKind(roots, 'video')
}

/**
 * What the agent is handed when the capability is activated.
 *
 * The order is the order the work happens in: what a composition is, where it
 * lives, the contract that makes it renderable, how to watch it and check it,
 * and only then the craft notes that decide whether the result is good.
 */
export function videoCapabilityDocs(
  experts: EffectiveExperts = NO_EXPERTS,
  roots: WorkRoots = DEFAULT_WORK_ROOTS
): string {
  const videoRoot = videoOutputRoot(roots)
  return `# Video studio

Make a video as a small web project, then watch it in this app while the turn is still running. A title sequence, a product walkthrough, a captioned social cut, an explainer, an animated chart, a montage: anything that is a piece of motion rather than a page.

${authoredWorkCheckpointGuidance('video')}

## Why it is a web project

A timeline document can only describe arrangement. An edit needs to compute: twelve cards generated from a list, a number counting up, a caption timed to a beat, a chart drawn from real figures. Those are programs, and the browser already runs programs, typesets text, loads fonts and draws at any size. So a composition is HTML, CSS and JavaScript, and the app supplies the two things a page cannot do alone: an exact frame at an exact time, and a way to watch the work while it is still changing.

## Where a composition lives

Write one composition per folder under \`${videoRoot}/<name>/\`:

- \`index.html\`, the stage the app loads.
- \`composition.json\`, the manifest it reads before the page runs.
- Whatever else the composition needs beside them: scripts, stylesheets, fonts, images, audio, all referenced with relative paths.

${workRootGuidance(videoRoot)} Do not write into \`.cio/specs/<feature>/prototypes/\`, which belongs to the engineering prototype phase.

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

While the app is showing your composition it owns the clock completely. The preview tab has play, pause, seek, stop, a frame step and a loop toggle, so the user watches a video rather than a page that plays itself, and the playhead is kept across the reload an edit causes. Two consequences for your code:

- Write your own animation loop anyway, because the same folder is also opened outside this app, where nothing else drives it. While the app is showing the composition that loop is parked: the callbacks you register are held instead of run, so nothing you draw reaches the screen behind the playhead, whether you call \`window.cioRenderFrame\` or a local copy of it.
- Do one-time setup with promises rather than with \`requestAnimationFrame\`. A callback you register after the player armed stays held until the player is disposed, so a first frame that waits for an animation-frame tick would never arrive.

Your soundtrack stops with the picture. A play is refused while the player is paused, and the app mutes the tab for as long as it is not playing, so a bed you start late or from an element you never added to the page cannot sound under a still frame. Playing, pausing or seeking re-times the bed to the playhead rather than re-scoring it, so do not key a beat to a time only you can compute: put the timing in the render function, where the app can reach it.

## The stage

- Draw on a \`<canvas>\` sized to the manifest, in CSS pixels, and scale the backing store by \`devicePixelRatio\` so text is not soft. Canvas is what makes a frame deterministic and what keeps a capture sharp.
- DOM and CSS are fine for a scene that is genuinely a layout, but a DOM scene animates through style recalculation, which is slower and less predictable than drawing, so prefer canvas for anything moving.
- Clear the whole canvas at the start of every frame. A frame that inherits the previous one is the most common way a composition stops being deterministic.
- Never scale text by the viewport. A composition has a fixed frame; write sizes as fractions of \`height\`, so a preview at any panel width shows the same design.
- Put nothing important in the outer 5% of the frame. A player crops, a phone rounds corners, and a social feed overlays its own controls there.

## Sound

The page plays the files named in \`audio\` for a viewing. The app reads the same list from the manifest to mux them into an exported file, because a page cannot hand back its own mixed audio. Name them in the order they should layer, and keep speech above music by a wide margin.

## Footage, captions and delivery

Use \`probe\` before editing source media. \`filmstrip\` extracts up to 24 small frames at reported timestamps; open those pictures. \`waveform\` returns a waveform PNG, and \`listen\` returns a mono WAV excerpt. \`cut\` saves a trimmed clip with its audio into a new folder. Sources are project-relative files and originals are kept.

\`transcribe\` uses the installed ASR selected in Sounds, never a model you choose. Recognizer-supplied word timing is retained when available. Otherwise the output explicitly reports chunk timing; never describe it as word aligned. Import JSON or SRT with \`captions\`, using \`from\` and \`to\` for the source trim and \`at\` for its timeline placement. Supplied word timing survives trims. Caption styles are \`plain\`, \`highlight\` and \`karaoke\`.

Use \`studio\` to read the composition's \`studio.json\` and revision. Write back the full document and that revision to change controls, captions or audio tracks. Controls hold \`key\`, \`label\`, \`kind\` (text, number, color, switch), \`value\` and optional number bounds. Audio tracks hold composition-relative \`source\`, timeline \`start\`, source \`trim\`, \`duration\` and \`gain\`. The video panel edits the same file, so read it again after a user edit. A stale revision is refused rather than overwriting the user's work.

Install the CIO-authored helper script with \`runtime\`, then include \`<script src="./cio-video.js"></script>\` before your own script. Await \`CIOVideo.bind(draw)\` to load saved parameters, audio tracks and fonts before defining the render function. Read \`CIOVideo.parameters\` in your draw function and call \`CIOVideo.drawCaptions(ctx, seconds, width, height)\` after the scene. Do not echo the document or tool instructions onto the stage.

The helpers expose progress, interpolation and easing; SVG path reveals and animated dashed strokes through \`strokePath\`; polygons, matching-command path morphs and fixed group pivots; and \`trackingAt\` for interpolating a tracked position. Canvas supplies ellipse and conic-gradient drawing. Always save and restore the drawing context around a group transform.

Name your output canvas with \`CIOVideo.useCanvas(canvas)\`. The export encodes that canvas inside the renderer, so no full frame crosses into the app's main process and a long export never competes with the rest of the window. Draw everything the video should contain into that canvas: a composition that draws only with DOM and CSS has no canvas to encode and exports by capturing the window frame by frame instead, which is slower and costs the main process.

For footage on the stage, await \`CIOVideo.mediaReady(video)\` once and \`CIOVideo.seekMedia(video, sourceSeconds)\` before drawing an exact frame. The render function may return a promise; both capture and export wait for it, and preview does not overlap asynchronous draws.

\`track\` follows a selected rectangular region through up to 60 seconds, with normalized x/y/width/height coordinates. It returns center positions and confidence, not a semantic object mask. Inspect low-confidence frames and occlusions. \`remove-background\` creates an opaque base and transparent foreground WebM locally using a supported GPU, with a bounded 720p/30fps clip and a first-use model download into the app's own model cache. It needs the optional video pack from Settings > Design and video; MODNet is for people, BEN2 is for general subjects, and hardware failures must be reported rather than invented into a transparent result.

\`export\` renders the composition to MP4 with audio in a dedicated hidden renderer, up to 4K pixel count, and writes SRT when captions exist. The renderer encodes H.264, and every frame is encoded at the composition's own size rather than at a device-pixel-ratio scaled size, so the file matches the manifest. Its audio comes from studio tracks when present, otherwise the manifest's audio list. Audio embedded in source clips must be declared as tracks to be heard in the export. The source composition stays intact.

Analysis, cuts, tracking, background removal and export return a job immediately. Poll \`jobs\` for progress and terminal success, files or errors; never report delivery while it is running. One expensive job runs at a time. The user can cancel with confirmation in Video controls or the task manager. Inspect the resulting MP4 before calling the work delivered.

## Preview and frame review

Invoke this capability with operation \`preview\`:

- \`directory\`, project-relative, defaults to \`${videoRoot}\`.
- \`entry\`, a file inside that folder, defaults to \`index.html\`.
- \`attention\`, \`background\` (the default) to leave the user where they are, \`focus\` to bring the tab to the user when foreground interaction is needed.

The tab keeps itself current: the app watches the served folder and refreshes the preview shortly after a file changes, so an edit appears without re-previewing and without the viewer losing their place in the timeline. Preview again only when you move to a different folder.

The tab is a player. The user can pause it, drag the scrubber, step a frame, stop it back to the start and turn looping off, and the playhead survives the refresh an edit triggers. So a composition is written to be watched at any second rather than only from the beginning: every frame has to be correct on its own, which is the same determinism the capture loop already demands.

The video board draws the composition's timeline: the ruler from the manifest, one band per caption, one lane per audio track with its waveform, and the playhead the tab is on. It edits nothing, because the arrangement is your code rather than a stored document. The user can click the ruler to place the playhead on a second and write a note there. That note reaches you as a reference carrying the composition folder, the timecode, the frame number, any caption covering that moment with its exact start and end, and the key and label of every control the composition defines, exactly the way a note on a design element reaches you. Address it at that second: the frame function, the timeline placement, or the caption that covers it, and when the note names a control, change that control. A note the user moved is refused by nothing and stored nowhere else, so re-read \`studio\` after an edit that could have retimed a caption.

The tab is the thread's own in-app browser, so you have a browser to work in. Activate the \`cio:browser\` capability with the utility tools (search for "browser") when you need to interact with the composition rather than look at a still: its \`screenshot\`, \`viewport\`, \`snapshot\` and \`console\` work on that tab. Never render a composition with a browser of your own, such as a cached headless Chrome or Chromium binary or \`npx playwright\`, because the app's own renderer is what the capture and the export use, so a second browser only tells you about a different page.

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

Pictures, clips and sound are files rather than answers, so the app generates them with the model the user assigned to that craft. Call \`generate\` with \`kind\` set to \`image\`, \`video\` or \`audio\`, a complete brief in \`prompt\`, and \`name\` with \`directory\` when the asset belongs beside a particular composition. The reply carries the project-relative path, which the composition references relatively. \`options\` is for a provider-specific field the model documents, such as an aspect ratio or a duration.

${EXPERT_FALLBACK_GUIDANCE}

Use your own tools when a craft is unassigned. Report a capability limitation only after checking available generation tools. Never leave an empty frame where the user asked for a real asset.`
}

/**
 * The seeded copy of the playbook, written into the utilities registry so a
 * reader of that file sees a complete contract. Every activation replaces the
 * experts paragraph with the live list, so this copy is a default rather than
 * the text a turn receives.
 */
export const VIDEO_CAPABILITY_DOCS = videoCapabilityDocs()
