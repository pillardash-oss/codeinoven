# CodeInOven — The App Bible

This is the canonical reference for the principles, philosophies, design language, and engineering standards of **CodeInOven**. Every contributor — human or agent — must read this document before making changes. When any other document conflicts with this one, this document wins (except `AGENTS.md` operational rules, which remain binding for agents).

---

## 1. Product Vision

**CodeInOven is a desktop workstation for coordinated agentic software engineering.**

It is not a chat toy and not another IDE plugin. It is a control plane that coordinates AI coding agents (OpenCode, Claude Code, Codex, Muse Code, and more) through a clear, reviewable lifecycle:

```
specify → review → approve → implement
```

### Core philosophies

1. **Determinism over vibes.** Every agent run must be reproducible. Context is assembled explicitly (system, project, skills, MCPs, checklist, history) — never implicitly accumulated. If a run cannot be replayed from persisted state, it is a bug.
2. **The human reviews; the agent implements by default.** Engineering specifications stay editable through inline and section annotations, require explicit approval, and then guide implementation in the same thread. **Achievement** is the explicit project-mode exception: once enabled, it owns specification approval, recommended decisions, permission replies within the selected permission tier, implementation, and independent audit/rework cycles until the goal passes or reaches a hard terminal failure. Achievement never converts an internal question, specification, or audit into a human approval gate.
3. **Never touch what isn't yours.** CodeInOven persists all of its own state under its config directory (`~/.config/pillardash/codeinoven`). It never writes uninvited into the user's repository. Agents working _on_ CodeInOven follow the same ethic: surgical changes, never revert others' work, never reset blindly.
4. **Everything is auditable.** Atomic filesystem writes (`.tmp` then `rename`), chunked history, checkpoints, per-thread branches, and change tracking exist so that any session can be inspected, diffed, and rolled back.
5. **Bounded resources.** Threads per project are capped (default 70), history chunks are capped (4MB), pinned threads survive cleanup. Growth is always deliberate, never unbounded.
6. **The workstation feels like a workspace, not a website.** Dense, calm, operator-grade UI. No marketing gloss, no decorative motion, no layout shift.

### What CodeInOven is made of

- **Electron main process** (`src/main`): storage engine, CLI drivers, PTY/terminal service, chat engine, checkpoint manager, permission & scope policies, diagnostics, memory service, restart recovery.
- **Shared engines** (`src/lib`): project/thread managers, spec engine, plan engine, history engine, and provider adapters.
- **Renderer** (`src/renderer`): Svelte 5 UI — workspace shell, chat, terminal, stores — talking to main exclusively through the typed, validated IPC contract (`src/lib/ipc-contract.ts`).

The IPC contract is a hard boundary. Renderer code never reaches into Node APIs; main-process code never assumes renderer state. All messages are validated on both sides.

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
- **Auric `#D4AF37`** as accent only — **under 5% of any screen** (badges, highlights).
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
| `bg-accent` / `text-accent`   | Auric gold — accent only, <5% usage                      |
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
- Empty states must explain what is missing and offer one concrete next action.

### 3.6 Buttons and controls

- Primary: `bg-primary text-on-primary hover:bg-primary-hover`.
- Secondary: tokenized borders + elevated/overlay hover states.
- Accent (sparingly): `bg-accent text-on-primary hover:bg-accent-hover`.
- Minimum action height: `h-8`/`h-9`/`h-10` or `min-h-[36px]`.
- Lucide icons inside action buttons when the action benefits from a recognizable symbol.
- **Icon-only controls require accessible labels (`aria-label`).**
- `rounded-lg`/`rounded-xl` normally; fully-rounded reserved for avatars, circular icon buttons, and pills.
- Boolean Svelte props use the shorthand: `<Button active>` — never `active={true}`.
- Use standard Tailwind classes where they exist: `z-10`, never `z-[10]`.

### 3.7 Overlays and navigation

- Desktop modals: centered, tokenized surfaces, thin borders, subtle ring, short scale/fade transitions.
- Side sheets for focused editing and detail workflows.
- Backdrops use tokenized overlays with light blur where established.
- Navigation is instant and app-like — never full page reloads for in-app actions.
- Route/view metadata should live in a central registry; header titles derive from the active view, never hardcoded copies that can drift.

### 3.8 Motion

Motion is subtle and functional:

- Base control transitions ≈160ms; modal/sheet transitions 100–150ms.
- Hover may lift or recolor surfaces; active states may scale down slightly.
- No decorative animation, animated backgrounds, or large page transitions.

### 3.9 Iconography and brand

- `@lucide/svelte` for interface icons; 14–18px in toolbars, 18–22px in cards and empty states; keep stroke widths consistent.
- Use the brand icon component for the logo/app mark. Never recreate the logo in CSS or ad-hoc SVG markup.
- The brand name flows from the single brand constant (`src/lib/brand.ts`). Never hardcode the product name in UI or build config.

