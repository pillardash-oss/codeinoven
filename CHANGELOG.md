# Changelog

All notable changes to CodeInOven are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **OpenCode is one harness, driven at whichever version is installed.**
  OpenCode V1 and V2 both install as the `opencode` command (the vendor's V2
  installer replaces a package-managed V1 binary, and a package-managed V2
  install may add an `opencode2` alias). The app probes `opencode` and
  `opencode2`, keeps the newest version, and drives the transport that matches
  it, so a V2 machine streams over the V2 `/api/*` HTTP+SSE surface and a V1
  machine keeps the V1 server API. There is no second harness entry and no
  version picker: the Harnesses page shows one **OpenCode** row with its
  detected version, and its install/update/uninstall channels now target the
  current release.

  The V2 transport is fully drivable: threads stream text and reasoning, run
  tools, ask interactive questions through V2's form surface, answer or dismiss
  them, accept mid-turn steering, mirror their native transcript, compact on
  demand, run slash commands, and stop on interrupt. Model, agent, and
  thinking-level selection are applied per turn (V2 scopes them to the session),
  attachments are supported, and the model picker reads the server's own
  catalog. Thread titles, turn grading, cheap-model one-shots, heartbeats, and
  every disposable flow (temporary chats, transcription, image description,
  brainstorm/spec/assignment offshoots) run on private V2 servers that are torn
  down when they end, and a delegated sub-agent is surfaced as a child-agent
  card (V2 announces the child session with a non-null `parentID`).
  `opencode auth list/login/logout` backs the provider account UI at both
  version lines, and a V2 integration that holds several keys reports each
  connection as its own account. CodeInOven's account containers still isolate
  V2 completely: the container environment relocates V2's config and its SQLite
  store, so each account keeps its own credentials and state.

  Custom base-URL providers are claimed for the single entry. V2 cannot restrict
  `read` in a session permission ruleset (its own provider entitlement is
  evaluated through the same ruleset), so a restricted V2 turn denies everything
  that mutates instead of every tool. Token and cost usage is read from the V2
  session stats and message payloads, and the account's Go quota windows are read
  from OpenCode's own usage API (`https://opencode.ai/zen/go/v1/usage`) for
  whichever line is installed: V1 from its `auth.json`, V2 from its SQLite
  credential store. The local **OpenUsage** integration remains the fallback that
  answers the same question for any provider, so account quota is a local
  capability. Only the hosted Console workspace budgets and CSV export stay a
  separate service-account product. Structured output is not claimed for either
  line (V2 has no JSON-schema mode, and V1 deliberately keeps deterministic JSON
  flows off its history endpoint).

