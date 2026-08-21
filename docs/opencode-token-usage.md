# OpenCode Token Usage Efficiency

CodeInOven trims the harness-injected per-turn token load for its **lightweight
modes** by shipping app-managed custom opencode agents whose `permission` deny
sets prune heavy tool/skill schemas server-side. Engineering/implementation
modes keep the full built-in opencode experience and are deliberately
untouched.

## Why agents, not app-side string surgery

A plain `hello` in a project thread costs ≈22k input tokens. The dominant
overhead is the harness's injected per-turn load — base system prompt, default
tool schemas, the `@sveltejs/opencode` plugin registration, the repo's
`AGENTS.md`, and the available-skills block — which cannot be cut from the
application side. Lean agents declared in `~/.config/opencode/opencode.json` are
a config surface the app already owns and edits safely.

The tell-tale measurement: on opencode **v1.18.15**, an identical prompt under
the full default `build` agent measured **12,779** input tokens vs **4,232**
under a lean web-only agent (reduction ≈8.5k, ≈67%). The reduction is
attributable to denied tool schemas and the pruned skills/instruction block.

## Trimmed modes and agents

| Mode                        | Agent            | Allowed tools                                         | Scoped write/bash               |
| --------------------------- | ---------------- | ----------------------------------------------------- | ------------------------------- |
| Inbox chat                  | `cio-chat`       | webfetch, websearch, question                         | none                            |
| File-system chat            | `cio-chat-fs`    | read, glob, grep, list, webfetch, websearch, question | none                            |
| Ephemeral session           | `cio-eph`        | read, glob, grep, list, webfetch, websearch, question | none                            |
| Image description           | `cio-img-desc`   | read                                                  | none                            |
| PR compose                  | `cio-pr-compose` | read, glob, grep, list                                | bash read-only `git` commands only |
| Brainstorm (session report) | `cio-brainstorm` | read, glob, grep, list, webfetch, websearch, question | edit `.cio/specs/*/versions/**` |

Every lean agent sets an explicit `"*": "deny"` catch-all first, then
`allow` entries for exactly the documented tools (last-match wins). Every heavy
permission key (`read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`,
`todowrite`, `webfetch`, `websearch`, `skill`, `lsp`, `external_directory`,
`question`) is set explicitly so nothing leaks through the machine-global
permission defaults.

## Permission model

- Allowed tools are `allow`; everything not listed is `deny`.
- `edit: { "*": "deny", "<scope>": "allow" }` grants a write only under an
  exact `.cio/` path. Brainstorm writes session-report revisions only under
  `.cio/specs/*/versions/`; PR compose returns its JSON result without writing.
- `bash` for PR compose allows **only read-only git commands** (an explicit
  allowlist: `git status/diff/log/show/rev-parse/ls-files/ls-tree`, `git
  branch --show-current`, `git remote -v/show`). Everything else, including
  `git push`, `git reset`, `git clean`, and branch deletion, is denied.
- The `@sveltejs/opencode` plugin weight is deliberately kept as-is; per-agent
  plugin scoping is revisited only if opencode supports it.

## Safe global-config merge contract

The machine-wide merge into `~/.config/opencode/opencode.json` follows the same
discipline as the provider-hiding merge (`provider-account-orchestrator`):

- **Plain JSON only.** JSONC configs (comments/trailing commas) are never
  overwritten — the merge reports a warning and skips.
- **Additive and idempotent.** Only CodeInOven's own agent names are touched;
  user agents, the `@sveltejs/opencode` plugin, MCP wiring, and every other key
  are preserved. A second run rewrites nothing (byte-stable across restart).
- **Reversible.** Before the first write the ORIGINAL pre-merge file is
  preserved byte-for-byte at `opencode.json.cio-agents-backup`. The backup is
  written once (`wx`) and never overwritten by later merges (e.g. when a newer
  release adds another managed agent), so rollback always restores the true
  original. All writes are atomic (temp file + rename).

Run at startup via `syncOpenCodeLeanAgents()`. The merge is **gated on the
deny-compliance proof**: agents are installed only for an opencode version
whose deny pruning was verified by the live probe (recorded under
`~/.config/pillardash/codeinoven/opencode-deny-compliance.json`), or when the
operator sets `CIO_OPCODE_MERGE_AGENTS_UNVERIFIED=1`. Otherwise the merge is
skipped with a dev-only warning. Failures are non-fatal.

## Dev-only measurement workflow

`src/main/chat/token-usage-attribution.ts` records content-free per-mode
episodes — only layer hashes, character counts, and heuristic token estimates
(`~4 chars/token`) — paired with provider-reported totals already recorded in
`harness_usage`. Recording is inert in production (`NODE_ENV === 'production'`)
and logs exclusively through `Logger.dev` (never `console.*`); no layer content
ever ships in production prompts or logs.

Manual measurement runs seed the before/after tables in the feature progress
artifact (`.cio/specs/improve-opencode-token-usage-efficiency/progress.md`).

## Harness-compliance requirement

Agent-level `deny` pruning on the headless `prompt_async` endpoint was
historically unreliable (opencode issue #6396). The app therefore:

1. Requires a **deny-compliance proof** against the installed harness before
   relying on deny pruning for correctness.
2. **Gates the startup agent merge on that proof.** The passing probe persists
   a compliance record for the installed opencode version; `syncOpenCodeLeanAgents`
   installs agents only when that record is compliant for the running version
   (or when `CIO_OPCODE_MERGE_AGENTS_UNVERIFIED=1` is set by the operator).
3. Runs the proof via a gated probe:
   `CIO_OPCODE_DENY_PROBE=1 bun run test tests/main/opencode-deny-compliance.test.ts`.
   The probe reports e.g.
   `opencode v1.18.15 deny compliance: COMPLIANT — full=12779 lean=4232 (reduction=8547)`.
4. Logs a dev-only warning when the installed harness is not proven compliant,
   and never depends on deny pruning to preserve a flow (additive,
   non-breaking by default).

> Because the body-level `tools` map overrides an agent `deny` (verified
> empirically), trimmed modes must **keep sending restrictive `allowedTools`**
> and must never send `{"*": true}`. The agent deny is the schema-pruning
> mechanism for the base/instruction load; the body allow-list stays the
> per-message tool gate.

## Rollback

To remove the app-managed lean agents and restore the pre-merge config:

```ts
import { rollbackLeanAgentsGlobalConfig } from '../src/main/opencode/opencode-global-config'
await rollbackLeanAgentsGlobalConfig()
```

If a `.cio-agents-backup` exists it is restored byte-for-byte; otherwise only
the CodeInOven agent entries are stripped and user-owned config is preserved.

## Code map

- `src/main/opencode/opencode-agent-definitions.ts` — lean agent payloads + deny matrix
- `src/main/opencode/opencode-global-config.ts` — merge + rollback service
- `src/main/opencode/opencode-agent-service.ts` — startup orchestration
- `src/main/opencode/opencode-deny-probe.ts` — harness compliance probe
- `src/main/chat/token-usage-attribution.ts` — dev-only measurement
- `src/main/chat/chat-engine.ts` — mode→agent wiring + prompt slim-down
- `tests/main/opencode-agent-definitions.test.ts` — golden deny-matrix
- `tests/main/opencode-global-config.test.ts` — merge safety
- `tests/main/opencode-deny-compliance.test.ts` — harness compliance gate
