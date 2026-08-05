# Maintainers

This file documents how CodeInOven is maintained: who owns what, how
contributions are triaged, and the merge policy. Read `CONTRIBUTING.md` for
contributor-facing rules.

## Maintainer team

The `pillardash-oss/maintainers` team owns review and merge rights on the
`pillardash-oss/codeinoven` repository.

- **@leonardosahon** — project lead, architecture, releases.
- (Add maintainers here as the team grows.)

## Triage cadence

- **Issues** are triaged weekly. The `triage` workflow decides: accepted
  (labeled `enhancement`/`bug`), needs more info (`needs-repro`), or closed
  (`wont-fix`).
- **Questions and feature ideas** belong in GitHub Discussions, not Issues.
  Close and redirect any Issue that is really a question.
- **PRs** are reviewed on a best-effort basis with a target of responding
  within 7 days. Small, focused PRs get reviewed first.

## Merge policy

- Every PR must pass the quality workflow (check + lint + test + production
  build) before merge.
- At least one maintainer review is required; the reviewer is the sole decider.
- Maintainers can self-merge small, uncontroversial fixes (docs, CI, typo
  fixes) they authored, but large changes need a second review.
- Never merge a PR that violates the four ground rules from
  `CONTRIBUTING.md`: no regressions, no performance glitches, real features
  only, no vanity features.
- Destructive changes (removals, renames, storage-shape changes) must be
  called out explicitly in the PR description.

## Label inventory

| Label | Meaning |
| ----- | ------- |
| `bug` | Something that does not work as intended |
| `enhancement` | A proposed new feature |
| `good-first-issue` | Small, well-scoped task for new contributors |
| `help-wanted` | Needs a contributor; maintainers lack time |
| `needs-repro` | Bug lacks a reproduction; on hold until provided |
| `dependencies` | Dependency bump (Dependabot) |
| `security` | Security-relevant issue or PR |
| `wont-fix` | Accepted but intentionally not addressed |

## Release process

1. Update `CHANGELOG.md` with the new version's changes.
2. Bump the version with `bun run version:bump`.
3. Tag `v<version>` and push; the `release.yml` workflow builds and publishes
   signed installers to GitHub Releases.
4. Verify the auto-update feed resolves from a clean machine.
5. Announce in Discussions / social channels.

## Saved replies

Reusable review replies so maintainers never write the same paragraph twice:

- **Needs baseline tests:** "Thanks for the PR. Please add a test for the
  before state (baseline) and the after state, and run the scoped suite on the
  files you touched — per CONTRIBUTING.md, a contribution must prove it
  causes no regression."
- **Vanity feature:** "This looks polished, but per CONTRIBUTING.md rule 4,
  features must serve a real shared problem you hit yourself. Can you point to
  the group of users who share this problem? Otherwise let's take it to
  Discussions first."
- **Perf concern:** "This changes per-message/per-thread work. Please profile
  before/after and share numbers, or justify why it's free — no perf glitches
  per CONTRIBUTING.md."
- **No `any`/`console.*`:** "Per the engineering standards, `any`/`as any` and
  `console.*` are forbidden. Please model the type properly and use the
  `Logger` class."
