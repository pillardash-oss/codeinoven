# Contributing to CodeInOven

Thank you for considering a contribution. CodeInOven is a precision instrument for coordinated agentic software engineering, and it stays that way only if every change earns its place. Read this whole document before you start — the ground rules below are non-negotiable.

---

## The ground rules

Four rules govern every contribution. A change that violates any of them will not be merged, no matter how well it is engineered.

### 1. Never cause a regression

Your change must not break anything that already works.

- Run the existing test suite for the files you touch **before** you start (baseline) and **after** you finish (regression check). If behavior changed, prove the change is intended and covered.
- Do not silently alter the IPC contract, thread/project state transitions, or persisted storage shapes. If a change is additive, keep it backward compatible.
- Never revert, reformat, or rewrite someone else's work as a side effect. Work surgically: change only what your feature or fix requires.
- If you see changes you did not make, leave them alone. Do not `git reset` blindly or discard others' work to make your branch cleaner.

### 2. Never introduce a performance glitch

CodeInOven is a desktop workstation. Users run it with many threads, large projects, and long agent sessions. Latency and memory are part of the product.

- Profile before you optimize, and optimize before you merge. Any change that adds per-message, per-thread, per-frame, or per-keystroke work must be justified and measured.
- The renderer talks to the main process only through the validated IPC contract. Do not add chatty IPC, unbounded subscriptions, or renderer-side work that duplicates main-process state.
- Do not create unbounded in-memory growth: chunked history, capped threads, and deliberate caches exist on purpose. Match those bounds.
- Svelte reactivity is cheap when used correctly. Do not overuse `$effect`, and never build "derived everything" graphs that recompute whole trees on every keystroke.
- If your change can be measured, measure it and share the numbers (before/after) in your PR description.

### 3. Only build features you actually use

Every feature must be a feature **you use today** — not something you imagine someone might want someday.

- The best signal of a real feature is that you hit the problem yourself, in your own work, and this change removes it for you.
- If you wouldn't personally open the app and use what you built, do not build it.

### 4. No vanity features — build for a group, not a show

A feature that only flatters its author does not belong here. A feature earns its place when it serves **you and a group of other people** solving the same real problem.

- Ask: _Who besides me will use this?_ If the honest answer is "no one I can name," it is vanity.
- Favor features that remove friction for a class of users (e.g. anyone coordinating multi-agent work on a large repo) over one-off conveniences that only match your personal setup.
- Prefer fixing a real shared pain over adding surface polish. The UI is calm and dense on purpose — decorative additions are not contributions.
- "It would be cool" is not a reason. "I needed this three times this week" is.

> **The test:** your contribution must pass all three questions — _Did you hit this problem yourself? Do you use the result? Do other people share the problem?_ If you can't answer yes to all three, take the idea back to a discussion before writing code.

---

## Before you start

