import { authoredWorkCheckpointGuidance } from './design/checkpoint-guidance'
import {
  DEFAULT_WORK_ROOTS,
  workRootGuidance,
  workRootForKind,
  type WorkRoots
} from './design/work-roots'
import {
  DEFAULT_PROTOTYPE_CDN_ENABLED,
  prototypeCdnOrigins,
  type PrototypeCdnPolicy
} from './prototypes/prototype-cdn'

/**
 * Presentation and contract for the app-owned design capability
 * (`cio:design`, `src/lib/utility-ids.ts`).
 *
 * The capability is knowledge plus app operations. The knowledge is the design
 * pass below and the facts a design turn cannot guess from the repository: where
 * a design should be written, and which external hosts will load once it is
 * served. The operations are `preview`, which serves the design folder on the
 * app's own loopback origin and opens it in the project's browser tab
 * (`src/main/preview/design-preview-executor.ts`), `generate`, which makes media
 * with the model chosen for that kind in settings, and `save-media`, which turns
 * a generated asset on a link into a file beside the design
 * (`src/main/design/design-media-executor.ts`).
 *
 * That shape is deliberate. The content security policy of the engineering
 * prototype phase and the open posture of the design preview differ, and both
 * are stated here from the live settings policy rather than from a copy, so the
 * text an agent reads is the policy the servers are enforcing
 * (`src/main/utilities/utility-orchestration-service.ts` resolves it per
 * activation).
 *
 * This capability competes with a design skill the user installed. Ours is the
 * baseline that is always a search away, never the authority: when the project
 * or the user's own skill states a design language, follow that one.
 */

/** Display name shown in a search result, the Utilities UI and the thread bank. */
export const DESIGN_CAPABILITY_NAME = 'Design studio (HTML prototypes)'

/** One-line summary, shown with the name wherever the capability is listed. */
export const DESIGN_CAPABILITY_SUMMARY =
  "Designs an interface as plain HTML, whether that is a landing page, a marketing site, a dashboard, an app screen or a wireframe, then serves the design folder on the app's own loopback origin and opens it in this project and thread's browser tab."

/**
 * Search query advertised in the turn instructions. One word on purpose: the
 * gateway scores a query by token and the registry matches it as a substring,
 * so a multi-word phrase that only works on one of the two paths would be a
 * discovery bug.
 */
export const DESIGN_CAPABILITY_SEARCH_QUERY = 'design'

/**
 * Where a design goes when nobody names a folder, which is the user's setting.
 *
 * Kept as a function rather than a constant for the same reason the paragraphs
 * below are: a playbook that hard-coded the default would tell an agent to write
 * into `.cio/designs` while the user had pointed the folder somewhere Git
 * tracks, and the agent would oblige.
 */
export function designOutputRoot(roots: WorkRoots = DEFAULT_WORK_ROOTS): string {
  return workRootForKind(roots, 'design')
}

/** The two sentences about external assets, built from the live policy. */
function externalAssetGuidance(policy: PrototypeCdnPolicy): string {
  const approved = prototypeCdnOrigins(policy)
  return approved.length === 0
    ? "The prototype phase currently allows the project's own files and no external host, because the CDN allowlist is switched off in Settings, General, Browser. Inline the styles, scripts, fonts and images if the design may be promoted there."
    : `The prototype phase currently allows the project's own files and these origins: ${approved.join(', ')}. Stay within that list when the design may be promoted there.`
}

/**
 * The seeded copy of the playbook, written into the utilities registry so a
 * reader of that file sees a complete contract. Every activation replaces the
 * external-asset paragraph with the live policy and the folder with the live
 * setting, so this copy is a default rather than the text a turn receives.
 */
export const DESIGN_CAPABILITY_DOCS = designCapabilityDocs({
  allowExternalCdn: DEFAULT_PROTOTYPE_CDN_ENABLED,
  userOrigins: []
})

