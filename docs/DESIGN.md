# CodeInOven Design Guide

This document captures the current visual and interaction language of CodeInOven. Agents should use it with`APP-BIBLE.md` before changing UI so the product stays consistent across routes and components.

## Product Personality

CodeInOven is a precision instrument for professionals running coordinated agentic software engineering. The UI is calm and confident: high information density with unmistakable hierarchy, never shouting. Copy is operator-first and verb-driven (`New thread`, `Approve plan`, `Run checks`) with no marketing language inside the app. The product must feel trustworthy — state transitions are visible, destructive actions are explicit, and nothing happens silently. The brand tone is restrained luxury: Obsidian and Ivory with a whisper of Auric gold, saying "serious tool," not "SaaS landing page." See `APP-BIBLE.md` for the full philosophy.

## Visual Direction

The app uses a restrained workspace aesthetic:

- Compact top navigation with contextual controls.

- Floating bottom dock for the major modules.

- Soft app canvas, raised surfaces, and thin borders for structure.

- Obsidian (#081825) as the primary color.

- Ivory (#F7F6F2) as the light background.

- Auric (#D4AF37) as accent only (under 5% usage).

- Strong numeric hierarchy with tabular figures.

- Satoshi as the product typeface.

- Lucide icons for actions and module cues.

- Rounded, tactile controls without playful decoration.

The experience should resemble a focused business dashboard, not a marketing SaaS homepage.

## Theme Tokens

Use the semantic Tailwind v4 tokens defined in `apps/app/src/app.css`. Do not hardcode raw black, white, or arbitrary hex color values in UI markup.

Core tokens:

- `bg-app`: page/application background (Ivory #F7F6F2 in light mode, Obsidian #081825 in dark mode).

- `bg-surface`: primary panels, page sections, tables, auth panels.

- `bg-elevated`: raised controls, row cards, hoverable surface elements.

- `bg-overlay`: active toolbar states, table heads, dropdown hover states.

- `bg-raised`: neutral chips and subtle separated zones.

- `text-foreground`: primary readable text (Obsidian in light, Ivory in dark).

- `text-muted`: secondary copy and labels.

- `text-dimmed`: tertiary hints, shortcuts, metadata.

- `bg-primary` / `text-primary`: brand color (Obsidian in light, Ivory in dark).

- `text-on-primary`: text/icons on primary actions.

- `bg-accent` / `text-accent`: Auric gold (under 5% usage for highlights/badges only).

- `bg-danger` / `text-danger`: destructive actions.

Light mode uses Ivory backgrounds with Obsidian text. Dark mode uses Obsidian backgrounds with Ivory text. Auric gold is reserved for accent elements only (badges, special highlights, limited to 5% of UI). Every new UI element must work in both themes through tokens, not one-off color values.

## Typography

Use Satoshi from `apps/app/static/assets/font` through the app font stack. Keep text practical and compact.

- Page titles: `text-xl` to `text-2xl`, `font-bold` or `font-semibold`, `tracking-tight`.

- Section titles: `text-sm` to `text-base`, `font-semibold`.

- Labels and table headers: `text-xs`, `font-semibold`, often uppercase with modest tracking.

- Body/help text: `text-sm`, `text-muted`, readable line height.

- Money, counts, and stock values: `tabular-nums`, strong weight, tight hierarchy.

Do not scale text with viewport width. Avoid oversized display type inside dashboards, tables, forms, cards, or sidebars.

## Layout

Favor dense, scannable business layouts:

- Use full-width page flow with constrained internal spacing.

- Standard page rhythm is `space-y-6`, panels with `p-4`, `p-5`, or `p-6`.

- Use `rounded-xl` and `rounded-2xl` for main panels and modals; `rounded-lg` for compact controls and table tools.

- Keep cards for repeated items, metrics, empty states, modals, and framed tools. Do not nest cards inside cards.

- Use grids for metrics and dashboards: `sm:grid-cols-2`, `xl:grid-cols-4`, or a main/aside split when useful.

- Preserve stable dimensions for toolbars, filters, buttons, tables, icon buttons, and mobile row cards. Controls should not cause layout shift when toggled.

The dashboard pattern is a compact summary panel, metric cards, recent activity table, and a right-side operations/signals column. Module pages should follow the same operational density.

## Components

Prefer existing reusable components before creating new markup:

- `PageHeader.svelte` for route titles and actions.

- `DashboardCard.svelte` for metrics and KPI summaries.

- `DataTable.svelte` for searchable, filterable records with mobile card fallback.

- `StatusPill.svelte` for payment, delivery, status, and state labels.

- `EmptyState.svelte` for direct empty states with one concrete next action.

- `Modal.svelte`, `SideSheet.svelte`, and drawer components for overlays.

- Form components in `src/lib/components/form` for validation and consistent fields.

- Bits UI as the foundation for dropdowns, dialogs, accordions, checkboxes, and other primitives.

Create a new primitive only when bits-ui does not provide a suitable foundation. If a component will be used in two or more places, make it reusable.

## Buttons And Controls

Buttons should be familiar, compact, and action-oriented.

- Primary actions use `bg-primary text-on-primary hover:bg-primary-hover` (Obsidian background with Ivory text in light mode).

- Secondary actions use tokenized borders and elevated/overlay hover states.

- Accent actions (use sparingly, under 5%): `bg-accent text-on-primary hover:bg-accent-hover` (Auric gold).

- Minimum action height is usually `h-8`, `h-9`, `h-10`, or `min-h-[36px]`.

- Use icons from `@lucide/svelte` inside action buttons when the action benefits from a recognizable symbol.

- Icon-only controls need accessible labels.

- Prefer `rounded-lg` or `rounded-xl`; reserve fully rounded controls for avatars, circular icon buttons, and pills.

- Do not write boolean Svelte props as `prop={true}`; use the shorthand attribute.

Avoid arbitrary z-index values when Tailwind has a matching class. For example, use `z-10` instead of `z-[10]`.

## Toast Notifications

Toasts are the app's transient feedback surface. They are rendered by the shared `Toaster.svelte` (svelte-sonner) in the top-right corner and must never be replaced with ad-hoc popups, banners, or inline alerts for one-off feedback.

- Never re-style toasts ad hoc in feature components. All toast theming lives in `src/renderer/lib/components/ui/Toaster.svelte`; calling `toast.success/warning/error/info` from anywhere must pick up the brand styling automatically.

- Status is communicated by color first: each toast carries a status-tinted background wash, a status-tinted hairline border, a status-colored title, a tinted icon chip, and a solid status-colored left accent border. Success uses `--color-success`, warning `--color-warning`, error `--color-danger`, info `--color-info`. The color must read instantly, before the words do.

- The accent is a real `border-left` on the toast, never a `::before`/absolutely-positioned pseudo-element — pseudo-element decorations detach and float during drag, dismissal, and scale transitions.

- Toast layout is strictly row-based: icon and title share the header row (icon left, title immediately beside it), the description gets its own full-width row underneath, and all action buttons share the bottom row side by side. Nothing else sits side by side.

- Action buttons render as a shared full-width row at the bottom of the toast, never beside the text. Error toasts always include a `Copy` action (`reportError` / `reportErrorWithDetails` in `src/renderer/lib/stores/app-errors.svelte.ts` copy the message plus details/stack to the clipboard); any additional action sits next to it on the same row.

- Layout rules must win the cascade over svelte-sonner's internal `[data-styled='true']` selectors — match that specificity and use `!important` deliberately inside `Toaster.svelte` for structural properties.

- Do not remove `richColors`; the brand theming intentionally replaces it. Keep the memory-proposal custom toast (`toast.custom(MemoryToastComponent)`) as the only custom-component toast.

- Do not add toast preview/demo buttons in shipping UI. To tune toast styling, fire toasts temporarily during development, then remove the triggers before committing.

## Tables And Data Views

Tables are the core of the app. Keep them powerful, compact, and stable.

- Use `DataTable.svelte` for record lists.

- Toolbars should support search, quick filters, date filters, export, and optional batch actions without pushing layout around.

- Desktop rows use thin borders, muted headers, and subtle overlay hover states.

- Mobile rows should become compact bordered cards with label/value pairs.

- Empty results should explain the state briefly and offer a concrete next action when appropriate.

- Use `StatusPill` for status cells instead of freeform colored text.

- Keep money and counts right-aligned where comparison matters.

## Forms

Forms should feel transactional and forgiving.

- Labels are compact, muted, and explicit.

- Inputs use tokenized elevated backgrounds, thin foreground borders, primary focus rings, and muted placeholders.

- Keep optional fields truly optional and explain only where it reduces confusion.

- Use business language: sale, order, paid, unpaid, delivery, stock, expense, profit, receipt.

- Avoid accounting-heavy labels in beginner flows.

- Delivery fee is first-class and must not be modeled as a fake product.

- Product creation must not block creating an order; support custom order lines.

## Overlays

Overlays should feel like part of the workspace, not separate pages.

- On desktop, modals are centered with tokenized surfaces, thin borders, subtle ring, and short scale/fade transitions.

- On mobile, modals become bottom sheets with a visible handle and constrained height.

- Side sheets are for focused editing and detail workflows.

- Backdrops use tokenized app overlays and light blur where established.

- Do not introduce full page reloads for modal, drawer, or navigation actions.

## Navigation

Navigation is app-like, instant, and centered on a Mac-style dock plus contextual header model.

- Use SvelteKit links or `goto` for client-side routing.

- Do not trigger full browser navigation except intentional sign-out state reset.

- Do not use `event.stopPropagation()` on containers that include `<a>` links because it can prevent SvelteKit from intercepting navigation.

- Keep route metadata centralized in `apps/app/src/lib/routes.ts`. This file is the menu database for dock items, all-apps spotlight, route-aware page titles, header submenus, and spotlight search.

- New modules, pages, and submenu destinations must be represented in the central route registry or a route-registry extension before they appear in navigation.

- The current route controls the header title. Do not hardcode independent header titles that can drift from route metadata.

- The current route also controls the header submenu set. Submenus belong in the header, not the dock.

### Dock

The floating bottom dock is the primary module launcher.

- Major modules must be represented on the dock when screen capacity allows.

- The dock has a responsive cap: mobile shows the smallest quick-launch set, tablet shows more quick-launch items, and desktop may show additional module icons.

- Do not force every route into the dock. Overflow belongs in the all-apps spotlight.

- Dock icons use module icons from the route registry, compact labels, active Obsidian state, and subtle hover lift.

- The dock sits above content and content must reserve enough bottom padding so it never covers important actions or table rows.

- The dock should feel like a persistent app launcher, not a sidebar replacement and not a decorative nav strip.

### Header Submenus

The header is route-aware and contextual.

- The header title changes with the active route or module.

- The header submenu changes with the active route and its contextual paths.

- Each submenu trigger can reveal multiple related items or actions, like a macOS menu.

- Submenus should be compact in the header and reveal fuller labels, descriptions, and links inside the menu.

- Use submenus for route-local actions such as drafts, settings, profile sections, stock logs, invoice settings, and similar contextual destinations.

- Do not duplicate major module launchers in header submenus unless they are contextually relevant to the active module.

### Spotlight Surfaces

There are two related spotlight surfaces, and both depend on the route registry.

- `AppSpotlight.svelte` is the all-apps grid for modules that are not visible on the current dock due to screen-cap or priority.

- `SearchBar.svelte` is the command/search spotlight. At minimum it must search every menu and submenu route. Over time it should also search business content such as customers, orders, payments, products, and documents.

- Search results should include enough route metadata to make destinations clear: label, title, href, icon, and submenu context where useful.

- Quick actions can appear in spotlight search, but they should still route through central metadata or a typed action registry.

- Keep keyboard behavior first-class: open shortcut, arrow navigation, enter to select, escape to close.

### Sidebar Policy

Sidebars are not the default navigation pattern in Rallip.

- Avoid desktop sidebars for global navigation.

- Use a sidebar only when it is essential: mobile navigation fallback, page-specific tabs, dense detail navigation, or workflows where a side rail materially improves the task.

- A page-specific sidebar must not compete with the dock or duplicate the global module list.

- On mobile, drawer/sidebar behavior is acceptable when it exposes contextual submenus or protects limited screen space.

## Motion

Motion is subtle and functional.

- Base button/control transitions are around 160ms.

- Hover can lift controls slightly or change surface color.

- Active states can scale down slightly.

- Modal and sheet transitions should stay short, around 100-150ms.

- Icon animations may be used for navigation or command affordances, but should not distract from work.

Do not add decorative animation, animated backgrounds, or large page transitions unless the workflow needs it.

## Iconography And Brand

Use `@lucide/svelte` for interface icons. Keep stroke widths near the existing range and size icons to the control: often 14-18px in toolbars, 18-22px in cards and empty states.

Use `BrandIcon.svelte` for the logo and app mark. Do not recreate the logo in CSS or SVG markup.

## Copywriting

The app copy should sound like an operator's workspace:

- Use direct labels: `New sale`, `Create sale`, `Add payment`, `Mark delivered`, `Stock check`.

- Prefer concrete nouns over abstractions.

- Use NGN and Africa/Lagos assumptions unless business settings say otherwise.

- Empty states should say what is missing and what to do next.

- Avoid generic marketing copy inside the app.

## Accessibility

Accessibility is part of the design system:

- Every icon-only button needs an `aria-label`.

- Dialogs and sheets need clear titles and escape/close behavior.

- Form fields need labels and validation messages.

- Preserve visible focus states with primary rings.

- Keep contrast token-driven for light and dark modes.

- Do not hide essential actions behind hover-only UI on mobile.

## Anti-Patterns

Do not introduce:

- Raw `black`, `white`, `#000`, `#fff`, or arbitrary theme-breaking hex colors in UI code.

- Purple/blue gradient SaaS visuals, glassmorphism, decorative blobs, or hero sections.

- Oversized typography in operational screens.

- Nested cards or floating decorative section cards.

- Full page loads for normal app navigation.

- Layout shift when filters, selections, or optional controls appear.

- Deprecated Svelte patterns, `any`, `as any`, or `console.*`.

- Redundant Tailwind classes such as conflicting text color utilities.

## Before Shipping UI Work

For UI changes:

1. Read`APP-BIBLE.md`.
2. Reuse existing components and tokens.
3. Check mobile and desktop behavior.
4. Run the required Bun scripts available for the touched app.
5. Keep commits scoped to files you changed.
