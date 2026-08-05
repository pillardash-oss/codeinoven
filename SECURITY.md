# Security Policy

CodeInOven takes security seriously. This document describes how to report
vulnerabilities and what you can expect from the maintainers.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

To report a vulnerability privately, use GitHub's
[private vulnerability reporting](https://github.com/pillardash-oss/codeinoven/security/advisories/new)
for this repository, or email the maintainers at
`hey@pillardash.com`. Include:

- A description of the vulnerability and its impact.
- The affected version(s) and the commit/tag if known.
- Steps to reproduce, or a minimal proof of concept.
- Any proposed fix, if you have one.

If you are able, encrypt sensitive details — but plaintext reports are
preferred over not reporting at all.

## Scope

This policy covers:

- The CodeInOven desktop application (this repository).
- The CodeInOven website and its supporting services.
- The automatic-update feed and release artifacts.
- Any server-side components CodeInOven deploys.

Out of scope: dependencies that are patched upstream without CodeInOven
changes, and issues that require the attacker to already have physical access
to the victim's machine.

## Response expectations

| Severity | Initial response | Fix target |
| -------- | ---------------- | ---------- |
| Critical | 24 hours | 7 days |
| High | 48 hours | 14 days |
| Medium | 7 days | 30 days |
| Low | 14 days | Next minor release |

The maintainers will acknowledge your report within the initial-response
window and keep you updated on progress. We will coordinate a disclosure date
with you before any public announcement.

## What CodeInOven does for you

- **Local credentials stay local.** Provider API keys and secrets are
  encrypted at rest with the OS keychain-backed `safeStorage` and never cross
  the IPC boundary in plaintext (`src/main/secret-vault.ts`).
- **No telemetry.** The app does not phone home; all state lives under your
  config directory.
- **Scoped agents.** Permission tiers and scope buckets keep agents inside the
  boundaries you set.
- **Signed, checksummed releases.** Installers are signed when credentials are
  configured and released with checksums so you can verify artifacts.

## Reporting handling

1. Triage the report privately, reproduce, and assess severity.
2. Prepare a fix on a private branch.
3. Ship the fix in a patch release.
4. Publish a security advisory with affected versions and mitigations.

Maintainers: see `SECURITY.md` + the abuse-response plan in
`docs/RELEASE_CHECKLIST.md` for the triage flow and the secrets-rotation
runbook.