- An end-to-end suite for the OpenCode harness is committed and gated on
  `OPENCODE_E2E_BINARY`: with a real install it proves the app selects the
  transport matching the detected line, that the V2 catalog is read over the
  HTTP API (waiting out the server's first-boot window), and that a real turn
  streams and mirrors its history. It reports as skipped wherever no OpenCode
  binary is present, so CI stays green.

- The agent can now collect secrets without ever seeing them. A new
  `cio_ask_secret` **gateway** tool (the utility gateway every harness already
  reaches, not a per-harness tool) asks for one or more values by title and
  description; the app renders a password card with an in-field reveal toggle and
  a "Secrets are not sent to the agent" note and stores each value in the
  encrypted vault. A value bound to a capability by `utility_id` is stored
  exactly as the Utilities page stores it, so an MCP that needs a key can be
  finished in one turn. A plain value is re-exposed to the thread each turn as an
  OS environment variable (`CIO_<ID>_<TITLE_SLUG>`, or the exact name the target
  expects) and as an owner-only `0600` file the agent interpolates with
  `"$(cat secret_path)"`, so CLI work needs no plaintext in chat. Neither the
  tool result nor any MCP transport ever carries the value: the model receives
  only `Secret set, you may proceed.` and the names.

- The secret card now offers **Provide alternative**, the same escape hatch the
  permission card has. A user who cannot reach a value they already supplied
  answers with an instruction instead of pasting, and the app resolves every
  requested name from state the device already holds this thread's registry, a
  credential bound to an installed utility, or another thread's registry adopts
  it for the current thread and exposes it exactly like a pasted value (session
  environment and owner-only file, or the utility credential). The user may name
  the stored variable when it was saved under a different spelling. Names with
  nothing stored behind them are reported back as `unresolved_environment_variables`
  together with the instruction, so the agent adapts instead of asking for the
  same key twice.

### Changed

- A capability installed without explicit harness targeting now applies to every harness,
  present and future. A missing `harnessBindings` used to normalize to an empty list, which
  `resolve` reads as "no harness", so the setup contract had to make the agent enumerate
  harnesses. It now stores a single `{"harnessId":"*"}` binding and the contract treats the
  field as optional, so a global install reaches every harness and a harness added later
  resolves it with no reinstall.

- Replaced the 1–5 per-turn feedback ledger with a 0–10 conversation-grading
  model-ranking system. Rankings are keyed by harness + provider + model +
  thinking level and split into separate **one-shot** and **multi-shot**
  scores, sample counts, and agent runtime per configuration. Greeting-only
  first prompts are never graded. Existing graded history folds into the new
  aggregate under the `legacy-1to5-map-v1` rubric tag (linearly mapped, only
  approximately comparable to the new rubric; the Profile settings surface
  shows the rubric version per row). The Profile analytics section
  "Best model by feedback" becomes "Model rankings" with one-shot/multi-shot
  columns, and the old blended grade-of-five display is gone.

- Automatic memory proposals now weigh the user's wording before remembering
  anything. The deciding model reviews the turn as an explicit two-step
  evaluation (lasting rule versus one-off request) and receives the user's
  earlier message as supporting context. Requests the user repeated in the
  current task, including ones accompanied by "I have told you before" or
  "why do you always" out of frustration, and the frustration itself, are no
  longer proposed for memory.

### Fixed

- The vision-model error card is dismissable in every state. A request that the
  engine already settled (its five-minute decision timeout, a newer descriptor
  request superseding it, or its harness session being retired) used to answer
  a dismiss click with `Image descriptor request is no longer pending`, leaving
  the card on screen; those paths now broadcast their resolution so the card
  closes, and a reply for a settled request settles the card instead of
  failing. Dismissing a question or secret card follows the same rule, and a
  `false_positive` report still records the model even when it arrives late.
- Image-descriptor requests now supersede each other: when a model issues
  several descriptor calls in one turn, the newest request dismisses the older
  cards and only the newest one waits for an answer, instead of leaving
  unanswerable cards behind that each timed out separately.
- A model that can already see images no longer receives the image descriptor.
  The utility gateway now withholds it for any model the provider catalog marks
  as image-capable, not only for models the user reported, and re-checks that
  capability on every gateway call so a `false_positive` report takes effect
  for the rest of the turn. A vision record also matches the model name segment
  of an id, so one report covers the same model behind other provider prefixes
  (`z-ai/glm-5.3-flash` and `ali/deepseek-v4.1-flash`).
- ⌘/Ctrl+Enter in the **New pull request** panel now docks the panel while the
  commit → push → create sequence runs, and the docked chip names the step in
  progress instead of only spinning. A dismiss button can no longer be
  taken as a modal's primary action, which previously closed the panel (mid
  creation) when the real primary action was disabled.

## [0.5.1] - 2026-08-06

### Changed

- macOS builds target **Apple Silicon (arm64) only**; Intel (x64) support is
  dropped. Windows (x64) and Linux (x64) remain unchanged.

## [0.5.0] - 2026-08-06

### Added

- Streamed Mermaid diagram rendering with strict-mode sanitization.
- Command-menu navigation preservation, inline-block arrow-key handling, and
  subagent recovery lifecycle fixes.
- Header project-info dropdown, full thread ID in the debugger sidebar, and
  Mermaid render fixes.
- Open source release-readiness: security policy, code of conduct, issue/PR
  templates, dependency automation, environment branches (`dev`/`nightly`),
  and a nightly prerelease build pipeline.

### Fixed

- Restored the storage-to-Database migration in the test suite (tests now use
  the `Database` class); repaired pre-existing type-check, lint, and test
  failures that were blocking CI.

## [Unreleased]

### Added

- Open source release-readiness foundation: security policy, code of conduct,
  issue/PR templates, dependency automation, and Docker deployment templates.

## [0.2.1] - 2026-08-05

### Added

- Open source preparation: aligned license metadata with the MIT LICENSE file,
  added contribution guidelines (CONTRIBUTING.md), and pointed release
  metadata at the public `pillardash-oss/codeinoven` repository.

## [0.2.0] - 2026-07

### Added

- Initial public-facing feature set of the coordinated agentic engineering
  workstation (see README for the full feature list).
