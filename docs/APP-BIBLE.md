# CodeInOven   The App Bible

This is the canonical reference for the principles, philosophies, design language, and engineering standards of **CodeInOven**. Every contributor   human or agent   must read this document before making changes. When any other document conflicts with this one, this document wins. Project Engineering agents receive their operational behavior from the application prompt layer and its editable Agent behavior setting.

---

## 1. Product Vision

**CodeInOven is a desktop workstation for coordinated agentic software engineering.**

It is not a chat toy and not another IDE plugin. It is a control plane that coordinates AI coding agents (OpenCode, Claude Code, Codex, Muse Code, and more) through a clear, reviewable lifecycle:

```
specify → review → approve → implement
```

### Core philosophies

1. **Determinism over vibes.** Every agent run must be reproducible. Context is assembled explicitly (system, project, skills, MCPs, checklist, history)   never implicitly accumulated. If a run cannot be replayed from persisted state, it is a bug.
2. **The human reviews; the agent implements by default.** Engineering specifications stay editable through inline and section annotations, require explicit approval, and then guide implementation in the same thread. **Achievement** is the explicit project-mode exception: once enabled, it owns specification approval, recommended decisions, permission replies within the selected permission tier, implementation, and independent audit/rework cycles until the goal passes or reaches a hard terminal failure. Achievement never converts an internal question, specification, or audit into a human approval gate.
3. **Never touch what isn't yours.** CodeInOven persists all of its own state under its config directory (`~/.config/pillardash/codeinoven`). It never writes uninvited into the user's repository. Agents working _on_ CodeInOven follow the same ethic: surgical changes, never revert others' work, never reset blindly.
4. **Everything is auditable.** Atomic filesystem writes (`.tmp` then `rename`), chunked history, checkpoints, per-thread branches, and change tracking exist so that any session can be inspected, diffed, and rolled back.
5. **Bounded resources.** Threads per project are capped (default 70), history chunks are capped (4MB), pinned threads survive cleanup. Growth is always deliberate, never unbounded.
6. **The workstation feels like a workspace, not a website.** Dense, calm, operator-grade UI. No marketing gloss, no decorative motion, no layout shift.

### What CodeInOven is made of

- **Electron main process** (`src/main`): storage engine, CLI drivers, PTY/terminal service, chat engine, checkpoint manager, permission & scope policies, diagnostics, memory service, restart recovery.
- **Shared engines** (`src/lib`): project/thread managers, spec engine, plan engine, history engine, and provider adapters.
- **Renderer** (`src/renderer`): Svelte 5 UI   workspace shell, chat, terminal, stores   talking to main exclusively through the typed, validated IPC contract (`src/lib/ipc-contract.ts`).

The IPC contract is a hard boundary. Renderer code never reaches into Node APIs; main-process code never assumes renderer state. All messages are validated on both sides.

### How code is organised inside each layer

Heavy files are split by concern, and always into one of three shapes, so each
layer decomposes the same way instead of inventing a new structure per file:

- **Pure logic lives in plain `.ts` modules.** Rules with no reactive state and
  no DOM (partitioning, merging, formatting, validation, precedence) become
  exported functions that take everything they need as explicit arguments.
- **Reactive behaviour lives in `.svelte.ts` controllers.** A cohesive group of
  rune state plus the operations over it becomes a class, so a component owns
  rendering while the controller owns the state machine.
- **Cohesive markup lives in child `.svelte` components.** A region of a large
  template becomes a component with an explicit, typed prop surface.

Conventions that keep this safe to do incrementally:

- A split never changes a public prop or export. Callers keep importing the same
  name from the same path.
- New files are named after the unit they came from (`thread-turn-parts.ts`,
  `SourcesPanelHeader.svelte`, `git-store-deployments.svelte.ts`) so a reader can
  trace a module back to its owner and parallel work cannot collide on a generic
  name such as `helpers.ts`.
- When a module is split, the original file stays as the composition root and
  re-exports everything it exported before. `src/lib/types.ts` and
  `src/lib/ipc-contract.ts` are barrels over domain modules for exactly this
  reason.
- Each split ends with scoped `check`, `lint`, `format`, and relevant tests
  before it is committed as its own change.

### Reference map for the largest surfaces

