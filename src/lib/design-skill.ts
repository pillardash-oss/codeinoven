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
 * a design should be written, which external hosts will load once it is served,
 * and which models the user assigned to the design work. The operations are
 * `preview`, which serves the design folder on the app's own loopback origin and
 * opens it in the project's browser tab (`src/main/preview/design-preview-executor.ts`),
 * `delegate`, which runs one prompt on a model the user assigned rather than on
 * one the agent picked (`src/main/design/design-assignment-executor.ts`), and
 * `save-media`, which turns a generated asset on a link into a file beside the
 * design (`src/main/design/design-media-executor.ts`).
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
 * The delegation paragraph.
 *
 * Written for a design session by the shared builder, so the video playbook
 * states the same thing about the same list of models.
 */
function delegationGuidance(experts: EffectiveExperts): string {
  return expertDelegationGuidance(experts, 'design')
}

/**
 * The seeded copy of the playbook, written into the utilities registry so a
 * reader of that file sees a complete contract. Every activation replaces the
 * external-asset paragraph with the live policy and the delegation paragraph
 * with the user's live experts, so this copy is a default rather than the text a
 * turn receives.
 */
export const DESIGN_CAPABILITY_DOCS = designCapabilityDocs({
  allowExternalCdn: DEFAULT_PROTOTYPE_CDN_ENABLED,
  userOrigins: []
})

/**
 * The playbook handed back when the capability is activated. Kept as a function
 * because the external-asset paragraph is the live CDN policy, the delegation
 * section is the user's live experts, and the folder is the user's live setting;
 * a stale copy of any of them is the drift those resolvers exist to prevent.
 */
