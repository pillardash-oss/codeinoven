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
 * Where a design goes when nobody names a folder.
 *
 * `.cio/` is the app's scratch tree and is ignored by Git, so a design written
 * here is explorable work rather than a change to the product. Promoting it, by
 * moving it into the source tree and rebuilding it from the project's own
 * components, stays a deliberate act.
 */
export const DESIGN_OUTPUT_ROOT = '.cio/designs'

/** The two sentences about external assets, built from the live policy. */
function externalAssetGuidance(policy: PrototypeCdnPolicy): string {
  const approved = prototypeCdnOrigins(policy)
  return approved.length === 0
    ? "The prototype phase currently allows the project's own files and no external host, because the CDN allowlist is switched off in Settings, General, Browser. Inline the styles, scripts, fonts and images if the design may be promoted there."
    : `The prototype phase currently allows the project's own files and these origins: ${approved.join(', ')}. Stay within that list when the design may be promoted there.`
}

/**
 * The delegation paragraph: the assignments the user set up, or the fact that
 * nothing is delegated yet. Either way the agent is told that picking a model is
 * the user's decision and never its own.
 */
function delegationGuidance(assignments: string): string {
  return assignments.length === 0
    ? 'No design work is delegated yet: the user has not assigned a model to any design work. The assignments are app-wide, so this is true of every project rather than of this one. Produce what you can with your own tools, and when the design needs something you cannot produce, say which work needs a model and that the user assigns it in Settings, Design. Never choose a model yourself, and never fill the gap with a placeholder presented as the real thing.'
    : `The user assigned: ${assignments}. Delegate that work before telling the user it cannot be produced. When you need something that is not in that list, do not pick a model yourself: name the work and tell the user to assign a model to it in Settings, Design.`
}

/**
 * The seeded copy of the playbook, written into the utilities registry so a
 * reader of that file sees a complete contract. Every activation replaces the
 * external-asset paragraph with the live policy, so this copy is a default
 * rather than the text a turn receives.
 */
export const DESIGN_CAPABILITY_DOCS = designCapabilityDocs({
  allowExternalCdn: DEFAULT_PROTOTYPE_CDN_ENABLED,
  userOrigins: []
})

/**
 * The playbook handed back when the capability is activated. Kept as a function
 * because the external-asset paragraph is the live CDN policy and the delegation
 * section is the user's live assignments; a stale copy of either is the drift
 * both resolvers exist to prevent.
 */
export function designCapabilityDocs(policy: PrototypeCdnPolicy, assignments: string = ''): string {
  return `# Design studio

Design interfaces as plain HTML, then look at them in this app while the turn is still running. A landing page, a marketing site, a dashboard, an app screen, a wireframe, a pitch: anything that is a screen rather than a program.

## Starting from nothing

A project may hold no framework at all, sometimes not even a package.json. That is the normal case here, not an edge case. The design does not need the project to have a stack: write the HTML, the CSS and the JavaScript, and the preview serves it. When the project does have a stack, its components and tokens come first, and the design speaks their language.

## Where a design lives

Write one design per folder under \`${DESIGN_OUTPUT_ROOT}/<name>/\`, with \`index.html\` as the entry file. The folder is served as a static site, so \`styles.css\`, \`app.js\`, SVGs and images can sit beside the entry file, and both relative paths (\`./styles.css\`) and root-absolute paths (\`/styles.css\`) resolve inside the folder. \`.cio/\` is ignored by Git, so a design stays scratch until the user asks for it in the source tree.

Do not write into \`.cio/specs/<feature>/prototypes/\`. That folder belongs to the engineering prototype phase, which finalizes and registers whatever it finds there.

## Showing the design

Invoke this capability with operation \`preview\`:

- \`directory\`, project-relative, defaults to \`${DESIGN_OUTPUT_ROOT}\`.
- \`entry\`, a file inside that folder, defaults to \`index.html\` when that file exists. With no entry file the app opens its own file listing.
- \`attention\`, \`focus\` (the default) to bring the tab to the user, \`background\` to leave them where they are.

The reply carries the URL, so you can also put it in your final message. The tab keeps itself current: the app watches the served folder and refreshes the preview shortly after a file changes, so an edit shows up without you re-previewing. Preview again when you move to a different folder or a different entry file.

## Checking your own work

Activate the app's in-app browser capability, \`cio:browser\` (search for "browser"), and use it on the tab this preview opened. \`snapshot\` lists the visible text and controls, \`screenshot\` shows the render, \`viewport\` moves between phone, tablet and desktop widths, and \`console\` reports runtime errors and failed requests. Read \`snapshot\` for exact copy, because a capture is delivered at a reduced size, and screenshot to judge the render; a page that has not changed since the previous capture is reported as unchanged rather than captured again. Do that before calling a design finished. A page nobody rendered is a page nobody tested.

## Delegating to the models the user assigned

Some design work is words: the copy that sounds like the product, an SEO pass, a script, a storyboard, the prompts a generator will be given. The user assigns a model to each kind of work in Settings, Design, and operation \`delegate\` runs that exact model:

- \`assignment\`, the work to delegate, by its handle or by its title.
- \`prompt\`, the complete brief. The assigned model sees nothing of this conversation, so the prompt carries the subject, the tone, the format, every constraint, and the exact deliverable you want back.

${delegationGuidance(assignments)}

A delegated model answers in words. It cannot hand back an image, a video or a sound file, so never delegate one and never accept prose as though it were the asset.

Say which assignment produced a piece of work when you report, so the user can see where their own model choice was used.

## Pictures, video and sound

Media comes from a capability, not from a completion. An image generator, a video model or a text-to-speech service reaches this app as a capability the user installed in Utilities, and the utilities bank is how you use it:

1. Find it with the search tool the turn instructions name (query the work, for example "generate an image" or "video generation"), activate the result, then invoke it. Every one takes its own arguments, so read the capability's documentation before calling it.
2. When it answers with a link, save that link with this capability's \`save-media\` operation, naming the design's own folder and a file name that says what the asset is. Generation links expire within hours or days, so a design that references one stops rendering; the saved file does not.
3. Reference the file from the markup with the relative path the reply gave you, and preview the folder to check it renders at the size and in the position the design needs.
4. When no installed capability does the work, say so plainly and name what would: the user installs it in Utilities. Do not stand in for a generator, and never leave an empty frame or a grey box where a real asset was asked for.

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

Say what the design does and what a viewer can try, in the user's terms: the screen, the sections, the interaction states. Name the folder it lives in and the URL that shows it. If a decision was a guess, say which one and what would settle it.`
}
