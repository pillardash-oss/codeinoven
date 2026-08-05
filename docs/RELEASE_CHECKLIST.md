# CodeInOven — Open Source Release-Readiness Checklist

> The full checklist to take CodeInOven from a private repo to a secure, maintainable, and abuse-resistant public open source project. Work the phases top-to-bottom; each phase is independent so they can be parallelized across maintainers.

**Phase status legend:** `[ ]` not done · `[~]` in progress · `[x]` done

---

## 1. Repository hygiene & hardening

The repo must be clean before it goes public — no stale config pointing at private repos, no accidental secrets, and no "private-only" assumptions baked into files.

- [ ] **Remove `"private": true` from `package.json`.** A public release cannot be marked private.
- [ ] **Point release metadata at the OSS repo.** `electron-builder.yml` (`publish.owner`/`publish.repo`) and every `github.com/pillardash/codeinoven` link in `README.md` must reference **`pillardash-oss/codeinoven`**, not the private `pillardash/codeinoven`.
- [ ] **Verify the default `main` branch is the one that publishes.** Currently `origin/main` on the OSS remote matches local `main`.
- [ ] **Scan git history for leaked secrets before going public** — `gitleaks` or `trufflehog` over the full history. You cannot un-leak a secret once the repo is public; if anything is found, rotate it and scrub history before the first push.
- [ ] **Confirm `.gitignore` covers every local/private artifact**: `node_modules/`, `out/`, `dist/`, `.env*`, `agent-out/`, `.cio/`, `.opencode/`, logs, `.DS_Store`. Already present — verify nothing private is force-added.
- [ ] **Add `.env.example`** (see Phase 4) with placeholder values so CI and contributors know which env vars exist.
- [ ] **Verify `LICENSE` matches `package.json` `"license": "MIT"`** (currently both MIT — confirm the copyright holder string is what you want public).
- [ ] **Add `SECURITY.md`** — how to report vulnerabilities privately (security@email or GitHub private vulnerability reporting), expected response SLA, and scope (app, website, auto-update feed, server).
- [ ] **Add `CODE_OF_CONDUCT.md`** — short, enforceable contributor covenant; link it from `README.md` and the issue templates.
- [ ] **Add issue templates** (Phase 5) and a **PR template**.
- [ ] **Add a `CHANGELOG.md`** and/or keep a releases page discipline (see Phase 6).
- [ ] **Verify no CI/tooling bakes in local machine paths or identities.** `electron-builder.yml` has a hardcoded Mac identity (`KU8UFSTCN5`) and `forceCodeSigning: true` — must be driven by env vars in CI, not a committed default that breaks contributor builds.
- [ ] **Confirm the repo description and topics** on the OSS repo (topics like `agentic-ai`, `electron`, `svelte`, `ai-coding`, `multi-agent`).
- [ ] **Double-check `AGENTS.md` / `APP-BIBLE.md` / `CONTRIBUTING.md` / `DESIGN.md` are public-appropriate** — these are the contract for contributors; remove any private-internal references if present.

## 2. Branch protection & CI/CD

Control who can merge, what must pass, and what runs automatically.

- [ ] **Enable branch protection on `main`** (Settings → Branches → Add rule):
  - [ ] Require pull request review (at least 1, from maintainers).
  - [ ] Require status checks to pass (see CI below) before merging.
  - [ ] Require branches to be up to date.
  - [ ] Block force pushes and branch deletion.
  - [ ] Require linear history (good default for reviewability).
- [ ] **Restrict write access** — only the maintainers team gets `write`/`maintain` on the OSS repo; everyone else contributes via fork + PR.
- [ ] **Add a release workflow** (`.github/workflows/release.yml`):
  - [ ] Build macOS (signed + notarized), Windows, and Linux installers.
  - [ ] Publish to GitHub Releases via `electron-builder --publish always` (already configured as the publish provider).
  - [ ] Only trigger on version tags (`v*`).
  - [ ] Upload checksums (`.yml`/`.sha256`) alongside installers.
- [ ] **Add code-signing secrets to GitHub Actions secrets** (never to the repo): `CSC_LINK` (cert p12, base64), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, plus notarization profile/`APPLE_ACCOUNT` vars as needed.
- [ ] **Verify the existing `quality.yml` workflow**: `check + lint + test + production build` on every PR and push to `main`. Confirm it runs on `macos-latest` and has `timeout-minutes` (it does — 30).
- [ ] **Add Dependabot** (`.github/dependabot.yml`) for `bun`/npm ecosystem, weekly cadence, `main` target, and label `dependencies`.
- [ ] **Add a secret-scanning step to CI** (`gitleaks-action`) so pushes with secrets fail the build.
- [ ] **Add `concurrency` groups** to workflows so rapid PR pushes cancel superseded runs instead of stacking CI time.
- [ ] **Enable GitHub secret scanning & push protection** on the repo (repo Settings → Security).
- [ ] **Require signed/verified commits** for maintainer pushes (optional but recommended for auditability).