/**
 * The playbook handed back when the capability is activated. Kept as a function
 * because the external-asset paragraph is the live CDN policy and the folder is
 * the user's live setting; a stale copy of either is the drift those resolvers
 * exist to prevent.
 */
export function designCapabilityDocs(
  policy: PrototypeCdnPolicy,
  roots: WorkRoots = DEFAULT_WORK_ROOTS
): string {
  const designRoot = designOutputRoot(roots)
  return `# Design studio

Design interfaces as plain HTML, then look at them in this app while the turn runs. A landing page, a marketing site, a dashboard, an app screen, a wireframe: anything that is a screen rather than a program.

${authoredWorkCheckpointGuidance('design')}

## Going back

The folder keeps its own timeline. \`history\` reads the points it holds and where the folder sits now, with the number to pass back; naming a \`page\` reads that screen's own line, because one screen can be rewound without moving the rest. \`restore\` moves the folder to a point, and \`restore\` with \`page\` rewrites only that screen.

Reach for it when your own work went wrong: an edit that broke a layout, a file you meant to keep, a direction the user rejected. Read the history, restore the point that worked, continue from there. Restoring captures the state it leaves, so the rewind is its own step on the board's Undo. Say which point you restored and what it brought back, never rebuild an old screen from memory while the timeline holds the state that worked, and never rewind over the user's own change without telling them. When Git tracks the folder the app keeps no timeline, and both operations say so.

## Starting from nothing

Call \`read-contract\` first: DESIGN.md or DESIGNS.md, case-insensitive, at the project root, apps and src, root first. Follow the applicable one it returns, and read the project's CSS for its real tokens, fonts and spacing and components.json for its component conventions. Reuse them.

When no contract exists and the user asks for one, generate a lightweight root DESIGN.md with \`write-contract\`, which preserves existing contracts as \`<path>-old-<date-and-time>\` and reports the new file and the backups. Never silently overwrite a contract or create a package catalogue. A project with no framework, sometimes not even a package.json, is the normal case: write the HTML, CSS and JavaScript and the preview serves it. When the project does have a stack, its components and tokens come first.

## Where a design lives

One design per folder: \`${designRoot}/<name>/\`, entry \`index.html\`. The folder is served as a static site, so stylesheets, scripts, SVGs and images sit beside the entry file and both relative and root-absolute paths resolve inside it. ${workRootGuidance(designRoot)}

That folder is the design's home, not scratch space: the board lists the folders under \`${designRoot}\` and nothing else, so a design written under \`.cio/work\` or \`.cio/tmp\` is one the user cannot find. This outranks the general instruction about non-source output, which describes notes and reports, and a design is neither. Move any part of this design that sits elsewhere into the folder before continuing. Never write into \`.cio/specs/<feature>/prototypes/\`, which the engineering prototype phase owns.

## One design, many screens

A design is a product, not a page: one HTML file per screen sharing one stylesheet, linked from each other, \`index.html\` as the landing screen. Keep one product in one folder, because the board pictures the screens of the design a thread is working in, so screens split across two folders are never shown together. A genuinely separate product, a pitch deck beside a site, is the one reason for a second design: its own folder, and \`preview\` with that \`directory\` turns the tab to it.

A screen is an \`.html\` file in the folder or one folder below it; deeper is not shown. A name starting with \`_\` is a partial, and anything starting with \`.\` is skipped, so keep fragments, notes and scratch pages under those names.

## Every state declares itself

The canvas frames each screen and its states, a dialog up, a menu open, a tooltip, and it finds them by reading the markup. So this is a hard requirement: every element that opens, reveals, expands, closes or toggles anything must declare it, or that state is invisible to the canvas, the board and the review. Declare it on the control a person presses: \`aria-expanded\` on anything that opens or collapses, \`aria-haspopup\` with \`aria-expanded\` on a menu, \`aria-controls\` naming the id it reveals, the native \`popover\` attribute on a popover. Keep \`aria-expanded\` truthful as the state changes and give the control an accessible name so its frame is labelled. A dialog with no declared trigger is a state nobody can find, and a hand-wired \`onclick\` on a bare \`div\` renders as one static page.

## Groups on the board

Grouping is the board's own record, not a folder: it moves nothing, so it is always safe and never a reason to rename a folder. Read the arrangement with \`groups\` before you speak about it and change it with \`organize-designs\` when the user asks to group, ungroup, rename, reorder or fold. Name the group the user names, or propose one in their own terms rather than as a filing system. A design you write arrives ungrouped, which is normal: grouping is the user's call unless asked. \`view\` switches the board between pictures and a folded list and remembers the choice.

## The Screen Canvas

The canvas is the app's page, built from the folder on every request, so it frames every screen you write without markup from you. Never write a \`canvas.html\`; that name is not read as a screen.

An optional \`canvas.json\` beside the screens says what the folder cannot:

\`\`\`json
{ "frames": [
  { "entry": "index.html", "title": "Landing page" },
  { "entry": "dashboard.html", "title": "Dashboard, menu open", "width": 390, "state": { "click": "#account-menu" } },
  { "title": "Invite modal", "note": "Dialog over the dashboard, not built yet" } ] }
\`\`\`

\`frames\` orders and labels the canvas: listed frames come first, and screens it does not mention follow in listing order, so a new screen appears without editing the file. \`entry\` names a screen exactly, \`width\` and \`height\` size it (1440 by default, 390 for a phone), \`title\` and \`caption\` label it in the user's words. A state inside a page is a second frame of the same file with a \`state\`: \`{"click": "#account-menu"}\` opens the menu in that frame, \`focus\`, \`scroll\` in px, \`search\`, \`hash\` and \`wait\` in ms do theirs, and the design's own handler draws it, so no picture is kept. Frame what is worth reviewing: a dropdown open is a state, its animation mid-flight is not. A frame with no \`entry\` is a sketch of a state no file holds, and the board offers to build them, so write \`note\` as the state it should become. A frame naming a missing file is dropped and the board says which.

Cover the product, not the happy path: every screen, and for each the states that matter. A state that is a page is a screen file, one that is an interaction is a frame, one you have not built is a sketch.

## Showing the design

Invoke \`preview\` with the folder \`directory\` (default \`${designRoot}\`) and, when you want one screen rather than the whole design as one long page, its \`entry\`. \`attention: "focus"\` brings the tab to the user when foreground interaction is needed; the default leaves them where they are.

The reply carries the URL, so put it in your final message. The tab watches the served folder and refreshes shortly after a change, so do not re-preview after every edit; preview again when you move to another folder or entry. That URL is the only address a new screen has, so preview first and then look.

## Checking your own work

The in-app browser is yours in this thread: activate \`cio:browser\`, point it at the preview tab, and read \`snapshot\` for exact copy and controls, \`screenshot\` for the render, \`viewport\` for phone and desktop widths, and \`console\` for errors and failed requests. An unchanged page is reported unchanged, so pass \`force\` to look twice. Never render your own work with a browser of your own: no cached headless Chrome, no \`npx playwright\` or \`puppeteer\`, no \`curl\`, no screenshot script. That browser shows a page the app never served and tells you nothing about the tab the user is watching.

Before calling a screen finished, render it at phone and desktop widths, exercise its main action and states, then \`lint\` it and fix objective craft failures. Then \`critique\` each changed screen once with five equally weighted dimensions from 0 to 10 (philosophy, hierarchy, detail, functionality, innovation) and concrete evidence, plus \`fixes\` and \`criticalIssues\` for unresolved brand, accessibility, copy or functionality failures, judging brand by the project's contract and accessibility by measured contrast and keyboard behaviour. A screen passes only at 8 or above with no craft findings and no critical issues: report the scores and the evidence, and report a failing screen as unfinished rather than running converging rounds. These scores are agent-assessed and attributed to the thread's model in Usage.

## Measuring a reference

For "make it look like this site", call \`extract-reference\` with the user's HTTP(S) URL. It measures a bounded visible sample in an isolated renderer and returns typography, area-weighted colours, component geometry, logo references and the source URL. Treat it as observed evidence, not a complete brand system: compare it with the project's contract and tokens, and only \`write-contract\` when the user asked for one, separating observed values from inferred rules. Ask for the URL when they have not supplied one.

## Motion tools

Use motion for feedback, continuity or attention. Repeated interactions stay immediate and interruptible; reuse project timing and components, respect reduced motion, import no stock effects. \`motion-read\` the element's source id (add a stable id first when it has none), \`motion-preview\` a change against that revision, then \`motion-inspect\` to sample it and \`motion-apply\` to persist the one you reviewed, which rejects stale revisions and captures a checkpoint. A preview is temporary, individual transform properties compose with an existing transform, and the inspector reports advisory motionWarnings separately from blocking craft findings. Read again after any source edit.

## Live design controls

When adjustable accent, density, theme or sample data helps the review, declare an opt-in manifest and load the app runtime after the content:

\`\`\`html
<script type="application/json" data-cio-tweaks>
[{"id":"accent","label":"Accent","type":"color","variable":"--color-primary","value":"#D4AF37"}]
</script>
<script src="/__cio/tweaks.js" defer></script>
\`\`\`

Use the project's real token names and values; up to 12 controls of type color, range, select or text, and a \`variable\` sets that CSS custom property immediately. For theme or sample data listen for \`cio:tweaks\` on \`document\` and apply \`event.detail\`. Changes never reload. Keep this review strip out of production code.

## Pictures, video and sound

\`generate\` makes media with the model chosen for that kind in Settings, served by the generation backend. \`kind\` is \`image\`, \`video\` or \`audio\`. Its \`prompt\` is the complete brief, since the model has seen nothing of this work, and \`name\` with \`directory\` lands the file beside the design it belongs to. Pass \`options\` only for a provider-specific field the model documents, such as an aspect ratio or a duration. The reply carries the project-relative path: reference it relatively, preview the folder to check size and position, and look at the asset before describing it.

When a kind has no model configured, say so in one line and ask the user to pick one in Settings, Media. Do not download a model, pick one for them, or accept prose where a picture, a clip or a track was asked for.

## External assets

The preview sets no content security policy, so Google Fonts, a CDN and inline scripts all load.

${externalAssetGuidance(policy)}

For a design that must stand alone outside the app, inline the styles, scripts and fonts and reference no external host.

## The design pass

Aim for a page someone would recognise as designed rather than generated.

1. Read the brief and the project first: existing tokens, components or a stylesheet are the starting point. Invent a second visual language only for work deliberately separate from the product.
2. Hold one direction: one accent colour, at most two type families, one spacing unit.
3. Type: a scale with clearly distinct steps, in \`rem\` only, for example 1rem body, 1.5rem section heading, 2.5rem page heading. Browser-default headings carry no decision.
4. Space: 4px or 8px as the unit, always its multiples; uneven gaps between siblings are the first thing the eye catches.
5. Contrast: body text at least 4.5:1 against its background, large text at least 3:1. Muted greys fail most often.
6. Layout: build on a grid, then let one element break it. Even blocks all the way down look unmade.
7. States: hover, focus-visible, active and disabled where they apply, plus loading and empty variants for anything that fetches.
8. Real content: the real labels, names, prices and numbers. Placeholder text hides exactly the problems it pretends to expose.
9. Themes: colour as custom properties on \`:root\`, so the design flips between light and dark.
10. Accessibility: semantic elements, labelled controls, \`alt\` text, a visible focus ring, and a keyboard order that follows the visual order.
11. Motion: one deliberate transition per interaction, 120ms to 240ms. Nothing moves on load unless the design is about motion.
12. Skip the generated-page tells: a purple gradient on white, emoji standing in for icons, three equal cards with one-line bodies, everything centred, a heading that restates the page heading below it.

## Reporting the work

Say what the design does and what a viewer can try in the user's terms, name the folder it lives in and the URL that shows it, and say which decision was a guess and what would settle it.
`
}
