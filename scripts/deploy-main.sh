#!/usr/bin/env bash
#
# deploy:main — promote the current `nightly` branch into `main` (stable release).
#
# Requires that `nightly` was already promoted by `deploy:nightly`, so that a
# published `v<version>-nightly.<N>` prerelease exists for the version being
# promoted (the release workflow refuses to promote without it).
#
# The `main` branch is protected by the "Protect stable promotion" GitHub
# ruleset (PR required, no bypass), so this script opens a `nightly` -> `main`
# pull request and enables auto-merge rather than pushing directly. Once the
# required checks pass, GitHub merges it automatically, which triggers
# `.github/workflows/release.yml` to build and publish the `v<version>` stable
# release with the GitHub tag created automatically by the workflow.
#
# Safety net:
#   - Requires a clean working tree.
#   - Verifies (via `gh`) that a matching nightly prerelease is already public.
#   - Enforces the version gate (main version must increase; must equal nightly).
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

say ""
say "${C_BOLD}Versions:${C_RESET}"
say "  nightly -> ${C_GREEN}$(git rev-parse --short origin/nightly)${C_RESET}  (version $NIGHTLY_VERSION)"
say "  main    -> ${C_GREEN}$(git rev-parse --short origin/main)${C_RESET}  (version $MAIN_VERSION)"
say ""

# --- 2. enforce the version gate (semver-correct: nightly 0.5.52-nightly-1 -> stable 0.5.52) --
# Nightly already carries the next stable version (stable 0.5.51 -> nightly 0.5.52-nightly-1)
# So expected stable is exactly nightly's version.
EXPECTED_STABLE="$NIGHTLY_VERSION"
if ! BASE_BRANCH=main HEAD_BRANCH=nightly BASE_VERSION="$MAIN_VERSION" \
    CURRENT_VERSION="$EXPECTED_STABLE" bun scripts/validate-release-promotion.ts >/dev/null 2>&1; then
  die "Stable $EXPECTED_STABLE would not increase over main $MAIN_VERSION (nightly $NIGHTLY_VERSION). Ensure nightly is ahead of main."
fi
ok "Version gate passed: main ($MAIN_VERSION) -> stable ($EXPECTED_STABLE) via nightly ($NIGHTLY_VERSION)."

# --- 3. verify a published nightly prerelease exists for the base -----------
if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! gh release list --limit 1000 --json tagName,isPrerelease | \
      jq -e --arg base "$NIGHTLY_VERSION" \
        'any(.[]; .isPrerelease and (.tagName | test("^v\($base)-nightly[.-][0-9]+$")))' >/dev/null; then
    die "No published nightly prerelease found for v${NIGHTLY_VERSION}-nightly-{N} — run 'bun run deploy:nightly' first."
  else
    ok "Published nightly prerelease exists for v${NIGHTLY_VERSION}-nightly-{N}."
  fi
else
  say "(dry-run) gh would verify v${NIGHTLY_VERSION}-nightly-{N} prerelease exists"
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  EXISTING_PR="$(gh pr list --base main --head nightly --state open --json number --jq '.[0].number' 2>/dev/null || true)"
  if [[ -n "$EXISTING_PR" ]]; then
    say "Reusing existing nightly -> main PR #$EXISTING_PR."
  else
    say "Opening nightly -> main pull request..."
    PR_URL="$(gh pr create \
      --base main \
      --head nightly \
      --title "Release: promote v$NIGHTLY_VERSION from nightly to main" \
      --body "Automated stable promotion of nightly v$NIGHTLY_VERSION by deploy:main.

- Nightly prerelease for v$NIGHTLY_VERSION verified published.
- Version gate passed: main $MAIN_VERSION -> stable $NIGHTLY_VERSION.

Merging triggers .github/workflows/release.yml to build and publish the v$NIGHTLY_VERSION stable release.")" || die "Failed to open the nightly -> main pull request."
    ok "Opened $PR_URL"
    EXISTING_PR="$(gh pr list --base main --head nightly --state open --json number --jq '.[0].number')"
  fi
  say "Enabling auto-merge (merge commit) once required checks pass..."
  if gh pr merge "$EXISTING_PR" --auto --merge 2>/dev/null; then
    ok "Auto-merge armed. The stable release workflow will run once the PR merges."
  else
    warn "Could not enable auto-merge (repo setting or permissions). Merge the PR manually once checks pass:"
    warn "  gh pr list --base main --head nightly --state open"
  fi
else
  say "(dry-run) gh pr create --base main --head nightly --title \"Release: promote v$NIGHTLY_VERSION from nightly to main\""
  say "(dry-run) gh pr merge --auto --merge <pr>"
fi

say ""
say "${C_BOLD}Done.${C_RESET} Once the nightly -> main PR merges, the release workflow is building; verify the stable release "
say "v${NIGHTLY_VERSION} appears on GitHub."