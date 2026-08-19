#!/usr/bin/env bash
#
# deploy:nightly — promote the current `dev` branch into `nightly`.
#
# The `nightly` branch is fast-forwarded onto `dev` and pushed. Pushing to
# `nightly` triggers `.github/workflows/nightly.yml`, which validates the
# promotion, builds for mac/win/linux, and publishes a `v<version>-nightly.<N>`
# prerelease with the GitHub tag created automatically by the workflow.
#
# Safety net:
#   - Requires a clean working tree (no unpushed/uncommitted work).
#   - Sets the machine-local `nightly` branch equal to `dev`; it never
#     force-pushes and never rewrites history. If `nightly` has commit(s) not
#     present on `dev`, the promotion is REFUSED — reconcile manually first.
#   - Auto-bumps the `dev` version (patch +1) when it is not already higher
#     than the current `nightly` version, mirroring `promotion-version.yml`.
#   - Removes the stale `nightly` TAG (distinct from the branch) locally and on
#     origin, which otherwise makes `git` treat `nightly` as ambiguous.
#
# Usage: bun run deploy:nightly

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
  # pkg_version <ref> — read package.json.version from a local git ref
  git show "${1}:package.json" 2>/dev/null | node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))"
}

# --- 0. preconditions -------------------------------------------------------
if [[ "$DRY_RUN" -eq 0 && -n "$(git status --porcelain)" ]]; then
  die "Working tree is not clean. Commit or stash your changes before promoting."
fi

say "${C_BOLD}Resolving latest remote state...${C_RESET}"
git fetch origin

# --- 1. clear the stale `nightly` tag (distinct from the branch) ------------
if git rev-parse refs/tags/nightly >/dev/null 2>&1; then
  warn "Stale 'nightly' TAG found (it collides with the nightly branch). Deleting it..."
  if [[ "$DRY_RUN" -eq 0 ]]; then
    git push origin :refs/tags/nightly
    git tag -d nightly
  else
    say "(dry-run) git push origin :refs/tags/nightly && git tag -d nightly"
  fi
  ok "Stale 'nightly' tag removed."
fi

# --- 2. ensure we're on a clean, up-to-date dev ------------------------------
if [[ "$(git branch --show-current)" != "dev" || "$DRY_RUN" -eq 1 ]]; then
  if [[ "$DRY_RUN" -eq 0 ]]; then
    say "Checking out dev..."
    git checkout dev
  fi
fi
if [[ "$DRY_RUN" -eq 0 ]]; then
  git pull --ff-only origin dev
else
  say "(dry-run) git pull --ff-only origin dev"
fi

DEV_SHA="$(git rev-parse dev)"
NIGHTLY_BRANCH_SHA="$(git rev-parse origin/nightly)"

# --- 3. refuse if nightly has work not on dev (would need a rebase/merge) ----
if ! git merge-base --is-ancestor origin/nightly dev; then
  die "nightly has commits not present on dev. Reconcile dev onto nightly first (this script is fast-forward only)."
fi
if [[ "$DEV_SHA" == "$NIGHTLY_BRANCH_SHA" ]]; then
  ok "nightly is already up to date with dev ($DEV_SHA). Nothing to promote."
  exit 0
fi

# --- 4. version gate: dev version must exceed current nightly -----------------
NIGHTLY_VERSION="$(pkg_version origin/nightly)"
DEV_VERSION="$(pkg_version dev)"

if ! BASE_BRANCH=nightly HEAD_BRANCH=dev BASE_VERSION="$NIGHTLY_VERSION" \
    CURRENT_VERSION="$DEV_VERSION" bun scripts/validate-release-promotion.ts >/dev/null 2>&1; then
  warn "dev ($DEV_VERSION) is not a higher version than nightly ($NIGHTLY_VERSION); bumping dev by +1..."
  if [[ "$DRY_RUN" -eq 0 ]]; then
    bun run version:bump
    git commit -am "chore: bump version for nightly promotion" 
    git push origin dev
    DEV_VERSION="$(pkg_version dev)"
  else
    say "(dry-run) bun run version:bump && git commit -am 'chore: bump version for nightly promotion' && git push origin dev"
  fi
fi

say ""
say "${C_BOLD}Promotion summary:${C_RESET}"
say "  dev      -> ${C_GREEN}$(git rev-parse --short dev)${C_RESET}  (version $DEV_VERSION)"
say "  nightly  -> ${C_GREEN}$(git rev-parse --short origin/nightly)${C_RESET}  (version $NIGHTLY_VERSION)"
say ""

BASE_BRANCH=nightly HEAD_BRANCH=dev BASE_VERSION="$NIGHTLY_VERSION" \
  CURRENT_VERSION="$DEV_VERSION" bun scripts/validate-release-promotion.ts
ok "Version gate passed: dev ($DEV_VERSION) -> nightly ($NIGHTLY_VERSION)."

if [[ "$DRY_RUN" -eq 0 ]]; then
  say ""
  read -r -p "Promote dev -> nightly and push? This triggers the nightly build/release. [y/N] " answer
  if [[ "${answer,,}" != "y" && "${answer,,}" != "yes" ]]; then
    die "Aborted by user."
  fi

  say "Fast-forwarding nightly onto dev..."
  git checkout nightly
  git merge --ff-only dev

  say "Pushing nightly..."
  git push origin nightly
  ok "Pushed nightly at $(git rev-parse --short nightly)."
else
  say ""
  say "(dry-run) git checkout nightly && git merge --ff-only dev"
  say "(dry-run) git push origin nightly"
fi

say ""
say "${C_BOLD}Done.${C_RESET} The nightly workflow is building; verify the prerelease "
say "v${DEV_VERSION}-nightly.<RUN_NUMBER> appears on GitHub before promoting to main."