**Conversation** (`src/renderer/lib/components/threads/`)
`ThreadView.svelte` is the composition root for a conversation surface. Its rules
live in focused siblings:

| Module | Owns |
| --- | --- |
| `thread-turn-parts.ts` | turn spans, working-trace part collection, final answer and audit matching |
| `thread-response-ranges.ts` | quoted-selection DOM geometry, highlight registry, bubble placement |
| `thread-message-presentation.ts` | display text, inline reference chips, trace previews, model/harness/token attribution |
| `thread-usage-merge.ts` | context-usage and rate-limit merge precedence |
| `thread-history.ts` | mounted-window size, history panel user list, multi-page jump reach |
| `thread-scroll-memory.ts` | per-thread viewport memory that survives a remount |
| `WorkingTrace*.svelte`, `SourcesPanel*.svelte`, `SubagentSessionView*.svelte` | the trace, sources, and sub-agent surfaces |

The studio region of `ThreadView.svelte` deliberately stays in the parent: each
branch is a single `SpecStudio`, `BrainstormStudio`, `PrdStudio`,
`AssignmentStudio`, or `AuditStudio` invocation wiring many props, so wrapping it
would add prop drilling rather than remove coupling. The checkpoint and
file-citation helpers stay for the same reason: they are already thin adapters
over `src/renderer/lib/threads/checkpoint-matching.ts`,
`src/renderer/lib/stores/project-files.svelte.ts`, and
`src/renderer/lib/stores/context-sidebar.svelte.ts`.

**Git** (`src/renderer/lib/components/git/`, `src/renderer/lib/stores/`)
`GitStatusPanel.svelte` composes `GitStatusPanelChangesView`, `BranchesView`,
`StashesView`, `CommitComposer`, `CommitSearch`, `Dialogs`, `Notices`, and
`RepoStates`. `stores/git.svelte.ts` is the composition root over
`git-store-{deployments,pull-requests,pr-conflicts,pr-operations,local-operations,github}.svelte.ts`
plus `git-store-helpers.ts`. `GitPullRequestDetail.svelte` composes the
`GitPullRequestDetail*` section components (Conversation, Changes, Checks,
AgentReport, MergeDialogs) and `GitPullRequestDetailCommentDialogs`, with its
pure presentation in `git-pull-request-detail-format.ts`.

**GitHub-authored content** (`src/main/git/`, `src/renderer/lib/components/markdown/`)
The renderer CSP allows images only from `data:` and local sources, so remote
pictures are inlined in main: `github-avatars.ts` for the accounts a conversation
names, `github-images.ts` for the images a provider-authored body embeds. Both
cache by URL and treat the URL as untrusted input. The renderer reaches them
through `stores/avatars.svelte.ts` and `stores/github-images.svelte.ts`, which
batch, cache, and bump a reactive version so the picture replaces the placeholder
in place. `markdown-remote-images.ts` holds the URL rules the renderer and the
store both need, so they cannot drift apart. Comment text itself is rendered by
`markdown/github-emoji.ts` (shortcodes) and `github-references.ts` (pull requests,
cross-repo issues, commits, mentions), both layered into `markdown/markdown.ts`.

**Workspace and shell** (`src/renderer/lib/components/workspace/`, `.../layout/`)
`Workspace.svelte` composes `WorkspaceSidebar`, `WorkspaceConversationPane`,
`WorkspaceContextPanelContent`, `WorkspaceTerminalDockContent`, the browser and
fullscreen surfaces, and the project dialogs, with sidebar state in
`WorkspaceSidebarController.svelte.ts` and browser state in
`WorkspaceBrowserController.svelte.ts`. `AppHeader.svelte` composes the view
switcher, scope tabs, git chip, editor menu, and thread modals, with navigation
state in `AppHeaderNavigationController.svelte.ts`.

**Composer** (`src/renderer/lib/components/chats/`)
`ChatComposer.svelte` composes the attachment strip, drop zone, image gate,
inference and permission pickers, and plus menu, with input handling split across
`chat-composer-{mentions,keydown,drop,paste,slash,attachments,settings,preview}`.

