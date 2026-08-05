# CodeInOven

**A desktop workstation for coordinated agentic software engineering.**

CodeInOven is a control plane that sits on top of your existing AI coding CLIs — OpenCode, Claude Code, Codex, Pi, Cline, and Antigravity — and coordinates them through a clear, reviewable lifecycle:

```
specify → review → approve → implement
```

It is not a chat toy and not another IDE plugin. CodeInOven treats agent runs as deterministic, auditable units of work: context is assembled explicitly, specs stay editable until approved, changes are tracked and diffable, and nothing happens silently.

---

## Features

- **Multi-harness support.** One interface over OpenCode, Codex CLI, Claude Code, Pi, Cline, and Antigravity. Pick a provider/model per thread.
- **Engineering specs.** Structured, versioned specifications (`Problem`, `Resolution` with phases, `Success Criteria`, `Test Strategy`, `Documentation`, `Commit Pattern`, `Constraints & Risks`). Annotate sections inline and via comments; nothing implements until you approve.
- **Approval gate.** Specs require explicit approval before any agent work starts.
- **Plan engine.** Approved specs become executable plans with per-phase checkpoints and file operations.
- **Audit loop.** After implementation, an independent audit pass reviews the work against the spec and drives rework until it passes.
- **Assignment mode.** Multi-agent graphs — a senior engineer decomposes work into tasks assigned to worker agents with blocked/ready/running/completed states.
- **Achievement mode.** The explicit autonomous mode: once enabled, the coordinator owns specification, approval, permission replies, implementation, and audit/rework cycles until the goal passes or hits a hard terminal failure.
- **Brainstorm.** Structured ideation with choices you can accept or reject before anything is specified.
- **Memory.** A durable memory system with categories (preferences, project rules, identity, behavioral), priorities, scoped/project entries, proposals, and verification. Agents can record and search it via slash commands.
- **Scope board.** A kanban-style board (todo / working / done / issue / pinned) with custom buckets per project.
- **Terminal & PTY.** Full interactive terminal sessions inside the workspace, including provider-login handoffs.
- **Change tracking.** Git-aware diffs of every agent change; review files, diffs, and diffs side-by-side before merging.
- **Checkpoints & recovery.** Atomic filesystem writes, chunked history, per-thread branches, and restart recovery that resumes interrupted threads after a crash.
- **Permissions & scope.** Configurable permission tiers and scope buckets so agents stay inside the boundaries you set.
- **Sub-agents, thinking blocks, and sources.** Live visibility into child-agent activity, reasoning, and cited sources.
- **Notifications & auto-update.** Desktop notifications when threads finish or need attention, plus automatic update download/install.
- **Light & dark themes.** Token-driven Obsidian/Ivory workspace aesthetic with an Auric accent.

---

## Requirements