export function designCapabilityDocs(
  policy: PrototypeCdnPolicy,
  experts: EffectiveExperts = NO_EXPERTS,
  roots: WorkRoots = DEFAULT_WORK_ROOTS
): string {
  const designRoot = designOutputRoot(roots)
  return `# Design studio

Design interfaces as plain HTML, then look at them in this app while the turn is still running. A landing page, a marketing site, a dashboard, an app screen, a wireframe, a pitch: anything that is a screen rather than a program.

${authoredWorkCheckpointGuidance('design')}

## Starting from nothing

First call \`read-contract\`. It reads DESIGN.md or DESIGNS.md case-insensitively at the project root, apps and src, without searching the rest of the tree. Root takes precedence. Read every returned contract and use the applicable one as the design's contract. Read the project's CSS for its actual tokens, fonts and spacing, and components.json when present for the existing component conventions. Reuse those components and tokens.

If no contract exists, design from the brief and actual project. When the user requests one, generate a lightweight root DESIGN.md from the finished design, or from the agreed direction before starting. Call \`write-contract\` with \`markdown\`; it preserves existing matching contracts as \`<original-path>-old-<date-and-time>\` before publishing DESIGN.md. Report the new file and the backup paths. Never silently overwrite a contract or create a package catalogue.

A project may hold no framework at all, sometimes not even a package.json. That is the normal case here, not an edge case. The design does not need the project to have a stack: write the HTML, the CSS and the JavaScript, and the preview serves it. When the project does have a stack, its components and tokens come first, and the design speaks their language.

## Where a design lives

Write one design per folder under \`${designRoot}/<name>/\`, with \`index.html\` as the entry file. The folder is served as a static site, so \`styles.css\`, \`app.js\`, SVGs and images can sit beside the entry file, and both relative paths (\`./styles.css\`) and root-absolute paths (\`/styles.css\`) resolve inside the folder. ${workRootGuidance(designRoot)}

Do not write into \`.cio/specs/<feature>/prototypes/\`. That folder belongs to the engineering prototype phase, which finalizes and registers whatever it finds there.

## One design, many screens

A design is a product, not a page. A website is several pages, a dashboard is several screens, and a design system is a set of them: write one HTML file per screen in the design's folder, sharing one stylesheet, and link them from each other so the design reads as one product rather than as loose files. \`index.html\` is the entry file and belongs to the screen a visitor lands on.

Keep one product in one folder. A website and its dashboard split across two folders is a defect the user sees: the coordinator board pictures the screens of the design a thread is working in, so screens written into two folders are never shown together. A genuinely separate product, a pitch deck beside a product site, is the one reason to start a second design, and a thread may hold as many as the work needs: each is its own folder, the board lists them all, and \`preview\` with that folder's \`directory\` turns the tab to it.

The board reads a screen as an \`.html\` file in the design's folder or one folder below it, so \`dashboard.html\` and \`pages/pricing.html\` are both screens and a page two levels down is not one it shows. A file whose name starts with \`_\` is read as a partial (\`_nav.html\`), and a folder or file whose name starts with \`.\` is skipped, so keep fragments, scratch pages and notes under those names and they stay out of the way.

## The Screen Canvas

One canvas per design: \`canvas.html\` beside the screens, the single page that shows the whole product at once. Write it once the first few screens exist, and keep it in step: a screen added, removed or reshaped means its frame changes in the same pass. The coordinator board shows the canvas as soon as it exists, and its button asks for one when the design has none, so a canvas you never write is the whole product the user cannot see.

The page stays thin, because the app serves the runtime and its styles:

\`\`\`html
<main data-cio-canvas>
  <section data-cio-frame="index.html" data-cio-title="Landing page"></section>
  <section data-cio-frame="dashboard.html" data-cio-title="Dashboard, empty" data-cio-caption="No projects yet"></section>
  <section data-cio-frame="dashboard.html" data-cio-title="Dashboard, phone" data-cio-width="390"></section>
  <section data-cio-sketch data-cio-title="Invite modal">…the drawing of a state that has no file yet…</section>
</main>
<script src="/__cio/canvas.js"></script>
\`\`\`

- One \`<section data-cio-frame="…">\` per screen and per state of a screen, in reading order. The file is relative to the design folder, spelled exactly as the screen is. \`data-cio-title\` labels the frame and \`data-cio-caption\` adds a line under it, both in the user's words.
- \`data-cio-width\` is the width the frame renders at, 1440 by default. Use it for a phone or tablet state of the same screen (390, 768) instead of writing a second file. \`data-cio-height\` fixes a frame's height when measuring its content would be wrong, and \`data-cio-columns\` on the canvas root sets how many frames sit side by side (2 by default, at most 4).
- A \`<section data-cio-sketch>\` holds a state you have drawn but not built: its markup stays as written, so a canvas can exist before its screens do. The board's Live view action later asks you to build each sketch as a real screen, and its frame becomes a \`data-cio-frame\`.
- The one script tag is the whole integration: the runtime brings its own styles with it, lays the frames out, and adds pan, zoom and a fit control. Never copy a screen's markup into a live frame: the frame loads the file, so the canvas cannot drift from the design.

Cover the product, not the happy path: every screen, and for each one the states that matter (empty, loading, error, a dialog open, filled). A canvas that draws one screen at six widths hides the screens that are missing.

## Showing the design

Invoke this capability with operation \`preview\`:

- \`directory\`, project-relative, defaults to \`${designRoot}\`.
- \`entry\`, a file inside that folder, defaults to \`index.html\` when that file exists. Name a screen here to show that screen: \`entry: 'dashboard.html'\` turns the preview to the dashboard, so a design of several screens is previewed a screen at a time rather than as one long page. With no entry file the app opens its own file listing.
- \`attention\`, \`background\` (the default) to leave the user where they are, \`focus\` to bring the tab to the user when foreground interaction is needed.

The reply carries the URL, so you can also put it in your final message. The tab keeps itself current: the app watches the served folder and refreshes the preview shortly after a file changes, so an edit shows up without you re-previewing. Preview again when you move to a different folder or a different entry file.

That URL is the address the thread's in-app browser opens, and it is the only one a screen you just wrote has: until \`preview\` has served the folder, there is nothing for a browser to render. So preview first, then look.

## Checking your own work

The app's in-app browser is yours in this thread, and looking at your own screens in it is part of the design work rather than an extra. Activate the \`cio:browser\` capability with the utility tools (search for "browser"), point it at the tab this preview opened, and use \`snapshot\` for the visible text and controls, \`screenshot\` for the render, \`viewport\` to move between phone, tablet and desktop widths, and \`console\` for runtime errors and failed requests. Read \`snapshot\` for exact copy, because a capture is delivered at a reduced size; a page that has not changed since the previous capture is reported as unchanged rather than captured again, so pass \`force\` when you need the same page twice. A page nobody rendered is a page nobody tested.

Never render your own work with a browser of your own: no cached headless Chrome or Chromium binary, no \`npx playwright\` or \`puppeteer\`, no \`curl\` and no screenshot script. That browser shows a page the app never served and tells you nothing about the tab the user is watching.

Before calling a screen finished, render the current screen at phone and desktop widths, exercise its main action and states, then call \`lint\` with directory and entry. Fix objective craft failures. After that, call \`critique\` once for each changed screen. Supply five \`dimensions\`: philosophy, hierarchy, detail, functionality and innovation, each with a 0–10 score and concrete evidence. They are weighted equally. Supply \`fixes\` and \`criticalIssues\`, listing unresolved brand, accessibility, copy or functionality failures. Use the project's contract when judging the brand and actual measured contrast and keyboard behavior when judging accessibility.

A screen passes only at 8/10 or above, with no craft findings or critical issues. Report the scores, evidence and fixes in the thread. If it fails, report that it is unfinished and the corrections it needs; do not silently run converging critique rounds or describe a failing screen as finished. These are agent-assessed scores, attributed to the thread's model in Usage, rather than independent benchmarks.

## Measuring a reference

For "make it look like this site", call \`extract-reference\` with the user's HTTP(S) URL. It measures a bounded visible sample in an isolated renderer and returns source URL, viewport, typography, area-weighted colours, component geometry and logo references. Treat it as observed evidence, not the reference's complete brand system. Compare it with the project's existing contract and CSS tokens. Generate a lightweight contract with \`write-contract\` only when the user requests generation, preserving the old contract; distinguish observed values from inferred design rules. Ask for a source URL when the user has not supplied one.

## Live design controls

When adjustable accent, density, theme or sample data helps the review, declare an opt-in manifest and load the app runtime in that screen, after its content:

\`\`\`html
<script type="application/json" data-cio-tweaks>
[{"id":"accent","label":"Accent","type":"color","variable":"--color-primary","value":"#D4AF37"},
 {"id":"density","label":"Spacing","type":"range","variable":"--space","min":0.5,"max":2,"step":0.25,"value":1,"unit":"rem"},
 {"id":"theme","label":"Theme","type":"select","options":["light","dark"],"value":"light"}]
</script>
<script src="/__cio/tweaks.js" defer></script>
\`\`\`

Use the actual project token names and values. Up to 12 controls of type color, range, select or text are supported. A variable changes that CSS custom property immediately. For theme or sample data, listen for \`document\` event \`cio:tweaks\` and apply \`event.detail\` to the existing DOM. Changes never reload the page. Keep this review control strip out of production code when implementing the product in another thread.

## Delegating to the models the user assigned

Some design work is a craft rather than markup: the copy that sounds like the product, an SEO pass, a script, a storyboard. The user puts a model on each craft in Settings, Design, and operation \`delegate\` runs the one they chose for the work you name:

- \`assignment\`, the work to delegate, by its handle or by its title.
- \`prompt\`, the complete brief. The assigned model sees nothing of this conversation, so the prompt carries the subject, the tone, the format, every constraint, and the exact deliverable you want back.

${delegationGuidance(experts)}

\`delegate\` is the copywriting lane and answers with text only. A craft that produces a picture, a clip or a track is made with \`generate\` instead, so never accept prose as though it were the asset.

Say which assignment produced a piece of work when you report, so the user can see where their own model choice was used.

## Pictures, video and sound

Media is generated by the app, with the model the user assigned to that craft. Call \`generate\` with the kind the design needs:

1. \`kind\`, one of \`image\`, \`video\` or \`audio\`. It chooses the craft, and so the model the user put on that craft.
2. \`prompt\`, the complete brief: the subject, the style, the mood, the framing, and anything the asset must not contain. A generation model has seen nothing of this work, so the prompt carries all of it.
3. \`name\` and \`directory\` when the asset belongs beside a particular design, so the file lands in that design's folder under a name that says what it is. The default folder is the design root.
4. \`options\` only for a provider-specific field the model documents, such as an aspect ratio or a duration.

The reply carries the project-relative path. Reference the file from the markup with a relative path, preview the folder to check it renders at the size and in the position the design needs, and look at the asset before you describe it.

${EXPERT_FALLBACK_GUIDANCE}

## External assets

The design preview sets no content security policy, so Google Fonts, a CSS or JS CDN and inline scripts all load.

${externalAssetGuidance(policy)}

When a design has to stand on its own outside the app, inline the styles, the scripts and the fonts and reference no external host.

## The design pass

The aim is a page someone would recognise as designed rather than generated. Work in this order.

1. Read the brief and the project first. If the project already has tokens, components or a stylesheet, the design starts from those. Invent a second visual language only when the work is deliberately separate from the product.
2. Choose a direction and hold it: one accent colour, at most two type families, one spacing unit. Contrast, density and tone should read as one decision.
3. Type: set a scale with clearly distinct steps, for example 1rem for body, 1.5rem for a section heading, 2.5rem for the page heading, and use \`rem\` only. A page with browser default headings carries no type decision.
4. Space: pick 4px or 8px as the unit and use its multiples. Slightly uneven gaps between siblings are the first thing the eye catches.
5. Contrast: body text at least 4.5:1 against its background, large text at least 3:1. Muted greys are where this fails most often.
6. Layout: build on a grid, then let one element break it, a wide card, an offset image, a heading that overhangs its column. Even blocks all the way down look unmade.
7. States: every interactive element needs hover, focus-visible, active and disabled where it applies, plus a loading and an empty variant for anything that fetches.
8. Real content: write the real labels, names, prices and numbers. Placeholder text hides exactly the layout problems it pretends to expose.
9. Themes: define colour as custom properties on \`:root\` so the design can flip between light and dark. A hardcoded background is acceptable only in a study that will not be kept.
10. Accessibility: semantic elements, labelled controls, \`alt\` text, a visible focus ring, and a keyboard order that follows the visual order.
11. Motion: one deliberate transition per interaction, 120ms to 240ms. Nothing moves on load unless the design is about motion.
12. Skip the generated-page tells: a purple gradient on white, emoji standing in for icons, three equal cards with one-line bodies, everything centred, and a section heading that restates the page heading underneath it.

## Reporting the work

Say what the design does and what a viewer can try, in the user's terms: the screens it now holds, the sections, the interaction states. Name the folder it lives in and the URL that shows it. If a decision was a guess, say which one and what would settle it.`
}