## 3. Secrets security

You deploy the website and a server; leaks there are worse than code leaks.

- [ ] **Never commit `.env` files** — `.gitignore` already excludes `.env*`; add `.env.example` as the documented contract.
- [ ] **Inventory every env var** used by the app (`process.env` in `src/`) and the future server deployment; document each in `.env.example` with placeholder values and a comment.
- [ ] **App-side credentials**: confirm provider API keys go through the existing `SecretVault` (`safeStorage`) and **plaintext never crosses IPC** (already the design in `src/main/secret-vault.ts`) — document this behavior in the README's privacy section.
- [ ] **No `console.*` logging** (already forbidden) — make sure the `Logger` never logs token/auth payloads or full request headers.
- [ ] **Server/site secrets live in Coolify env vars**, not in repo, not in Docker image, not in compose files committed to the repo.
- [ ] **Never bake secrets into the Docker image** — pass at runtime via environment; use Docker build args only for non-secret, public values.
- [ ] **Keep separate secret scopes**: GitHub Actions secrets for the release pipeline, Coolify project env for the deployed site, local `.env` for dev — never share one value across all three.
- [ ] **Rotate anything that ever touched a public repo** (API keys, signing certs, deploy tokens) before/at launch.
- [ ] **Add a secrets-rotation runbook**: what to rotate, where it lives, and who owns it (Coolify dashboard, GitHub Secrets, Apple Developer portal, hosting DNS/SSL).

## 4. Abuse prevention

Public repos attract spam, malware-in-PR attempts, and supply-chain noise. Make the attack surface small.

- [ ] **Require all contributions via PR with passing CI** (Phase 2) — nothing merges silently.
- [ ] **No arbitrary code execution paths** in reviewed merges: the app shells out to harness CLIs (`opencode`, `codex`, etc.) — enforce a review policy that any new exec/PTY/`child_process` path is explicitly flagged and reviewed (tie into the CONTRIBUTING "no regressions / no hidden behavior" rules).
- [ ] **Pin and audit dependencies**: `bun.lock` is committed; add a CI step that runs `bun audit`/dependency audit on `main` and fails on high/critical vulns.
- [ ] **Limit `trustedDependencies`/postinstall surface** — only `electron` is trusted today; reject PRs that expand install-time script execution without strong justification.
- [ ] **Block spam via issue forms**: use GitHub issue forms (templates with required fields) so drive-by spam is obvious and auto-closed.
- [ ] **Enable GitHub Discussions** and set it as the venue for feature ideas/questions, keeping Issues strictly for actionable bugs/PRs.
- [ ] **Stale/autoclose automation**: a stale bot that labels and closes inactive issues/PRs after a timeout, with a "first-timers welcome" / `good-first-issue` label path.
- [ ] **Rate-limit and harden any public server endpoints** (website + any API) against scraping/abuse (Coolify/Traefik rate limiting, WAF, bot blocking).
- [ ] **Content/SQL injection surface on the site** — if the site accepts any user input, validate server-side; keep DOM sanitization (`dompurify` is already a dependency for rendered markdown).
- [ ] **Confirm the app's permission tiers & scope buckets** (already a product feature) are documented publicly so users understand the abuse-mitigation model: agents stay inside scoped boundaries.
- [ ] **Release artifact provenance**: sign installers and publish checksums so users can verify they didn't download a tampered binary; consider SLSA provenance for the release workflow.
- [ ] **Abuse-response plan**: define how you handle a malicious PR or a reported CVE — a private repo to triage before disclosure, and a `SECURITY.md` SLA.

## 5. Accepting contributions without being worn out

The goal: maintainers review high-signal PRs, not triage noise.