**Shared contracts** (`src/lib/`)
`types.ts` and `ipc-contract.ts` are barrels. The types live in
`src/lib/types/<domain>.ts` (one module per domain: common, project, scope, thread,
context, plan, provider, agent, agent-parts, usage, account, agent-message,
agent-events, checkpoints, brainstorm, prd, spec, assignment, audit, settings, git,
github, cloud, paths, cua, utility and the base-url provider). The IPC contract
lives in `src/lib/ipc/` as one partial contract per channel group plus `events.ts`.
Every consumer keeps importing `$shared/types` and `$shared/ipc-contract`.

**Main-process services** (`src/main/`)
- `chat/chat-engine.ts` keeps the `ChatEngine` class and composes
  `chat-engine/chat-engine-{prompts,changes,errors,constants,types,pure,message-merge,message-text,generated-artifacts,images}.ts`.
- `ipc/ipc-handlers.ts` is the composition root over one registrar per domain in
  `ipc/handlers/`; `ipc/ipc-validation.ts` is a barrel over `ipc/validation/`.
- Drivers compose per-harness module folders: `drivers/pi/` (+ `drivers/pi/tools/`),
  `drivers/codex/`, `drivers/claude-code/`, alongside the shared
  `drivers/persistent-cli-driver.ts` base.
- `git/git-service.ts` composes `git/git/`; `git/scope-worktree-service.ts` composes
  `git/scope-worktree/` (porcelain parsing, environment, git ops, setup, health, merge).
- `index.ts` keeps the boot sequence and composes `bootstrap/` (bootstrap state, data
  root, splash, keyboard shortcuts, open-with, session guards, post-paint services,
  shutdown pipeline, quit lifecycle, fatal startup).
- `browser/browser-service.ts` composes `browser/browser-service/`;
  `editor/project-files-service.ts` composes `editor/project-files/`;
  `workspaces/scope-tool-service.ts` composes `workspaces/scope-tool/`.
- Drivers that were split later follow the same pattern: `drivers/opencode/`,
  `drivers/muse/`, `drivers/persistent-cli/`, `drivers/cline/`.

**Shared engines** (`src/lib/engines/`)
`thread-manager.ts` composes `thread-manager-{capacity,deletion,lineage,search,transcripts,fork}.ts`
and `assignment-engine.ts` composes
`assignment-engine-{error,plan-lookup,snapshot,annotations,artifacts,audit-cycle,tasks,workers}.ts`.

**Speech** (`src/renderer/lib/speech/`)
`speech-controller.svelte.ts` keeps the rune state and orchestration over
`speech-controller-{types,capture,voice-send,artifacts,playback,cues}`.

**Renderer stores** (`src/renderer/lib/stores/`)
Each store is the composition root over its own prefixed modules:
`context-sidebar.svelte.ts` over `context-sidebar-{types,persistence,browser,tabs}`,
`project-files.svelte.ts` over `project-files-{state,explorer}`,
`thread-messages.svelte.ts` over `thread-messages-{merge,cache,events}`,
`scope.svelte.ts` over `scope-{board,threads,worktrees}`, and
`git.svelte.ts` over the `git-store-*` modules.

**App shell and Spec Studio**
`src/renderer/App.svelte` composes `app-{defaults,palette-actions,file-search,thread-search,project-switch,os-handoff,ipc-subscriptions}`.
`components/specs/SpecStudio.svelte` composes
`SpecStudio{Document,ResolutionSection,ContextSection,EditableListSection,EditableMiniList,AnnotationBubbles}.svelte`
plus `spec-studio-{document-anchors,draft-edits,formatting,context-picker}`.

**Settings, providers and shared pickers**
`settings/UtilityEditorModal.svelte`, `settings/SoundSettingsTab.svelte`,
`providers/AddProviderModal.svelte`, `shared/ModelPicker.svelte`,
`shared/RichMarkdownEditor.svelte`, `files/ProjectFileExplorer.svelte`,
`files/ProjectFilesPanel.svelte`, `settings/ProfileSettingsTab.svelte`,
`git/GitPullRequestDetail.svelte` and `git/GitPullRequestSheet.svelte` each keep
their public props and compose owner-prefixed section components plus one
`<owner>-helpers.ts` (or `-format.ts`) module for their pure logic. Destructive
confirmations in these surfaces all route through the shared `ConfirmDialog`.

---

## 2. Product Personality

CodeInOven should feel like a **precision instrument for professionals**:

- **Calm and confident.** The UI never shouts. Information density is high but hierarchy is unmistakable.
- **Operator-first.** Copy is direct and verb-driven (`New thread`, `Approve plan`, `Run checks`). No abstractions, no marketing language inside the app.
- **Trustworthy.** State transitions are visible, destructive actions are explicit, and nothing happens silently. The user always knows what an agent is doing and why.
- **Restrained luxury.** Obsidian, Ivory, and a whisper of Auric gold. The brand says "serious tool," not "SaaS landing page."

---

## 3. Design System

> Distilled from [`docs/DESIGN.md`](DESIGN.md). Note: `DESIGN.md` contains sections inherited from an earlier product (business/sales copy, SvelteKit dock navigation, `apps/app/src` paths). The token system, typography, layout density, motion, and accessibility rules below are canon for CodeInOven; interpret domain-specific examples through the lens of an agent workstation.

### 3.1 Visual direction

A restrained workspace aesthetic:

- Compact top navigation with contextual controls.
- Soft app canvas, raised surfaces, thin borders for structure.
- **Obsidian `#081825`** as the primary color.
- **Ivory `#F7F6F2`** as the light background.
- **Auric `#D4AF37`** as accent only   **under 5% of any screen** (badges, highlights).
- Strong numeric hierarchy with `tabular-nums`.
- **Satoshi** as the product typeface.
- **Lucide** icons (`@lucide/svelte`) for actions and module cues.
- Rounded, tactile controls without playful decoration.

The experience should resemble a focused professional dashboard, never a marketing homepage.

### 3.2 Theme tokens

Use the semantic Tailwind v4 tokens defined in the app stylesheet. **Never hardcode raw `black`, `white`, `#000`, `#fff`, or arbitrary hex values in UI markup.**

| Token                         | Purpose                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `bg-app`                      | Page/application background (Ivory light, Obsidian dark) |
| `bg-surface`                  | Primary panels, sections, tables                         |
| `bg-elevated`                 | Raised controls, row cards, hoverable elements           |
| `bg-overlay`                  | Active toolbar states, table heads, dropdown hovers      |
| `bg-raised`                   | Neutral chips, subtle separated zones                    |
| `text-foreground`             | Primary text (Obsidian light / Ivory dark)               |
| `text-muted`                  | Secondary copy and labels                                |
| `text-dimmed`                 | Tertiary hints, shortcuts, metadata                      |
| `bg-primary` / `text-primary` | Brand color                                              |
| `text-on-primary`             | Text/icons on primary actions                            |
| `bg-accent` / `text-accent`   | Auric gold   accent only, <5% usage                      |
| `bg-danger` / `text-danger`   | Destructive actions                                      |

Every new UI element must work in **both** light and dark themes through tokens, never one-off colors.

### 3.3 Typography

- Page titles: `text-xl`–`text-2xl`, `font-bold`/`font-semibold`, `tracking-tight`.
- Section titles: `text-sm`–`text-base`, `font-semibold`.
- Labels/table headers: `text-xs`, `font-semibold`, often uppercase with modest tracking.
- Body/help text: `text-sm`, `text-muted`, readable line height.
- Counts, metrics, durations: `tabular-nums`, strong weight, tight hierarchy.
- **Never** scale text with viewport width. **Never** use oversized display type inside operational screens.

### 3.4 Layout

- Dense, scannable layouts: full-width flow with constrained internal spacing.
- Standard rhythm: `space-y-6`; panels at `p-4`/`p-5`/`p-6`.
- `rounded-xl`/`rounded-2xl` for main panels and modals; `rounded-lg` for compact controls.
- Cards for repeated items, metrics, empty states, modals, framed tools. **Never nest cards inside cards.**
- Grids for metrics: `sm:grid-cols-2`, `xl:grid-cols-4`, or main/aside splits.
- **Stable dimensions everywhere.** Toolbars, filters, buttons, tables, and icon buttons must not cause layout shift when toggled.

### 3.5 Components

Reuse before you create:

