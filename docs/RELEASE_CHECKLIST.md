# CodeInOven — Open Source Release-Readiness Checklist

> The full checklist to take CodeInOven from a private repo to a secure, maintainable, and abuse-resistant public open source project. Work the phases top-to-bottom; each phase is independent so they can be parallelized across maintainers.

**Phase status legend:** `[ ]` not done · `[~]` in progress · `[x]` done

---

## 1. Repository hygiene & hardening

The repo must be clean before it goes public — no stale config pointing at private repos, no accidental secrets, and no "private-only" assumptions baked into files.

- [x] **Remove `"private": true` from `package.json`.** A public release cannot be marked private.
- [x] **Point release metadata at the OSS repo.** `electron-builder.yml` (`publish.owner`/`publish.repo`) and every `github.com/pillardash/codeinoven` link in `README.md` must reference **`pillardash-oss/codeinoven`**, not the private `pillardash/codeinoven`.
- [x] **Verify the default `main` branch is the one that publishes.** Currently `origin/main` on the OSS remote matches local `main`.
- [x] **Scan git history for leaked secrets before going public** — `gitleaks` or `trufflehog` over the full history. You cannot un-leak a secret once the repo is public; if anything is found, rotate it and scrub history before the first push.
- [x] **Confirm `.gitignore` covers every local/private artifact**: `node_modules/`, `out/`, `dist/`, `.env*`, `agent-out/`, `.cio/`, `.opencode/`, logs, `.DS_Store`. Already present — verify nothing private is force-added.
- [x] **Add `.env.example`** (see Phase 4) with placeholder values so CI and contributors know which env vars exist.
- [x] **Verify `LICENSE` matches `package.json` `"license": "MIT"`** (currently both MIT — confirm the copyright holder string is what you want public).
- [x] **Add `SECURITY.md`** — how to report vulnerabilities privately (security@email or GitHub private vulnerability reporting), expected response SLA, and scope (app, website, auto-update feed, server).
- [x] **Add `CODE_OF_CONDUCT.md`** — short, enforceable contributor covenant; link it from `README.md` and the issue templates.
- [x] **Add issue templates** (Phase 5) and a **PR template**.
- [x] **Add a `CHANGELOG.md`** and/or keep a releases page discipline (see Phase 6).
- [x] **Verify no CI/tooling bakes in local machine paths or identities.** `electron-builder.yml` has a hardcoded Mac identity (`KU8UFSTCN5`) and `forceCodeSigning: true` — must be driven by env vars in CI, not a committed default that breaks contributor builds.
- [x] **Confirm the repo description and topics** on the OSS repo (topics like `agentic-ai`, `electron`, `svelte`, `ai-coding`, `multi-agent`).
- [x] **Double-check `AGENTS.md` / `APP-BIBLE.md` / `CONTRIBUTING.md` / `DESIGN.md` are public-appropriate** — these are the contract for contributors; remove any private-internal references if present.

## 2. Branch protection & CI/CD

Control who can merge, what must pass, and what runs automatically.

- [x] **Enable branch protection on `main`** (Settings → Branches → Add rule):
  - [x] Require pull request review (at least 1, from maintainers).
  - [x] Require status checks to pass (see CI below) before merging.
  - [x] Require branches to be up to date.
  - [x] Block force pushes and branch deletion.
  - [x] Require linear history (good default for reviewability).
- [x] **Restrict write access** — only the maintainers team gets `write`/`maintain` on the OSS repo; everyone else contributes via fork + PR.
- [x] **Add a release workflow** (`.github/workflows/release.yml`):
  - [x] Build macOS (signed + notarized), Windows, and Linux installers.
  - [x] Publish to GitHub Releases via `electron-builder --publish always` (already configured as the publish provider).
  - [x] Only trigger on version tags (`v*`).
  - [x] Upload checksums (`.yml`/`.sha256`) alongside installers.