- [ ] **Keep the strict-but-clear `CONTRIBUTING.md`** (exists) — it already sets the four rules (no regressions, no perf glitches, real features only, no vanity). Link it prominently in README and PR template.
- [ ] **Add a PR template** with a checklist mirroring the Definition of Done (baseline tests, scoped verification, no `any`, no `console.*`, changelog note).
- [ ] **Add issue templates** (forms): Bug report, Feature request, Question/Support → redirects to Discussions. Each with required reproduction steps and expected behavior.
- [ ] **Define labels** and a triage workflow: `bug`, `enhancement`, `good-first-issue`, `help-wanted`, `needs-repro`, `dependencies`, `security`, `won't-fix`. A `MAINTAINERS.md` (or note in CONTRIBUTING) documenting triage cadence and merge policy.
- [ ] **Add `CODEOWNERS`** so core areas (main-process, renderer, drivers, scripts) auto-request the right reviewer.
- [ ] **Keep PRs small by policy** — CONTRIBUTING already says "one sitting"; enforce in review, not just docs.
- [ ] **Automate what you can**: Dependabot bumps, stale-bot cleanup, merge queues (GitHub "require branches up to date" + merge queue) so you review code, not infrastructure.
- [ ] **Adopt a release cadence** so contributors see their work ship (e.g., monthly tag). Version bump script (`scripts/bump-version.ts`) already exists — tie it into the release workflow.
- [ ] **Acknowledge contributors**: add a `FUNDING.yml` (even if no sponsors yet — signal) and credit contributors in release notes/`CHANGELOG.md`.
- [ ] **Document local dev setup** in README (exists: Bun, `bun run dev`, packaging) — low-friction first contribution = fewer "how do I build this" issues.
- [ ] **Create one "maintainer playlist"**: a checklist/saved-reply set for common review outcomes (needs baseline tests, vanity feature, perf concern) so you never write the same paragraph twice.

## 6. Docker & Coolify deployment

Deploy the website/server side on your own server via Coolify.

- [ ] **Add a `Dockerfile`** (multi-stage, non-root user):
  - [ ] Stage 1: install/build (Bun), Stage 2: minimal runtime image (distroless or slim).
  - [ ] Non-root runtime user; `USER` directive.
  - [ ] No secrets in image layers (env at runtime only).
  - [ ] Sensible `EXPOSE` for the app port.
- [ ] **Add a `.dockerignore`** (`node_modules`, `out`, `dist`, `.git`, `.env*`, `agent-out`, `.cio`, `.opencode`, logs) so context stays small and no secrets leak in.
- [ ] **Add `compose.yaml`** for local full-stack testing (app + any backing store/volume) — documented, not for prod secrets.
- [ ] **Add a `HEALTHCHECK`** to the Dockerfile so Coolify can report status.
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
- [ ] **Link the website** in the repo: README top, repo `About`/homepage URL on GitHub.
- [ ] **Update the README release links** to the OSS repo (Phase 1) and add a hero section/logo + badges (CI status, license, downloads, version).
- [ ] **Tag and release `v0.2.1`** (next after current version) via the release workflow with signed installers, checksums, and release notes from `CHANGELOG.md`.
- [ ] **Verify the auto-update feed** points at the OSS GitHub Releases (README/`electron-builder.yml` currently reference the private repo — must be fixed) and that `electron-updater` resolves `latest.yml`/`latest-mac.yml` correctly.
- [ ] **Test the release artifacts** on a clean macOS/Windows/Linux machine (fresh install + update path) before announcing.
- [ ] **Post-launch hygiene**: enable discussions, announce on X/Twitter and relevant communities, and pin a "first contribution" issue.
- [ ] **Document the security model publicly** (README privacy section already covers data & privacy; add a short "Security" note pointing to `SECURITY.md`).
- [ ] **Set expectations for response time** so you don't get worn out: `SECURITY.md` SLA, Discussions for questions, Issues triaged weekly.

---

## Quick reference: files to create

| File | Purpose |
| ---- | ------- |
| `docs/RELEASE_CHECKLIST.md` | This checklist |
| `SECURITY.md` | Private vuln reporting + SLA |
| `CODE_OF_CONDUCT.md` | Contributor covenant |
| `.env.example` | Documented env contract |
| `.github/dependabot.yml` | Dependency bump automation |
| `.github/ISSUE_TEMPLATE/*.yml` | Bug/feature forms |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR checklist |
| `.github/CODEOWNERS` | Auto-review routing |
| `.github/workflows/release.yml` | Tagged release + publish |
| `Dockerfile` | Server deploy image |
| `.dockerignore` | Keep images clean |
| `compose.yaml` | Local stack + docs |
| `CHANGELOG.md` | Release history |

## Quick reference: files to fix

| File | Fix |
| ---- | --- |
| `package.json` | Remove `"private": true` |
| `electron-builder.yml` | `publish.owner`/`repo` → `pillardash-oss`; drive signing identity via env in CI |
| `README.md` | Release links → OSS repo; add homepage URL + badges |