- Prefer existing reusable components (`PageHeader`, `DataTable`, `StatusPill`, `EmptyState`, `Modal`, `SideSheet`, form components) and the shared component library in `src/renderer/lib/components`.
- **Bits UI** is the foundation for dropdowns, dialogs, accordions, checkboxes, and other primitives. Create a new primitive only when bits-ui does not provide a suitable foundation.
- **Switches, never checkboxes.** Every on/off control uses the reusable `Switch` component (`src/renderer/lib/components/ui/Switch.svelte`). Checkbox inputs and checkbox semantics are forbidden anywhere in the app (markdown task-list checkboxes rendered as user content are the only exception).
- **Tooltips are never native.** The native `title` tooltip is unreliable. The custom tooltip system (`Tooltip`/`TooltipHost`) shows a reliable tooltip after 1500ms of hover for every element with a `title` attribute, so keep using `title`/`aria-label` and never build ad-hoc tooltip behavior.
- If a component will be used in two or more places, make it reusable.
- Use `StatusPill` for statuses instead of freeform colored text.
- **One modal shell, many placements.** Every surface that blocks the window renders through the canonical `Modal` (`src/renderer/lib/components/ui/Modal.svelte`), directly or as a thin variant on top of it: `ConfirmDialog`, `SideSheet`, `BottomSheet`, `ActionSheet`, the full screen editors and readers, the media lightbox, and the command palettes. The base owns the portal, the scrim, the `z-60` layer, the panel shell (header, scrolling body, and a footer that never scrolls), initial focus, Escape, the backdrop, Cmd/Ctrl+W and Cmd/Ctrl+Enter, and browser-view suppression. A variant only picks a `placement` (`center`, `right`, `bottom`, `palette`, `fullscreen`), a `size`, and whether it draws the canonical `chrome` or owns its own header. A surface whose Escape means "go back" claims the key through the base's `onEscapeKeydown` hook (the command palette's nested screens do this: the first Escape returns to the actions list, the next one closes the palette) instead of hand-rolling an Escape listener. Never hand-roll an overlay, and never import bits-ui's `Dialog` outside `Modal`. `DockableModal` is the exception: it is a draggable, dockable, non-blocking panel, not a modal.
- Destructive actions confirm through the shared `ConfirmDialog` (`src/renderer/lib/components/ui/ConfirmDialog.svelte`) instead of a hand-rolled modal footer.
- Empty states must explain what is missing and offer one concrete next action.

### 3.6 Buttons and controls

- Primary: `bg-primary text-on-primary hover:bg-primary-hover`.
- Secondary: tokenized borders + elevated/overlay hover states.
- Accent (sparingly): `bg-accent text-on-primary hover:bg-accent-hover`.
- Minimum action height: `h-8`/`h-9`/`h-10` or `min-h-[36px]`.
- Lucide icons inside action buttons when the action benefits from a recognizable symbol.
- **Icon-only controls require accessible labels (`aria-label`).**
- `rounded-lg`/`rounded-xl` normally; fully-rounded reserved for avatars, circular icon buttons, and pills.
- Boolean Svelte props use the shorthand: `<Button active>`   never `active={true}`.
- Use standard Tailwind classes where they exist: `z-10`, never `z-[10]`.

### 3.7 Overlays and navigation

- Desktop modals: centered, tokenized surfaces, thin borders, subtle ring, short scale/fade transitions.
- Side sheets for focused editing and detail workflows.
- Backdrops use tokenized overlays with light blur where established.
- Navigation is instant and app-like   never full page reloads for in-app actions.
- **The spotlight is one mounted surface, not one per screen.** Its home screen and its nested screens (file search, thread search, switch project) are content swapped inside a single `Modal` shell, driven by one screen id in `src/renderer/App.svelte`. Unmounting one palette and mounting the next threw the scrim, the panel, the scroll lock and the focus away and rebuilt them, which flashed on every hop; one instance with a swapped `screenKey` keeps the panel, the query input and its focus in place.
- Route/view metadata should live in a central registry; header titles derive from the active view, never hardcoded copies that can drift.

### 3.8 Motion

Motion is subtle and functional:

- Base control transitions ≈160ms; modal/sheet transitions 100–150ms.
- Hover may lift or recolor surfaces; active states may scale down slightly.
- No decorative animation, animated backgrounds, or large page transitions.

### 3.9 Iconography and brand