- **Operating system:** macOS, Windows, or Linux (see [Packaging](#packaging) for supported targets).
- **A coding harness CLI** installed and on your `PATH` (at least one of the supported harnesses below).
- **Node.js ≥ 22.13.0 and Bun ≥ 1.3.10** are only required to build from source — released binaries run standalone.

### Supported harnesses

| Harness     | CLI command | Notes                              |
| ----------- | ----------- | ---------------------------------- |
| OpenCode    | `opencode`  | Supports custom base-URL providers |
| Codex CLI   | `codex`     | Supports custom base-URL providers |
| Claude Code | `claude`    | Supports custom base-URL providers |
| Pi          | `pi`        | Supports custom base-URL providers |
| Cline       | `cline`     | Supports custom base-URL providers |
| Antigravity | `agy`       |                                    |

Each harness has its own install channel (npm, Homebrew, or a native installer). CodeInOven's **Providers** page links to the official install docs for each harness and offers interactive login terminals.

---

## Installation

### From releases

Download the latest installer for your platform from the [releases](https://github.com/pillardash-oss/codeinoven/releases) page:

- **macOS:** `.dmg` or `.zip` (Apple Silicon and Intel)
- **Windows:** `.exe` (NSIS installer)
- **Linux:** `.AppImage` or `.deb`

Install and launch like any desktop app. On first launch you'll be guided to connect a harness and add a project.

### From source

```bash
git clone https://github.com/pillardash-oss/codeinoven.git
cd codeinoven
bun install
bun run dev
```

The development build opens the app from source. See [Development](#development) for the full toolchain and [Packaging](#packaging) to produce installers.

---

## Quick Start

### 1. Install and authenticate a harness

Make sure at least one supported CLI is installed and working in your shell:

```bash
opencode --version   # or: codex --version | claude --version | pi --version | cline --version | agy --version
```

Open **Settings → Providers** (or the **Providers** view) in CodeInOven. If a harness isn't detected, the UI links to its official install instructions. Authenticate the harness either in your terminal (`opencode auth login`, `codex login`, `claude`, etc.) or through the app's interactive login terminal.

### 2. Add a project

In the **Projects** view, create a new project and point it at a local Git repository (or a remote/SSH checkout). CodeInOven never writes into your repository uninvited — all of its own state lives in its config directory (see [Data & privacy](#data--privacy)).

### 3. Create a thread

Open a project, choose **New thread**, pick a harness and model, and describe the problem. A thread is one unit of coordinated work — one spec, one plan, one implementation.

### 4. Run the engineering workflow

1. **Specify** — Ask for an engineering spec, or let the agent draft one from your description. The **Spec Studio** renders the structured spec with every required section.
2. **Review** — Add inline and section annotations, comment on decisions, and iterate. Specs are versioned; each revision is persisted and diffable.
3. **Approve** — Approve the spec to unlock implementation. Nothing touches your code before this point.
4. **Implement** — The agent executes the plan phase by phase against your repo, creating checkpoints as it goes.
5. **Audit** (optional) — An independent audit pass verifies the changes against the spec and drives rework until the result passes or is rejected.

The whole thread — agent messages, tools, permission requests, diffs, checkpoints, and history — is visible in the conversation timeline. Approve or deny every permission request, or raise the permission tier to let the agent work with fewer interruptions.

---

## Advanced workflows

- **Assignment** — For larger features, run a coordinated multi-agent graph: a senior engineer produces an assignment plan that decomposes the spec into tasks for worker agents, each with its own thread. Tasks flow through `planned → ready → running → reported → auditing → completed` (or `rework`/`failed`) with cross-agent dependency ordering.
- **Achievement** — The fully autonomous mode. Enable it per-thread to let a coordinator own spec approval, recommended decisions, permission replies within the selected permission tier, implementation, and independent audit/rework loops until the goal passes or fails terminally. Achievement never turns an internal question into a human approval gate.
- **Audit** — A dedicated review stage after implementation: the auditor checks the diff against the spec's success criteria and either signs off or returns rework instructions.
- **Brainstorm** — Structured ideation before specification. The agent proposes entry choices; you accept, reject, or redirect before a spec is drafted.

---

## Data & privacy

- **All CodeInOven state lives in one place:** `~/.config/pillardash/codeinoven` (macOS/Linux) or the equivalent per-OS config directory (Windows).
- The app **never writes into your repository** unless you explicitly approve a change through the normal agent lifecycle.
- Persistent writes are **atomic** (`.tmp` then rename) so a crash never corrupts state.
- History is **chunked** (capped) and **checkpointed**; pinned threads survive cleanup, and per-thread branches keep everything inspectable, diffable, and rollback-able.
- **Memory** is yours: entries are categorized, scoped, verifiable, and searchable, and agents record them explicitly through slash commands rather than silently.
- Project and thread limits (e.g. 70 threads per project by default) keep growth deliberate.

---

## Development

### Toolchain

- **Bun** is the only package manager and runner. Node ≥ 22.13.0 is required.
- **TypeScript**, strict — the type `any` is forbidden.
- **Svelte 5 (runes) + Tailwind v4** for the renderer.
- **Electron** main/preload via `electron-vite`.

### Scripts

| Command                    | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `bun install`              | Install locked dependencies                                         |
| `bun run dev`              | Run the app in development                                          |
| `bun run check [FILES]`    | Type + Svelte check (scoped to files or whole project when omitted) |
| `bun run lint [FILES]`     | ESLint (scoped; `--max-warnings 0`)                                 |
| `bun run format [FILES]`   | Prettier auto-format (scoped)                                       |
| `bun run test [FILES]`     | Vitest (scoped)                                                     |
| `bun run verify`           | `check` + full lint + full test                                     |
| `bun run verify:release`   | `verify` + production build                                         |
| `bun run build`            | electron-vite build                                                 |
| `bun run build:production` | Production-mode build                                               |

### Architecture

- **`src/main`** — Electron main process: storage engine, CLI drivers, PTY/terminal service, chat engine, checkpoint manager, permission & scope policies, diagnostics, memory service, restart recovery, auto-updater.
- **`src/lib`** — Shared engines: project/thread managers, spec engine, plan engine, history engine, provider adapters, and the typed IPC contract.
- **`src/preload`** — The bridge exposing the validated IPC surface to the renderer.
- **`src/renderer`** — Svelte 5 UI: workspace shell, chat, spec/audit studios, terminal, scope board, and stores.

The IPC contract (`src/lib/ipc-contract.ts`) is a hard boundary — the renderer never reaches into Node APIs, the main process never assumes renderer state, and every message is validated on both sides. Drivers implement `driver.interface.ts`; new harnesses plug in through that contract.

### Packaging

| Command                 | Produces                                  |
| ----------------------- | ----------------------------------------- |
| `bun run package`       | Unpacked app bundle (no code signing)     |
| `bun run package:mac`   | macOS `.dmg` + `.zip` (unsigned)          |
| `bun run package:linux` | Linux `.AppImage` + `.deb`                |
| `bun run package:win`   | Windows NSIS `.exe`                       |
| `bun run release:mac`   | Verified + signed/notarized macOS release |

**Release workflow.** A GitHub Actions workflow (`.github/workflows/release.yml`) builds installers for all three platforms on native runners and publishes them as a GitHub Release. It runs on any pushed tag matching `v*` or manually via **Actions → Release → Run workflow**. Set `publish: false` on a manual run to build and attach workflow artifacts without creating a release.

| Trigger             | Behavior                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Tag `v0.2.2` pushed | Builds macOS (universal), Windows, and Linux, then creates/publishes a GitHub Release `v0.2.2` |
| Manual dispatch     | Builds all three platforms; creates a Release when `publish` is checked (default)              |

Artifacts produced per platform:

- **macOS:** `.dmg` + `.zip` (universal: Apple Silicon + Intel)
- **Windows:** NSIS `.exe`
- **Linux:** `.AppImage` + `.deb`

Code signing and macOS notarization are used automatically when the `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` repository secrets are configured; otherwise installers are built unsigned so the workflow stays runnable on a fresh fork.

---

## Troubleshooting

- **Logs.** The app writes structured logs to `~/.config/pillardash/codeinoven/logs/`.
- **Diagnostics.** Use **Export diagnostics** (available from the app) to gather a support bundle when something goes wrong.
- **Interrupted threads.** If the app exits while work is running, restart recovery inspects and resumes interrupted threads on the next launch.
- **Harness not detected.** Confirm the CLI is on your `PATH` (GUI-launched processes don't inherit your shell PATH — CodeInOven augments it with common tool paths, but a system-wide install helps). Reinstall or re-auth the harness from **Providers**, then retry.
- **Update problems.** Automatic update download/install can be toggled in Settings; updates install on the next launch if a live update can't apply.

---

## License

CodeInOven is released under the [MIT License](LICENSE).
