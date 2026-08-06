# Changelog

All notable changes to CodeInOven are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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