- `@lucide/svelte` for interface icons; 14–18px in toolbars, 18–22px in cards and empty states; keep stroke widths consistent.
- Use the brand icon component for the logo/app mark. Never recreate the logo in CSS or ad-hoc SVG markup.
- Two brand marks exist and neither substitutes for the other. Vendor surfaces (model picker, `cio-` providers, about rows) use the tile-free mark (`src/renderer/static/icon-mark.svg`, bundled as `vendor-icons/icons/cio.svg`), whose ink follows its surface. The `.cio` scratch folder wears the full app icon (`src/renderer/static/icon.svg`) with its tile, gloss and ember glow, because that is the artwork CodeInOven is recognised by. Both are vendored into the renderer as committed copies by `scripts/generate-brand-icons.ts`; never import anything from `src/renderer/static/` (the renderer's `publicDir`) from JavaScript.
- Never recreate either mark in CSS or ad-hoc SVG markup.
- The brand name flows from the single brand constant (`src/lib/brand.ts`). Never hardcode the product name in UI or build config.

### 3.10 Copywriting

- Direct, verb-first labels: `New thread`, `Approve plan`, `Create checkpoint`, `Export diagnostics`.
- Concrete nouns over abstractions.
- Empty states say what is missing and what to do next.
- No generic marketing copy inside the app.
- Absolute dates and times read the same on every machine: `src/lib/date-time-format.ts` renders `Sep 23, 2026, 8:05 AM`. Never hand a date to a bare `toLocaleString()`, which falls back to the operating system's locale and its numeric, seconds-bearing `9/23/2026, 8:05:00 AM` shape.
- Clocks are 12-hour with am/pm on every machine. The same module owns the shapes (`formatTime` renders `8:05 AM`), and a time persisted in the machine format `HH:mm` goes through `formatTimeOfDay`, so a stored `08:05` reads `8:05 AM` and never `08:05`. Never leave the locale argument as `undefined` or `[]`: that hands the clock to the operating system, and a 24-hour locale prints `08:05`.

### 3.11 Accessibility

Accessibility is part of the design system, not an afterthought:

- Every icon-only button needs an `aria-label`.
- Dialogs and sheets need clear titles and escape/close behavior.
- Form fields need labels and validation messages.
- Preserve visible focus states with primary rings.
- Keep contrast token-driven in both themes.
- Never hide essential actions behind hover-only UI.

### 3.12 Design anti-patterns (forbidden)

- Raw `black`/`white`/hex colors in UI code.
- Purple/blue gradient SaaS visuals, glassmorphism, decorative blobs, hero sections.
- Oversized typography in operational screens.
- Nested cards or floating decorative section cards.
- Full page loads for normal app navigation.
- Layout shift when filters, selections, or optional controls appear.
- Deprecated Svelte patterns, `any`, `as any`, or `console.*`.
- Redundant/conflicting Tailwind classes (e.g., two text color utilities on one element).
- Checkbox inputs or checkbox semantics for on/off controls   always the reusable `Switch`.
- Relying on the native `title` tooltip   all tooltips go through the custom tooltip system.

---

## 4. Engineering Standards

### 4.1 Toolchain

- **Bun only for CodeInOven development.** Repository installs, scripts, checks, builds, and releases go through `bun`. This is a contributor toolchain rule, never an assumption that a packaged-app user's GUI environment contains Bun.
- **TypeScript everywhere**, strict. The type `any` is forbidden   including `variable as any`. Model the type properly or fix the design.
- **Svelte 5 (runes) + Tailwind v4** in the renderer. Always use current Svelte 5 idioms and consult the latest Svelte documentation (via the Svelte MCP)   no deprecated patterns.
- Never import SvelteKit-only modules (`$app/*`) into shared utilities, domain modules, or anything bundled outside the app runtime. For runtime detection in shared code, use platform-safe checks (`typeof window !== 'undefined'`) or inject the value from an entrypoint.

### 4.2 Logging

- `console.*` is **forbidden** anywhere in the codebase.
- Use the `Logger` class (`src/main/system/logger.ts`). Dev-only output goes through `Logger.dev`.
- **Durable logs are partitioned by local day.** Every sink lives in `logs/<YYYY-MM-DD>/` under the config root (`logs/2026-09-24/main.jsonl`), so one incident reads one folder instead of one ever-growing file. Build the path through `dailyLogRelativePath` in `src/main/system/log-paths.ts` on every append   never hardcode a flat `logs/<file>` path in a writer, and never resolve a day once at startup. Readers go through `src/main/system/log-reader.ts` (bounded day listing plus a tail-capped read) and still understand a pre-split flat `logs/<file>` path.

### 4.3 Verification commands (scoped, never repo-wide)

Unless explicitly asked to run against the whole project:

| Purpose             | Command                  |
| ------------------- | ------------------------ |
| Type/Svelte check   | `bun run check [FILES]`  |
| Lint                | `bun run lint [FILES]`   |
| Auto-fix formatting | `bun run format [FILES]` |
| Tests               | `bun run test [FILES]`   |


### 4.4 Architecture rules

- Respect the layer boundaries: renderer ↔ typed IPC contract ↔ main process. No shortcuts around IPC validation.
- **Split by concern, not by line count.** A heavy file is decomposed into the three shapes above: pure functions in a plain `.ts` module, rune state plus its operations in a `.svelte.ts` controller, and a cohesive markup region as a child `.svelte` component. A structural split changes no public prop and no export, moves code rather than rewriting it, and ships as its own verified commit.
- All persistent writes are atomic (write `.tmp`, then `rename`) via the storage engine   never ad-hoc `fs.writeFile` for state.
- **Reads on interaction paths never run on the Electron main thread.** A synchronous `db.get`/`db.all` there holds the whole main process for as long as the OS takes to serve the statement: a query that costs 0.04 ms against the real database has been measured at 20-890 ms on the main thread, where a page fault into the mmap'd file or a busy WAL lands inside the call and stalls a frame. Interaction paths read through `Database.queryViaWorker` or a repository's `...ViaWorker` method; the synchronous API is reserved for startup, migrations, write transactions, and the primary-connection fallback a worker-backed read takes when no worker exists. `tests/main/database/main-thread-sqlite-guard.test.ts` holds the current allowance per file, and a statement that does hold the main thread past one frame is reported with the call site that issued it, so a regression names itself in `logs/<YYYY-MM-DD>/main.jsonl`.
- Drivers implement `driver.interface.ts`; adapters implement `adapter.interface.ts`. New providers plug in via those contracts, never via special-cased branches.
- CodeInOven's own state lives under its config directory only. Never write into a user's repository from app code.
- Model-ranking data retention is intentional and asymmetric: `model_ranking_snapshots` is a transient grading queue whose rows are hard-deleted the moment their 0–10 judge score is applied to the permanent `model_rankings` aggregate (never deleted unscored   judge failures stay parked as `failed` for recovery). Historical reconstruction of deleted snapshots is deliberately unavailable; the aggregate stays auditable through `rubric_version`, `calc_version`, and per-category sample counts instead. Do not add archival copies or rebuild mechanisms for processed snapshots.

### 4.5 External process and package-manager invariant

Electron GUI processes do not reliably inherit a user's interactive-shell `PATH`. Every main-process feature that probes or launches an external command must therefore use the single process environment and resolution boundary in `src/main/drivers/cli-environment.ts`:

- Build the environment with `buildProcessEnvironment`; never pass raw `process.env` to a new external process. User-owned detached applications must opt out of the app-owned process marker so lifecycle cleanup cannot reap them.
- Resolve PATH-based executables with `resolveExecutablePath` whenever probing, selecting, or persisting a command path. A structured command-name launch is allowed only with the normalized environment; it must never use raw Electron `process.env` or duplicate PATH lookup.
- Run third-party JavaScript packages through `resolvePackageCommand`. Bun is preferred, with npm/npx, pnpm, and Yarn supported as fallbacks. A user-facing feature must not require Bun unless Bun itself is the feature's explicit runtime.
- Preserve the user's selected runtime and package-manager paths. The shared environment owns support for GUI-safe system locations plus nvm/nvm-windows, Volta, fnm, asdf, mise, Bun, npm, pnpm, and Yarn locations.
- Windows `.cmd`/`.bat` package-manager shims may use the shared shell decision helper. Shell execution is otherwise forbidden for package installation; arguments remain a structured array.
- OS-owned commands at fixed platform locations and children of an already-normalized app-owned process may inherit their existing environment. Any such exception must be explicit in code and must not duplicate PATH construction.

Direct `spawn('bun', ...)`, `spawn('node', ...)`, `spawn('npm', ...)`, ad-hoc `PATH` concatenation, and feature-local package-manager selection are architectural violations. New runtime and version-manager edge cases are fixed once in the shared boundary and inherited by every caller.

---

### 4.6 Scopes own workspace roots

Scopes   not threads, renderer state, or individual services   are the single
authority for a repository root.

- Every scope persists a **root descriptor** on its version 2 board. The Default
  scope and migrated custom scopes use `{ kind: 'project' }`; an explicitly
  isolated scope uses a managed descriptor with `directoryName`, `branch`,
  `baseBranch`, `baseCommit`, `createdAt`, `environmentMode`, and `setup` state.
- Managed worktree paths are derived only beneath CodeInOven's per-project
  config directory (`<config-root>/projects/<project-id>/scope/<directory-name>`).
  The renderer never selects or supplies absolute worktree paths.
- `ScopeRootResolver` in `src/main/workspaces/scope-root-resolver.ts` is the only
  authority converting a `{ projectId, scopeBucketId }` target into a filesystem
  root. Unhealthy managed scopes fail closed with a typed health category and
  never fall back to the project directory.
- `Thread.workingDirectory` is compatibility data, not authority. Creation,
  movement, forks, and worker generation re-derive roots from the scope at
  execution time.
- Renderer layout saves cannot overwrite lifecycle metadata: boards are mutated
  through validated main-owned operations (layout, appearance, create, archive,
  worktree attach/detach, delete).
- Same-scope threads and agents intentionally share one root; separate managed
  worktree scopes are the isolation boundary.
- Every destructive lifecycle action is guarded by a state-bound, single-use
  confirmation preflight (dirty files, unpushed commits, active processes) and
  a confirmation dialog.

See `docs/GIT-WORKTREES.md` for the full operator-facing lifecycle, setup
structure, environment modes, health categories, and confirmations.

---


## 5. Agent Workflow Contract

These rules bind every AI agent contributing to this repository. The operational work ethic is supplied by CodeInOven's application prompt layer and can be edited in Settings → Agents → Agent behavior:

### 5.1 Planning and progress

- Before starting a task: write a plan file with the current phase declared at the top, checkbox tasks, and mark items in-progress/completed as you go.
- After finishing: update the progress file with what was done and what's next.
- All documentation output (plan*.md, progress*.md, test output, walkthroughs) lives in the matching `.cio/` subfolder: `.cio/work/<feature>/` for chats, `.cio/specs/<feature-slug>/` in Engineering. Disposable scratch lives in `.cio/tmp/`. Never pollute the repo root, and never drop files at the `.cio/` root.
- If plan/progress files were overwritten by someone else since your last edit, create `plan-[feature].md` / `progress-[feature].md` instead. Never destroy another agent's records.
- Work phases to exhaustion   don't stop halfway through a declared phase.
- If confused at any point, **ask clarifying questions. Never assume.**

### 5.2 Git discipline

- Commit contextually when a plan/unit of work is done, so work can be rolled back.
- Prefix commits with your agent name: `(MODEL_NAME) feat: ...`.
- Commit **only the files you worked on**   never `git commit .` or `git commit -A`.
- Never commit ignored files.
- **Never `git push`**, regardless of how many commits behind the branch is.
- **Never `git reset` blindly.** To revert, list files individually. Never cause anyone to lose changes.
- If you see changes you did not make: never revert them. Work surgically around them.

### 5.3 Reporting

When work is complete, deliver a brief report: what was done, what went wrong and how it was fixed, all files changed, and the commit hash   one clean, auditable summary.

### 5.4 Tooling

- Always use the available MCPs/skills for the technology at hand (e.g., the Svelte MCP for Svelte docs, autofixing, and validation).

---

## 6. The Oath

Before shipping any change to CodeInOven:

1. Read this bible.
2. Reuse existing components, tokens, engines, and contracts before creating new ones.
3. Keep the lifecycle deterministic and auditable   no silent side effects.
4. Verify in both themes and at both desktop densities where UI is touched.
5. Run the scoped check/lint/format/test commands and fix everything.
6. Commit only your own files, contextually, with your name on it.

CodeInOven exists so that agentic software engineering is **coordinated, deterministic, and trustworthy**. Every line of code either serves that or doesn't belong here.
