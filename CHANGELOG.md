# Changelog

All notable changes to CodeInOven are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- The agent can now collect secrets without ever seeing them. A new
  `cio_ask_secret` tool asks for one or more values by title and description; the
  app renders a password card with an in-field reveal toggle and a
  "Secrets are not sent to the agent" note, stores each value in the encrypted
  vault, and exposes it to the session as an OS environment variable
  (`CIO_<ID>_<TITLE_SLUG>`, or the exact name the target expects). Passing a
  `utility_id` binds the value to an installed capability as its credential,
  exactly as the Utilities page does, so an MCP that needs a key can be finished
  in one turn. The model receives only `Secret set, you may proceed.` and the
  variable names.

### Changed

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
