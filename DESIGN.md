# CodeInOven Design Contract

## Direction

CodeInOven is a focused workstation for coordinating engineering agents. Its interface should feel precise, calm, and information-dense, with visible state and clear operator actions. The chosen Console composer study expresses that through a quiet writing surface, compact controls, and a single context bar that identifies where the next turn will run. Keep the app’s workspace character rather than introducing marketing-page styling. [docs/APP-BIBLE.md](docs/APP-BIBLE.md) [.cio/designs/chosen/index.html](.cio/designs/chosen/index.html)

## Brand identity

The approved CodeInOven mark is the square C/O symbol shown in the selected identity study. Keep the C open and free of an interior divider. The divider belongs inside the squared O, and the gold knob sits at its right edge. Match the geometry and proportions in [src/renderer/static/icon-mark.svg](src/renderer/static/icon-mark.svg) and the visible construction in [.cio/designs/logo-identity/index.html](.cio/designs/logo-identity/index.html). Do not extend a stroke out of the C or add flames, smoke, gradients, shadows, or decoration to the mark. [src/renderer/static/icon.svg](src/renderer/static/icon.svg)

Use the full-color mark with ivory structure and a gold endpoint on an obsidian field for app icons, favicons, and social artwork. The operating system may apply its native app-icon mask. Keep the endpoint in full-color desktop and sharing treatments. One-color menu and tray exports omit the endpoint for monochrome template rendering; the attention cue stays separate from the logo geometry. [scripts/build-app-icons.ts](scripts/build-app-icons.ts) [src/renderer/static/icon-mono-small.svg](src/renderer/static/icon-mono-small.svg) [src/renderer/static/icon-mono-small-attention.svg](src/renderer/static/icon-mono-small-attention.svg)

Use the wordmark as “CodeInOven”. Keep the mark and name legible when composed together, and use the same approved geometry across product surfaces. Platform app icons, favicons, and tray assets are generated from their SVG masters with [scripts/build-app-icons.ts](scripts/build-app-icons.ts). The social-card master and PNG are [src/renderer/static/social-preview.svg](src/renderer/static/social-preview.svg) and [src/renderer/static/social-preview.png](src/renderer/static/social-preview.png); the Electron renderer currently has no public social-image metadata entry in [src/renderer/index.html](src/renderer/index.html). The transparent vendor mark is [src/renderer/static/icon-mark.svg](src/renderer/static/icon-mark.svg).

## Color

Use the semantic CSS custom properties from [src/renderer/app.css](src/renderer/app.css); do not duplicate their hex values in product UI. Light mode uses ivory `--color-app: #f7f6f2`, white `--color-surface`, warm gray raised surfaces, obsidian `--color-foreground: #081825`, and gold `--color-accent: #d4af37`. Dark mode uses neutral charcoal surfaces (`#0b0b0d`, `#141417`, `#1c1c20`) with warm off-white text. Gold stays sparse in product controls and is intrinsic to the full-color mark’s endpoint. Blue, green, amber, and red keep their semantic meanings for progress and status. Borders stay thin and low contrast, becoming stronger for emphasis.

A third axis sits beside the scheme: Appearance offers a contrast level (`normal`, `more`, `intense`) that redraws the text and rule tokens at roughly one, two and three times their shipped ratio. It is carried as `data-contrast` on the document root next to the `.dark` class, and every level is a palette rather than a filter, so each token keeps its hue and `--color-accent` is still gold at every level. When a token doubles as a fill, its `--color-on-*` ink is solved with it, so a label never loses legibility as the plate changes. [.cio/designs/chosen/tokens.css](.cio/designs/chosen/tokens.css) [.cio/designs/chosen/styles.css](.cio/designs/chosen/styles.css)

## Typography and spacing

Use the app font token, currently Oven Box with system monospace fallbacks; Appearance settings can replace it at runtime. The composer uses compact text, clear weight differences, and tabular numerals for usage values. Keep typography in scalable units and use a tight spacing rhythm built from rem increments, with small gaps for grouped controls and larger gaps between regions. [src/renderer/app.css](src/renderer/app.css)

## Surfaces and reusable patterns

Favor a clean editor surface on the app canvas, separated by hairline borders. Keep the composer’s message area uncluttered; place its actions in a compact toolbar and its project, scope, Oven, branch, and shortcut context in one segmented footer bar. Menus and the usage panel should read as anchored extensions of their triggering control.

Extend the existing composer pieces in `src/renderer/lib/components/chats/` before creating parallel controls: `ChatComposer.svelte`, `ComposerShoe.svelte`, `ChatComposerPermissionPicker.svelte`, `EngineeringToolbox.svelte`, and `ContextUsageIndicator.svelte` cover the demonstrated anatomy. Reuse shared UI primitives such as `Modal.svelte`, `ConfirmDialog.svelte`, `SideSheet.svelte`, `Switch.svelte`, `EmptyState.svelte`, and `StatusPill.svelte` where their roles fit. Compose modal variants on the canonical `Modal.svelte` shell. No `components.json` convention was present in the checked project paths. [src/renderer/lib/components/chats/ChatComposer.svelte](src/renderer/lib/components/chats/ChatComposer.svelte) [src/renderer/lib/components/chats/ComposerShoe.svelte](src/renderer/lib/components/chats/ComposerShoe.svelte) [src/renderer/lib/components/ui/Modal.svelte](src/renderer/lib/components/ui/Modal.svelte) [src/renderer/lib/components/ui/ConfirmDialog.svelte](src/renderer/lib/components/ui/ConfirmDialog.svelte) [.cio/designs/chosen/index.html](.cio/designs/chosen/index.html)

## Interaction states

Controls use quiet surface changes on hover and pressed/expanded states; selected menu options are marked with `aria-checked` and an inline check. Keep disabled actions visibly subdued. The composer’s primary action changes meaning with state: send when idle, queue while a turn is working and text is present, and stop while working with an empty editor. The usage control exposes a labelled dialog with progress values. Preserve the compact layout at narrow widths by truncating secondary labels before removing their identifying marks. [.cio/designs/chosen/index.html](.cio/designs/chosen/index.html) [.cio/designs/chosen/styles.css](.cio/designs/chosen/styles.css)

## Accessibility and motion

Use semantic buttons and labelled editable fields; icon-only controls need action-specific accessible names and titles. Expose toggle and menu state with the corresponding ARIA attributes, keep keyboard focus visible on buttons, and use the established focus treatment for editable fields. Keep keyboard shortcuts visible beside the actions they describe. Respect reduced-motion preferences. Check text and control contrast in both themes whenever colors or surfaces change. [src/renderer/app.css](src/renderer/app.css) [.cio/designs/chosen/index.html](.cio/designs/chosen/index.html) [.cio/designs/chosen/styles.css](.cio/designs/chosen/styles.css)