- [ ] **Add code-signing secrets to GitHub Actions secrets** (never to the repo): `CSC_LINK` (cert p12, base64), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, plus notarization profile/`APPLE_ACCOUNT` vars as needed.
- [x] **Verify the existing `quality.yml` workflow**: `check + lint + test + production build` on every PR and push to `main`. Confirm it runs on `macos-latest` and has `timeout-minutes` (it does — 30).
- [x] **Add Dependabot** (`.github/dependabot.yml`) for `bun`/npm ecosystem, weekly cadence, `main` target, and label `dependencies`.
- [x] **Add a secret-scanning step to CI** (`gitleaks-action`) so pushes with secrets fail the build.
- [x] **Add `concurrency` groups** to workflows so rapid PR pushes cancel superseded runs instead of stacking CI time.
- [x] **Enable GitHub secret scanning & push protection** on the repo (repo Settings → Security).
- [x] **Environment branches created and protected**: `dev` (PR review + quality checks + linear history) and `nightly` (PR review + quality checks) exist and are protected; CI runs on all three (`main`/`dev`/`nightly`).
- [x] **Nightly build workflow** (`.github/workflows/nightly.yml`): scheduled daily build from `nightly` branch publishing a `nightly` prerelease with checksums.
- [ ] **Require signed/verified commits** for maintainer pushes (optional but recommended for auditability).

## 3. Secrets security

You deploy the website and a server; leaks there are worse than code leaks.

- [x] **Never commit `.env` files** — `.gitignore` already excludes `.env*`; add `.env.example` as the documented contract.
- [x] **Inventory every env var** used by the app (`process.env` in `src/`) and the future server deployment; document each in `.env.example` with placeholder values and a comment.
- [x] **App-side credentials**: confirm provider API keys go through the existing `SecretVault` (`safeStorage`) and **plaintext never crosses IPC** (already the design in `src/main/secret-vault.ts`) — document this behavior in the README's privacy section.
- [x] **No `console.*` logging** (already forbidden) — make sure the `Logger` never logs token/auth payloads or full request headers.
- [ ] **Server/site secrets live in Coolify env vars**, not in repo, not in Docker image, not in compose files committed to the repo.
- [x] **Never bake secrets into the Docker image** — pass at runtime via environment; use Docker build args only for non-secret, public values.
- [ ] **Keep separate secret scopes**: GitHub Actions secrets for the release pipeline, Coolify project env for the deployed site, local `.env` for dev — never share one value across all three.
- [ ] **Rotate anything that ever touched a public repo** (API keys, signing certs, deploy tokens) before/at launch.
- [x] **Add a secrets-rotation runbook**: what to rotate, where it lives, and who owns it (Coolify dashboard, GitHub Secrets, Apple Developer portal, hosting DNS/SSL).

## 4. Abuse prevention

Public repos attract spam, malware-in-PR attempts, and supply-chain noise. Make the attack surface small.

- [x] **Require all contributions via PR with passing CI** (Phase 2) — nothing merges silently.
- [x] **No arbitrary code execution paths** in reviewed merges: the app shells out to harness CLIs (`opencode`, `codex`, etc.) — enforce a review policy that any new exec/PTY/`child_process` path is explicitly flagged and reviewed (documented in `CONTRIBUTING.md` → "Security-sensitive changes").
- [x] **Pin and audit dependencies**: `bun.lock` is committed; add a CI step that runs `bun audit`/dependency audit on `main` and fails on high/critical vulns.
- [x] **Limit `trustedDependencies`/postinstall surface** — only `electron` is trusted today; reject PRs that expand install-time script execution without strong justification.
- [x] **Block spam via issue forms**: use GitHub issue forms (templates with required fields) so drive-by spam is obvious and auto-closed.
- [x] **Enable GitHub Discussions** and set it as the venue for feature ideas/questions, keeping Issues strictly for actionable bugs/PRs.
- [x] **Stale/autoclose automation**: a stale bot that labels and closes inactive issues/PRs after a timeout, with a "first-timers welcome" / `good-first-issue` label path.
- [ ] **Rate-limit and harden any public server endpoints** (website + any API) against scraping/abuse (Coolify/Traefik rate limiting, WAF, bot blocking).
- [ ] **Content/SQL injection surface on the site** — if the site accepts any user input, validate server-side; keep DOM sanitization (`dompurify` is already a dependency for rendered markdown).
- [x] **Confirm the app's permission tiers & scope buckets** (already a product feature) are documented publicly so users understand the abuse-mitigation model: agents stay inside scoped boundaries.
- [x] **Release artifact provenance**: sign installers and publish checksums so users can verify they didn't download a tampered binary; consider SLSA provenance for the release workflow.
- [x] **Abuse-response plan**: define how you handle a malicious PR or a reported CVE — a private repo to triage before disclosure, and a `SECURITY.md` SLA.

