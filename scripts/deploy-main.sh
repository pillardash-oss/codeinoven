#!/usr/bin/env bash
#
# deploy:main — promote the current `nightly` branch into `main` (stable release).
#
# Requires that `nightly` was already promoted by `deploy:nightly`, so that a
# published `v<version>-nightly.<N>` prerelease exists (the release workflow
# refuses to promote without it).
#
# Stable versioning: publishing to main bumps the stable version. The script
# derives the next stable version as max(main, nightly base) + 1 patch and
# commits that bump to a dedicated `promotion/stable-v<version>` branch, which
# is merged into `main` via the promotion PR. Nightly's own version stays one
# stable cycle ahead (e.g. stable 0.5.54 -> nightly 0.5.55-nightly.N).
#
# The `main` branch is protected by the "Protect stable promotion" GitHub
# ruleset (PR required, no bypass), so this script opens a
# `promotion/stable-v<version>` -> `main` pull request and enables auto-merge
# rather than pushing directly. Once the required checks pass, GitHub merges it
# automatically, which triggers `.github/workflows/release.yml` to build and
# publish the `v<version>` stable release with the GitHub tag created
# automatically by the workflow.
#
# Safety net:
#   - Requires a clean working tree.
#   - Verifies (via `gh`) that a matching nightly prerelease is already public.
#   - Enforces the version gate (stable version must be exactly one patch
#     ahead of main) and commits the bump on a dedicated promotion branch.
#   - All remote state is resolved from `origin/*` refs; no local branch checkout
#     or pull of `nightly`/`main` is performed, so stale local branches cannot
#     break the run.
#
# Usage: bun run deploy:main

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
else
  DRY_RUN=0
fi
if [[ "$DRY_RUN" -eq 0 && -z "$(command -v gh)" ]]; then
  die "The 'gh' CLI is required to verify the nightly prerelease and open the stable-promotion pull request (run: brew install gh / gh auth login)."
fi

C_RED=$'\033[31m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_BOLD=$'\033[1m'
C_RESET=$'\033[0m'

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
die()  { printf '%sERROR: %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

pkg_version() {
  git show "${1}:package.json" 2>/dev/null | node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))"
}

# --- 0. preconditions -------------------------------------------------------
if [[ "$DRY_RUN" -eq 0 && -n "$(git status --porcelain)" ]]; then
  die "Working tree is not clean. Commit or stash your changes before promoting."
fi

say "${C_BOLD}Resolving latest remote state...${C_RESET}"
git fetch origin

NIGHTLY_SHA="$(git rev-parse origin/nightly)"

NIGHTLY_VERSION="$(pkg_version origin/nightly)"
MAIN_VERSION="$(pkg_version origin/main)"

# Stable version to publish: max(main, nightly base) + 1 patch. Nightly's
# version may already be one patch ahead of main (nightly carries the next
# stable), so the promotion branch takes that version; otherwise it bumps
# main by one patch.
NEXT_STABLE="$(node -e "
  const a = '$MAIN_VERSION'.split('.').map(Number);
  const b = '$NIGHTLY_VERSION'.split('.').map(Number);
  let v = (b[0]*10000 + b[1]*100 + b[2]) > (a[0]*10000 + a[1]*100 + a[2]) ? b : a;
  v = [v[0], v[1], v[2] + 1];
  if (v[2] === 100) { v[2] = 0; v[1] += 1; }
  if (v[1] === 100) { v[1] = 0; v[0] += 1; }
  console.log(v.join('.'));
")"
PROMO_BRANCH="promotion/stable-v${NEXT_STABLE}"

say ""
say "${C_BOLD}Versions:${C_RESET}"
say "  nightly -> ${C_GREEN}$(git rev-parse --short origin/nightly)${C_RESET}  (version $NIGHTLY_VERSION)"
say "  main    -> ${C_GREEN}$(git rev-parse --short origin/main)${C_RESET}  (version $MAIN_VERSION)"
say ""

# --- 2. verify a published nightly prerelease exists -------------------------
NIGHTLY_BASE="${NIGHTLY_VERSION}"
if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! gh release list --limit 1000 --json tagName,isPrerelease | \
      jq -e --arg base "$NIGHTLY_BASE" \
        'any(.[]; .isPrerelease and (.tagName | test("^v\($base)-nightly[.-][0-9]+$")))' >/dev/null; then
    die "No published nightly prerelease found for v${NIGHTLY_BASE}-nightly-{N} — run 'bun run deploy:nightly' first."
  else
    ok "Published nightly prerelease exists for v${NIGHTLY_BASE}-nightly-{N}."
  fi
else
  say "(dry-run) gh would verify v${NIGHTLY_BASE}-nightly-{N} prerelease exists"
fi

