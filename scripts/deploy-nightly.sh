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
#     present on `dev` AND the content differs, the promotion is REFUSED —
#     reconcile manually first. If `nightly` already contains `dev`'s content
#     (e.g. a promotion landed via a reviewed PR merged directly into
#     `nightly` instead of this script), it's treated as nothing-to-promote.
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
    if ! git push origin :refs/tags/nightly 2>&1; then
      warn "Could not delete remote 'nightly' tag (likely protected by a repository rule). Continuing — git will use the branch ref explicitly."
    fi
    git tag -d nightly 2>/dev/null || true
  else
    say "(dry-run) git push origin :refs/tags/nightly && git tag -d nightly"
  fi
  ok "Stale 'nightly' tag handled."
fi
# Also handle remote-only tag (local tag already deleted but remote still exists)
if ! git rev-parse refs/tags/nightly >/dev/null 2>&1; then
  if git ls-remote --tags origin | grep -q "refs/tags/nightly$"; then
    warn "Remote 'nightly' tag still exists (protected). Will continue with explicit branch refs."
  fi
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

if [[ "$DEV_SHA" == "$NIGHTLY_BRANCH_SHA" ]]; then
  ok "nightly is already up to date with dev ($DEV_SHA). Nothing to promote."
  exit 0
fi

# --- 3. reconcile nightly vs dev ancestry ------------------------------------
# Normally this script is the only path from dev -> nightly, so nightly is
# always a pure ancestor of dev. But promotions can also land via a reviewed
# GitHub PR merged directly into nightly, which creates a merge commit that is
# never replayed onto dev. That leaves dev as an ancestor of nightly instead
# (the reverse relationship) even though file content is identical. Detect
# that case and treat it as "nothing to promote" rather than refusing.
if git merge-base --is-ancestor origin/nightly dev; then
  : # normal case: dev has new commits ahead of nightly, fast-forward below.
elif git merge-base --is-ancestor dev origin/nightly; then
  if git diff --quiet origin/dev origin/nightly; then
    ok "nightly already contains dev's content at $(git rev-parse --short origin/nightly) (promoted via PR instead of this script). Nothing to promote."
    exit 0
  else
    die "nightly is ahead of dev but has different file content (likely a PR merged extra changes into nightly). Reconcile manually before promoting."
  fi
else
  die "dev and nightly have diverged with no common fast-forward path. Reconcile manually before promoting."
fi

# --- 4. version gate: dev must be next patch after stable (semver-correct nightly) -----
NIGHTLY_VERSION="$(pkg_version origin/nightly)"
DEV_VERSION="$(pkg_version dev)"

# Semver-correct: stable 0.5.51 -> nightly 0.5.52-nightly-1 must be > stable.
# dev must be one patch ahead of nightly (first nightly after stable),
# or equal for subsequent nightlies on same base.
# Only auto-bump when dev==nightly AND nightly equals stable (main) — i.e. first nightly after a stable.
if ! BASE_BRANCH=nightly HEAD_BRANCH=dev BASE_VERSION="$NIGHTLY_VERSION" \
    CURRENT_VERSION="$DEV_VERSION" bun scripts/validate-release-promotion.ts >/dev/null 2>&1; then
  if [ "$DEV_VERSION" = "$NIGHTLY_VERSION" ]; then
    MAIN_VERSION="$(pkg_version origin/main 2>/dev/null || echo "$NIGHTLY_VERSION")"
    if [ "$NIGHTLY_VERSION" = "$MAIN_VERSION" ]; then
      warn "dev ($DEV_VERSION) equals nightly ($NIGHTLY_VERSION) which equals stable ($MAIN_VERSION) — bumping dev to next patch for semver-correct nightly (stable $MAIN_VERSION -> nightly $MAIN_VERSION+1)..."
      if [[ "$DRY_RUN" -eq 0 ]]; then
        git checkout dev
        bun scripts/bump-version.ts
        DEV_VERSION="$(pkg_version dev)"
        git add package.json src/renderer/static/manifest.webmanifest services/remote-control/package.json
        git commit -m "chore: bump version for nightly promotion"
        git push origin dev
        ok "Bumped dev to $DEV_VERSION and pushed."
      else
        say "(dry-run) bun scripts/bump-version.ts && git push origin dev"
        DEV_VERSION="$(node -p "(() => { const v='"$DEV_VERSION"'.split('.').map(Number); let [M,m,p]=v; p+=1; if(p===100){p=0;m+=1} if(m===100){m=0;M+=1} return M+'.'+m+'.'+p })()")"
      fi
    else
      die "dev ($DEV_VERSION) must be one patch ahead of nightly ($NIGHTLY_VERSION) for semver-correct nightly (nightly $NIGHTLY_VERSION is already ahead of stable $MAIN_VERSION)."
    fi
  else
    die "dev ($DEV_VERSION) must be equal or one patch ahead of nightly ($NIGHTLY_VERSION) (e.g. stable $NIGHTLY_VERSION -> 0.5.52-nightly-1, then 0.5.52-nightly-2)."
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
say "v${DEV_VERSION}-nightly-{N} appears on GitHub before promoting to main."