### 3.10 Copywriting

- Direct, verb-first labels: `New thread`, `Approve plan`, `Create checkpoint`, `Export diagnostics`.
- Concrete nouns over abstractions.
- Empty states say what is missing and what to do next.
- No generic marketing copy inside the app.

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
- Checkbox inputs or checkbox semantics for on/off controls — always the reusable `Switch`.
- Relying on the native `title` tooltip — all tooltips go through the custom tooltip system.

---

## 4. Engineering Standards

### 4.1 Toolchain

- **Bun only.** All installs, scripts, and runs go through `bun`.
- **TypeScript everywhere**, strict. The type `any` is forbidden — including `variable as any`. Model the type properly or fix the design.
- **Svelte 5 (runes) + Tailwind v4** in the renderer. Always use current Svelte 5 idioms and consult the latest Svelte documentation (via the Svelte MCP) — no deprecated patterns.
- Never import SvelteKit-only modules (`$app/*`) into shared utilities, domain modules, or anything bundled outside the app runtime. For runtime detection in shared code, use platform-safe checks (`typeof window !== 'undefined'`) or inject the value from an entrypoint.

### 4.2 Logging

- `console.*` is **forbidden** anywhere in the codebase.
- Use the `Logger` class (`src/main/logger.ts`). Dev-only output goes through `Logger.dev`.

### 4.3 Verification commands (scoped, never repo-wide)

Unless explicitly asked to run against the whole project:

| Purpose             | Command                  |
| ------------------- | ------------------------ |
| Type/Svelte check   | `bun run check [FILES]`  |
| Lint                | `bun run lint [FILES]`   |
| Auto-fix formatting | `bun run format [FILES]` |
| Tests               | `bun run test [FILES]`   |

- **Never run `bun run dev`** as a verification step; use `bun run check` instead.
- Only check/lint/format/test the files you worked on and the files that import them.
- Run existing tests **before** changing code (baseline) and **after** (regression check).
- Test output goes to `agent-out/test-result/` named `(feature)-baseline.txt`, `(feature)-(n).txt`, or `(feature)-final.txt`. Grep out only the failures/warnings you need — do not flood context with full logs.
- Do not write new tests unless explicitly asked.
- Before declaring any work done: run the applicable check, lint, format, and test commands and fix all errors.

### 4.4 Architecture rules

- Respect the layer boundaries: renderer ↔ typed IPC contract ↔ main process. No shortcuts around IPC validation.
- All persistent writes are atomic (write `.tmp`, then `rename`) via the storage engine — never ad-hoc `fs.writeFile` for state.
- Drivers implement `driver.interface.ts`; adapters implement `adapter.interface.ts`. New providers plug in via those contracts, never via special-cased branches.
- CodeInOven's own state lives under its config directory only. Never write into a user's repository from app code.

---

## 5. Agent Workflow Contract

These rules bind every AI agent contributing to this repository (see `AGENTS.md` for the authoritative operational text):

### 5.1 Planning and progress

- Before starting a task: write a plan file with the current phase declared at the top, checkbox tasks, and mark items in-progress/completed as you go.
- After finishing: update the progress file with what was done and what's next.
- All documentation output (plan*.md, progress*.md, test output, walkthroughs) lives in `agent-out/` — never pollute the repo root.
- If plan/progress files were overwritten by someone else since your last edit, create `plan-[feature].md` / `progress-[feature].md` instead. Never destroy another agent's records.
- Work phases to exhaustion — don't stop halfway through a declared phase.
- If confused at any point, **ask clarifying questions. Never assume.**

### 5.2 Git discipline

- Commit contextually when a plan/unit of work is done, so work can be rolled back.
- Prefix commits with your agent name: `(MODEL_NAME) feat: ...`.
- Commit **only the files you worked on** — never `git commit .` or `git commit -A`.
- Never commit ignored files.
- **Never `git push`**, regardless of how many commits behind the branch is.
- **Never `git reset` blindly.** To revert, list files individually. Never cause anyone to lose changes.
- If you see changes you did not make: never revert them. Work surgically around them.

### 5.3 Reporting

When work is complete, deliver a brief report: what was done, what went wrong and how it was fixed, all files changed, and the commit hash — one clean, auditable summary.

### 5.4 Tooling

- Always use the available MCPs/skills for the technology at hand (e.g., the Svelte MCP for Svelte docs, autofixing, and validation).

---

## 6. The Oath

Before shipping any change to CodeInOven:

1. Read this bible.
2. Reuse existing components, tokens, engines, and contracts before creating new ones.
3. Keep the lifecycle deterministic and auditable — no silent side effects.
4. Verify in both themes and at both desktop densities where UI is touched.
5. Run the scoped check/lint/format/test commands and fix everything.
6. Commit only your own files, contextually, with your name on it.

CodeInOven exists so that agentic software engineering is **coordinated, deterministic, and trustworthy**. Every line of code either serves that or doesn't belong here.
