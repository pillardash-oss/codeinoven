# Changelog

All notable changes to CodeInOven are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

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
