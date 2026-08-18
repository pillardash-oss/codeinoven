#!/usr/bin/env bash
#
# deploy:main — promote the current `nightly` branch into `main` (stable release).
#
# Requires that `nightly` was already promoted by `deploy:nightly`, so that a
# published `v<version>-nightly.<N>` prerelease exists for the version being
# promoted (the release workflow refuses to promote without it). `main` is then
# merged to match `nightly` content and pushed. Pushing to `main` triggers
# `.github/workflows/release.yml`, which builds and publishes the `v<version>`
# stable release with the GitHub tag created automatically by the workflow.
#
# Safety net:
#   - Requires a clean working tree.
#   - Verifies (via `gh`) that a matching nightly prerelease is already public.
#   - Enforces the version gate (main version must increase; must equal nightly).
#   - Merges nightly into main (never force-pushes, never rewrites history),
#     resolving file content in favor of the incoming nightly branch. If main
#     has work not contained in nightly, review it before confirming.
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
if [[ "$DRY_RUN" -eq 0 && -z "$(command -v gh)" ]]; then
  die "The 'gh' CLI is required to verify the nightly prerelease (run: brew install gh / gh auth login)."
fi

say "${C_BOLD}Resolving latest remote state...${C_RESET}"
git fetch origin

# --- 1. ensure we're on a clean, up-to-date nightly --------------------------
if [[ "$(git branch --show-current)" != "nightly" && "$DRY_RUN" -eq 0 ]]; then
  say "Checking out nightly..."
  git checkout nightly
fi
if [[ "$DRY_RUN" -eq 0 ]]; then
  git pull --ff-only origin nightly
else
  say "(dry-run) git pull --ff-only origin nightly"
fi

NIGHTLY_VERSION="$(pkg_version origin/nightly)"
MAIN_VERSION="$(pkg_version origin/main)"

say ""
say "${C_BOLD}Versions:${C_RESET}"
say "  nightly -> ${C_GREEN}$(git rev-parse --short origin/nightly)${C_RESET}  (version $NIGHTLY_VERSION)"
say "  main    -> ${C_GREEN}$(git rev-parse --short origin/main)${C_RESET}  (version $MAIN_VERSION)"
say ""

# --- 2. enforce the version gate (main must increase & equal nightly) --------
BASE_BRANCH=main HEAD_BRANCH=nightly BASE_VERSION="$MAIN_VERSION" \
  CURRENT_VERSION="$NIGHTLY_VERSION" bun scripts/validate-release-promotion.ts
ok "Version gate passed: main ($MAIN_VERSION) -> nightly ($NIGHTLY_VERSION)."

# --- 3. verify a published nightly prerelease exists for this version --------
if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! gh release list --limit 1000 --json tagName,isPrerelease | \
      jq -e --arg prefix "v${NIGHTLY_VERSION}-nightly." \
        'any(.[]; .isPrerelease and (.tagName | startswith($prefix)))' >/dev/null; then
    die "No published nightly prerelease found for v${NIGHTLY_VERSION}-nightly.* — run 'bun run deploy:nightly' first."
  else
    ok "Published nightly prerelease exists for v${NIGHTLY_VERSION}-nightly.*."
  fi
else
  say "(dry-run) gh would verify v${NIGHTLY_VERSION}-nightly.* prerelease exists"
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  say ""
  read -r -p "Merge nightly -> main and push? This triggers the stable release build. [y/N] " answer
  if [[ "${answer,,}" != "y" && "${answer,,}" != "yes" ]]; then
    die "Aborted by user."
  fi

  say "Merging nightly into main (favoring nightly content)..."
  git checkout main
  git pull --ff-only origin main
  git merge --no-ff origin/nightly -X theirs -m "Release: promote v$NIGHTLY_VERSION from nightly to main"

  # Guarantee package.json matches nightly exactly, regardless of resolution.
  git checkout origin/nightly -- package.json
  if ! git diff --cached --quiet package.json; then
    git commit -m "Release: set version to $NIGHTLY_VERSION for main promotion"
  fi

  say "Pushing main..."
  git push origin main
  ok "Pushed main at $(git rev-parse --short main)."
else
  say "(dry-run) git checkout main && git pull --ff-only origin main"
  say "(dry-run) git merge --no-ff origin/nightly -X theirs -m \"Release: promote v$NIGHTLY_VERSION from nightly to main\""
fi

say ""
say "${C_BOLD}Done.${C_RESET} The release workflow is building; verify the stable release "
say "v${NIGHTLY_VERSION} appears on GitHub."