1. **Open an issue or discussion first** for anything beyond a small fix. Describe the problem you hit, who else it affects, and the change you propose. This catches vanity features and duplicates early, and it lets maintainers point you at existing design.
2. **Read the source of truth:** `APP-BIBLE.md` defines the product philosophy and engineering standards, and `DESIGN.md` defines the visual language. The top-level `AGENTS.md` contains the operational rules agents follow. If a document conflicts with `APP-BIBLE.md`, the Bible wins.
3. **Make a plan.** Before writing code, write a short plan with your phases and keep it updated as you work. Keep all planning and progress documents under `agent-out/` — never pollute the repo root.
4. **Understand the architecture** (see [Architecture rules](#architecture-rules)) so your change lands in the right layer.

---

## Definition of done

A contribution is done when **all** of the following hold:

- [ ] No regressions: baseline and post-change tests pass for every file you touched and everything that imports them.
- [ ] No performance glitches: measured (or clearly justified) as free of meaningful regressions; no new unbounded growth or chatty IPC.
- [ ] Real feature: you use it, and it serves a group of people with the same problem. No vanity features.
- [ ] Scoped verification passes: check, lint, format, and test on the files you changed (see [Verification](#verification)).
- [ ] Follows the engineering standards below (TypeScript strict, Svelte 5 idioms, `Logger` only, no `console.*`, no `any`).
- [ ] Documented: user-facing behavior is reflected in the README where relevant.
- [ ] Committed contextually, scoped to your files, with a clear message.

---

## Engineering standards

- **Bun is the only package manager and runner.** Never use npm/yarn/pnpm. Node ≥ 22.13.0 is required.
- **TypeScript, strict.** The type `any` — including `as any` — is forbidden anywhere. Model the type properly or fix the design.
- **Svelte 5 (runes) + Tailwind v4** in the renderer. Use current Svelte 5 idioms and consult the latest Svelte documentation; no deprecated patterns.
- **Logging:** `console.*` is forbidden. Use the `Logger` class (`src/main/logger.ts`); dev-only output goes through `Logger.dev`.
- **No checkboxes.** On/off controls always use the reusable `Switch` component. Checkbox inputs/semantics are forbidden (markdown task-list checkboxes rendered as user content are the only exception).
- **Accessibility is part of the design system.** Every icon-only button needs both a descriptive `title` and `aria-label`. Dialogs need titles and escape/close behavior. Form fields need labels and validation. Never hide essential actions behind hover-only UI.
- **Tooltips are never native.** The native `title` tooltip is unreliable; the custom tooltip system (`Tooltip`/`TooltipHost`) renders reliably after 1500ms of hover. Keep `title`/`aria-label` attributes and never build ad-hoc tooltip behavior.
- **Tokens, not raw values.** Use the semantic Tailwind v4 tokens (`bg-app`, `text-foreground`, etc.) in both light and dark themes. Never hardcode `black`, `white`, or arbitrary hex colors in UI markup.
- **Reuse before you create.** Prefer existing components and engines; create a new primitive only when bits-ui or the shared library does not provide a foundation.
- **No deprecated code**, no redundant/conflicting Tailwind classes, and no arbitrary `z-[10]`-style classes where `z-10` exists.

### Verification

Verification is **scoped** — you check, lint, format, and test only the files you worked on and the files that import them. Never run whole-repo verification unless explicitly asked.

| Purpose             | Command                  |
| ------------------- | ------------------------ |
| Type/Svelte check   | `bun run check [FILES]`  |
| Lint                | `bun run lint [FILES]`   |
| Auto-fix formatting | `bun run format [FILES]` |
| Tests               | `bun run test [FILES]`   |

- Never use `bun run dev` as a verification step.
- Run tests before changing code (baseline) and after (regression check), and confirm nothing regressed.
- If you are unsure whether a full `bun run verify` is appropriate, ask.

---

## Architecture rules

Respect the layer boundaries — this is what keeps the app deterministic and auditable:

- **Renderer ↔ IPC ↔ main.** The renderer never reaches into Node APIs; the main process never assumes renderer state. All messages flow through the typed, validated IPC contract (`src/lib/ipc-contract.ts`) and are validated on both sides.
- **Atomic writes.** All persistent state writes go through the storage engine (write `.tmp`, then rename). Never ad-hoc `fs.writeFile` for app state.
- **Drivers and adapters.** Harnesses implement `driver.interface.ts`; providers implement `adapter.interface.ts`. New harnesses/providers plug in via those contracts — never via special-cased branches.
- **Config directory only.** CodeInOven persists its own state under its config directory (`~/.config/pillardash/codeinoven`). App code never writes uninvited into a user's repository.
- **Shared code stays framework-free.** Never import SvelteKit-only modules (`$app/*`) into shared utilities, domain modules, or anything bundled outside the SvelteKit app runtime. Use platform-safe checks (`typeof window !== 'undefined'`) or inject values from entrypoints.

## Security-sensitive changes

CodeInOven shells out to harness CLIs and manages provider credentials, so
some changes get extra review scrutiny:

- **Any change that spawns processes** (new `child_process`, PTY, `exec`,
  `spawn`, or a new shelling-out path in a driver) must be flagged explicitly
  in the PR description and justified. Reviewers will not merge silent new
  execution paths.
- **Credential handling** goes through `SecretVault` (`safeStorage`) in the
  main process only — plaintext must never cross IPC. Do not log auth tokens,
  API keys, or full request headers.
- **New dependencies** that run install-time scripts expand the
  supply-chain surface. Only `electron` is in `trustedDependencies`; justify
  any addition in the PR.
- **Secrets scanning** runs on every push (Gitleaks) and `bun audit` runs in
  CI. Do not commit `.env` files or tokens.

---

## Git and pull requests

- **Work on a branch** (or fork) and open a pull request against `main`. The quality workflow (check + lint + test + production build) runs on every PR and must pass before merge.
- **Commit contextually.** One unit of work per commit, scoped to the files you changed. Never `git commit .` or `git commit -A`.
- **Never commit ignored files** (`agent-out/`, `.cio/`, `out/`, `dist/`, `.env`, logs).
- **Write clear commit messages** that describe the change and why.
- **Keep PRs small and reviewable.** A reviewer should be able to understand the whole PR in one sitting. Split large work into multiple PRs.
- **Do not force-push or rewrite shared history** unless the maintainers ask.
- **Never hide destructive changes.** Any removal, rename, or state-shape change must be called out explicitly in the PR description.

---

## Reporting

When your work is complete, deliver a short report in the PR description: what you did, what went wrong and how you fixed it, the files you changed, how you verified (including the before/after numbers for any performance-sensitive change), and any follow-ups. One clean, auditable summary — the same discipline the app's agents follow.

---

## The oath

Before you open a PR, re-read this document and answer honestly:

1. Did I cause any regression? (Proven by baseline + post-change tests.)
2. Did I introduce any performance glitch? (Measured or clearly justified.)
3. Is this a feature I actually use? And does a group of other people share the problem?
4. Is this real, or vanity?

CodeInOven exists so agentic software engineering is **coordinated, deterministic, and trustworthy**. Every line of code either serves that or doesn't belong here.