## 5. Accepting contributions without being worn out

The goal: maintainers review high-signal PRs, not triage noise.

- [x] **Keep the strict-but-clear `CONTRIBUTING.md`** (exists) — it already sets the four rules (no regressions, no perf glitches, real features only, no vanity). Link it prominently in README and PR template.
- [x] **Add a PR template** with a checklist mirroring the Definition of Done (baseline tests, scoped verification, no `any`, no `console.*`, changelog note).
- [x] **Add issue templates** (forms): Bug report, Feature request, Question/Support → redirects to Discussions. Each with required reproduction steps and expected behavior.
- [x] **Define labels** and a triage workflow: `bug`, `enhancement`, `good-first-issue`, `help-wanted`, `needs-repro`, `dependencies`, `security`, `won't-fix`. A `MAINTAINERS.md` (or note in CONTRIBUTING) documenting triage cadence and merge policy.
- [x] **Add `CODEOWNERS`** so core areas (main-process, renderer, drivers, scripts) auto-request the right reviewer.
- [x] **Keep PRs small by policy** — CONTRIBUTING already says "one sitting"; enforce in review, not just docs.
- [x] **Automate what you can**: Dependabot bumps, stale-bot cleanup, merge queues (GitHub "require branches up to date" + merge queue) so you review code, not infrastructure.
- [x] **Adopt a release cadence** so contributors see their work ship (e.g., monthly tag). Version bump script (`scripts/bump-version.ts`) already exists — tie it into the release workflow.
- [x] **Acknowledge contributors**: add a `FUNDING.yml` (even if no sponsors yet — signal) and credit contributors in release notes/`CHANGELOG.md`.
- [x] **Document local dev setup** in README (exists: Bun, `bun run dev`, packaging) — low-friction first contribution = fewer "how do I build this" issues.
- [x] **Create one "maintainer playlist"**: a checklist/saved-reply set for common review outcomes (needs baseline tests, vanity feature, perf concern) so you never write the same paragraph twice.

## 6. Docker & Coolify deployment

Deploy the website/server side on your own server via Coolify.

The Docker files live in the **`pillardash-oss/codeinoven-site`** repository (the `apps/marketing` and `apps/agents-favicon` apps), which has been published to that repo.

- [x] **Add a `Dockerfile`** (multi-stage, non-root user):
  - [x] Stage 1: install/build (Bun), Stage 2: minimal runtime image (distroless or slim).
  - [x] Non-root runtime user; `USER` directive.
  - [x] No secrets in image layers (env at runtime only).
  - [x] Sensible `EXPOSE` for the app port.