say ""
say "${C_BOLD}Promotion plan:${C_RESET}"
say "  main    -> ${C_GREEN}$(git rev-parse --short origin/main)${C_RESET}  (version $MAIN_VERSION)"
say "  nightly -> ${C_GREEN}$(git rev-parse --short origin/nightly)${C_RESET}  (version $NIGHTLY_VERSION)"
say "  stable  -> ${C_GREEN}$PROMO_BRANCH${C_RESET}  (version $NEXT_STABLE, one patch ahead of main)"
say ""

# --- 3. build the promotion branch with the stable version bump -------------
# Work from origin/main, bump package.json (plus the synced manifest and
# remote-control package) to the next stable version, and push the branch.
# Every step pushes to the promotion branch only — main is touched solely by
# the PR merge.
if [[ "$DRY_RUN" -eq 0 ]]; then
  if git ls-remote --exit-code --heads origin "$PROMO_BRANCH" >/dev/null 2>&1; then
    say "Promotion branch $PROMO_BRANCH already exists on origin — reusing it."
  else
    say "Creating promotion branch $PROMO_BRANCH from origin/main..."
    git checkout -b "$PROMO_BRANCH" origin/main
    MAIN_VERSION="$MAIN_VERSION" NEXT_STABLE="$NEXT_STABLE" bun -e '
      const { readFileSync, writeFileSync } = await import("node:fs");
      const next = process.env.NEXT_STABLE;
      const prev = process.env.MAIN_VERSION;
      const files = [
        "package.json",
        "src/renderer/static/manifest.webmanifest",
        "services/remote-control/package.json",
      ];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        const updated = text.replace(new RegExp(`("version"\\s*:\\s*)"${prev}"`), `$1"${next}"`);
        if (updated === text) throw new Error(`version ${prev} not found in ${file}`);
        writeFileSync(file, updated);
      }
    '
    git add package.json src/renderer/static/manifest.webmanifest services/remote-control/package.json
    git commit -m "Release: bump to $NEXT_STABLE for stable release (from main $MAIN_VERSION)"
    git push origin "$PROMO_BRANCH"
    ok "Promotion branch pushed with stable version $NEXT_STABLE."
    git checkout - >/dev/null 2>&1 || git checkout dev >/dev/null 2>&1 || true
  fi
else
  say "(dry-run) create $PROMO_BRANCH from origin/main, bump version to $NEXT_STABLE, push"
fi

# --- 4. version gate --------------------------------------------------------
if ! BASE_BRANCH=main HEAD_BRANCH="$PROMO_BRANCH" BASE_VERSION="$MAIN_VERSION" \
    CURRENT_VERSION="$NEXT_STABLE" bun scripts/validate-release-promotion.ts >/dev/null 2>&1; then
  die "Version gate failed: stable $NEXT_STABLE must be exactly one patch ahead of main $MAIN_VERSION."
fi
ok "Version gate passed: main ($MAIN_VERSION) -> stable ($NEXT_STABLE)."

# --- 5. open the promotion PR and enable auto-merge -------------------------
if [[ "$DRY_RUN" -eq 0 ]]; then
  EXISTING_PR="$(gh pr list --base main --head "$PROMO_BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || true)"
  if [[ -n "$EXISTING_PR" ]]; then
    say "Reusing existing $PROMO_BRANCH -> main PR #$EXISTING_PR."
  else
    say "Opening $PROMO_BRANCH -> main pull request..."
    PR_URL="$(gh pr create \
      --base main \
      --head "$PROMO_BRANCH" \
      --title "Release: promote v$NEXT_STABLE from nightly to main" \
      --body "Automated stable promotion of nightly v$NIGHTLY_VERSION by deploy:main.

- Nightly prerelease for v$NIGHTLY_BASE verified published.
- Version bump: main $MAIN_VERSION -> stable $NEXT_STABLE.

Merging triggers .github/workflows/release.yml to build and publish the v$NEXT_STABLE stable release.")" || die "Failed to open the promotion pull request."
    ok "Opened $PR_URL"
    EXISTING_PR="$(gh pr list --base main --head "$PROMO_BRANCH" --state open --json number --jq '.[0].number')"
  fi
  say "Enabling auto-merge (merge commit) once required checks pass..."
  if gh pr merge "$EXISTING_PR" --auto --merge 2>/dev/null; then
    ok "Auto-merge armed. The stable release workflow will run once the PR merges."
  else
    warn "Could not enable auto-merge (repo setting or permissions). Merge the PR manually once checks pass:"
    warn "  gh pr list --base main --head $PROMO_BRANCH --state open"
  fi
else
  say "(dry-run) gh pr create --base main --head $PROMO_BRANCH --title \"Release: promote v$NEXT_STABLE from nightly to main\""
  say "(dry-run) gh pr merge --auto --merge <pr>"
fi

say ""
say "${C_BOLD}Done.${C_RESET} Once the promotion PR merges, the release workflow is building; verify the stable release "
say "v${NEXT_STABLE} appears on GitHub."