- [x] **Add a `.dockerignore`** (`node_modules`, `out`, `dist`, `.git`, `.env*`, `agent-out`, `.cio`, `.opencode`, logs) so context stays small and no secrets leak in.
- [x] **Add `compose.yaml`** for local full-stack testing (app + any backing store/volume) — documented, not for prod secrets.
- [x] **Add a `HEALTHCHECK`** to the Dockerfile so Coolify can report status.
- [ ] **Coolify project config**:
  - [ ] Point the app at the OSS repo or the built image; build on deploy.
  - [ ] All runtime config as project **environment variables** in Coolify (never in repo).
  - [ ] Persistent volumes for state (the app's config/data dir) so restarts survive.
  - [ ] Auto-deploy on push to `main` (or tag) via Coolify webhooks.
  - [ ] Domains/HTTPS via Coolify's reverse proxy (Traefik/Caddy) with automatic SSL.
- [ ] **Backup strategy** for the server-side data (Coolify volume snapshot or DB dump cron); test a restore before launch.
- [ ] **Image tagging discipline**: `latest` + `vX.Y.Z` semver tags so rollbacks are trivial.
- [ ] **Resource limits** in compose/Coolify (CPU/memory) to prevent a runaway container taking down the server.
- [ ] **CI build of the Docker image** (optional but recommended): build + push to a registry (GHCR) on tags, so Coolify pulls a verified image instead of building on the server.

## 7. Launch checklist

The public-facing cutover.

- [ ] **Confirm the website is live at `codeinoven.dev`** (did not resolve during this audit — must be up before launch).
- [x] **Link the website** in the repo: README top, repo `About`/homepage URL on GitHub.
- [x] **Update the README release links** to the OSS repo (Phase 1) and add a hero section/logo + badges (CI status, license, downloads, version).
- [ ] **Tag and release `v0.2.1`** (next after current version) via the release workflow with signed installers, checksums, and release notes from `CHANGELOG.md`.
- [x] **Verify the auto-update feed** points at the OSS GitHub Releases (README/`electron-builder.yml` now reference `pillardash-oss`). Resolution of `latest.yml`/`latest-mac.yml` is only testable after the first release is published — pending.
- [ ] **Test the release artifacts** on a clean macOS/Windows/Linux machine (fresh install + update path) before announcing.
- [ ] **Post-launch hygiene**: enable discussions, announce on X/Twitter and relevant communities, and pin a "first contribution" issue.
- [x] **Document the security model publicly** (README privacy section already covers data & privacy; add a short "Security" note pointing to `SECURITY.md`).
- [x] **Set expectations for response time** so you don't get worn out: `SECURITY.md` SLA, Discussions for questions, Issues triaged weekly.

---

## Quick reference: files created

| File | Purpose |
| ---- | ------- |
| `docs/RELEASE_CHECKLIST.md` | This checklist |
| `SECURITY.md` | Private vuln reporting + SLA |
| `CODE_OF_CONDUCT.md` | Contributor covenant |
| `MAINTAINERS.md` | Triage/merge policy, labels, saved replies |
| `CHANGELOG.md` | Release history |
| `.env.example` | Documented env contract |
| `.github/dependabot.yml` | Dependency bump automation |
| `.github/CODEOWNERS` | Auto-review routing |
| `.github/FUNDING.yml` | Sponsorship signal |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR checklist |
| `.github/ISSUE_TEMPLATE/*.yml` | Bug/feature forms + config |
| `.github/workflows/release.yml` | Tagged release + publish (added previously) |
| `.github/workflows/security.yml` | Gitleaks + `bun audit` |
| `.github/workflows/stale.yml` | Stale issue/PR cleanup |
| `.github/workflows/nightly.yml` | Scheduled nightly prerelease build |
| `docs/SECRETS.md` | Where to get and store every secret |

## Quick reference: Docker files (in `pillardash-oss/codeinoven-site`)

| File | Purpose |
| ---- | ------- |
| `apps/marketing/Dockerfile` | Static nginx image + healthcheck |
| `apps/marketing/docker-compose.yml` | Local/Coolify compose |
| `apps/agents-favicon/Dockerfile` | Node server image, non-root `appuser` + healthcheck |
| `apps/agents-favicon/docker-compose.yml` | Compose with persistent volume + env |
| `apps/agents-favicon/docker-entrypoint.sh` | Seed + cron + non-root server start |
| `.dockerignore` | Keep image context clean |
| `.env.example` | Documented runtime env contract |

## Quick reference: files fixed

| File | Fix |
| ---- | --- |
| `package.json` | Removed `"private": true` |
| `electron-builder.yml` | `publish.owner` → `pillardash-oss`; signing driven by env (no hardcoded identity/`forceCodeSigning`) |
| `README.md` | Release links → OSS repo; homepage URL + badges + security note |
| `.github/workflows/release.yml` | Node 24 action versions + `SHA256SUMS.txt` |
| `.github/workflows/quality.yml` | `checkout@v6` + concurrency |
| `codeinoven-website` repo | Fixed `agents-five-icon` → `agents-favicon` naming that broke installs/Docker; pushed to OSS repo with cleared history |
