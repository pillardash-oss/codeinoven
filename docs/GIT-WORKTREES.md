# Scope-Owned Git Worktrees

Versioned scopes (`ScopeBoard.version === 2`) are the single owners of working
roots in CodeInOven. This document describes how isolated worktrees behave,
how setup and environment files are managed, what health states exist, and
every expected confirmation before a destructive lifecycle action.

## 1. Scope-owned roots

- The **Default scope** and every migrated version 1 custom scope resolve to
  the project's registered local directory.
- A **managed scope** resolves to an app-managed Git worktree at:

  ```
  <config-root>/projects/<project-id>/scope/<directory-name>
  ```

  where `<config-root>` is CodeInOven's per-app config directory. The renderer
  never supplies a worktree path; main derives it from the persisted scope
  descriptor.
- `Thread.workingDirectory` is **compatibility data only**. The
  `ScopeRootResolver` is the authority at execution time: new threads, moved
  threads, forks, assignment workers, achievement workers, chat harnesses,
  checkpoints, terminals, editors, citations, Git state, and project-file
  indexes all resolve through the scope.
- An unhealthy managed scope **never falls back** to the project directory.
  It fails closed with a typed health category.

## 2. Migration

Version 1 boards load through the same `ScopeManager`, migrate deterministically
to version 2, and persist immediately. Every migrated bucket keeps its order,
appearance, collapse state, and thread assignments, and is rooted at the
project directory. The Default bucket is always project-rooted and can never be
archived, deleted, detached, or given a worktree. Renderer layout saves cannot
overwrite lifecycle metadata (`workspace root`, `archivedAt`, setup state, or
project-level defaults); layout and appearance mutations go through validated
main-owned operations.

## 3. Branch and directory naming

Managed branches always begin with `cio/`. Given a feature title:

1. Unicode NFKD normalization (compatibility decompose),
2. lowercase to ASCII,
3. only lowercase alphanumerics kept, other runs become `-`,
4. stripped of leading/trailing hyphens,
5. truncated to 48 characters,
6. an ID-derived fallback when the result is empty.

Colliding names get deterministic numeric suffixes `-2`, `-3`, and so on until
the branch, config-root directory, persisted metadata, and Git's recorded
worktree registrations are all free. Renaming a scope changes only its display
name; the established branch and directory names stay stable and the UI
explains this.

## 4. Setup commands

Project-level setup commands are persisted as ordered `{ executable, args }`
arrays (no shell strings). They run **sequentially** with the worktree as the
working directory, after environment propagation. Executables are resolved
through the shared GUI-safe PATH (`resolveExecutablePath`) with
`buildProcessEnvironment`, and commands never run through a shell. Output is
bounded in memory, streamed to the initiating renderer, and **never persisted**.
Each command's index, state, exit code, and timestamps are persisted.

Failure or interruption preserves the worktree and the scope association. The
UI offers **retry from the failed command** or **continue without setup**. A
setup process interrupted by restart is reported as recoverable, never as
complete.

## 5. Environment files

During creation the service discovers **untracked, regular, root-level** `.env`
and `.env.*` files in the source project that are absent from the new checkout.
Always excluded: `.env.example`, `.env.sample`, `.env.template`.

- **Copy mode (default):** each file is copied to a temporary file and renamed
  into place atomically; existing target files are never overwritten.
- **Symlink mode:** an atomic symlink to the source file is created (explicitly
  selected; not supported on Windows). The worktree then depends on the source
  project root staying put, which the UI explains.

Environment contents are secrets: they never appear in persisted metadata,
logs, progress events, or error messages.

## 6. Concurrency

Threads and write-capable agents **in the same scope share one filesystem** and
may overwrite each other's files; the UI and this document never present
same-scope agents as isolated. The isolation boundary is the worktree: separate
managed scopes get independent filesystems and independently keyed Git and file
state.

## 6a. Git panel is worktree-aware

Every Git-panel operation — status, diff, stage, unst-age, commit, branch
list/checkout/create/delete, fetch, pull, push, merge, rebase, stash,
discard/ignore, reset, amend, log, and PR create/compare — resolves its
repository root through the **active scope**. When the panel is attached to a
managed worktree scope, these operations run against the worktree checkout and
its `cio/` branch, not the project root:

- `git:pull`, `git:push`, `git:fetch`, `git:merge`, `git:rebase`, `git:reset`,
  `git:stash*`, `git:checkout`, and branch operations carry the active scope id
  and resolve through `ScopeRootResolver`, failing closed if the managed scope
  is unhealthy.
- Creating a PR from a worktree uses the **worktree's `cio/` branch as the PR
  head** and the chosen base (the checkout branch, a named branch, or a remote
  tracked ref). Pushing to the remote publishes the `cio/<slug>` branch as a
  new remote branch (`--set-upstream`), ready to be opened as a PR.
- Credential and identity operations (`git:get/setCredential`,
  `git:get/setIdentity`) stay project-scoped: worktrees share the repository's
  `.git` config and credential vault anyway.

## 7. Health states

Managed scopes expose a typed health result:

| Category | Meaning |
| --- | --- |
| `healthy` | Directory exists and Git registers it at the expected path on the expected branch |
| `missing` | The managed checkout directory is gone |
| `unregistered` | Git does not register the expected directory as a worktree |
| `locked` | The worktree is locked by Git |
| `prunable` | Git reports a stale registration |
| `branch-mismatch` | The worktree checks out a different branch |
| `path-mismatch` | The expected branch is registered at another directory |
| `repository-unavailable` | Git discovery failed or the project has no local repo |

Resolution fails closed for every non-`healthy` category. Repair, unlock,
restore, adopt, or detach actions appear in the UI; unhealthy scopes show
recovery guidance instead of operating on the project root.

## 8. Destructive lifecycle

Every destructive action is preceded by a confirmation dialog backed by a
**state-bound, single-use preflight**. The preflight reports dirty files, unique
commits not reachable from any remote-tracking ref, active processes, and
branch ownership, and mints one confirmation ID bound to that snapshot. The ID
is consumed at execution; stale or mismatched IDs are rejected.

- **Detach:** returns the scope to the project directory. Refused when the
  worktree is dirty or unpushed.
- **Remove worktree:** deletes the scope and removes the worktree. Refused for
  dirty or unpushed state unless a second **force** confirmation is completed.
- **Delete branch:** removes the scope's branch. Never implied by scope or
  worktree removal; it is always a separate, dedicated confirmation.
- **Delete scope:** removes the bucket from the board. Worktree removal and
  branch deletion remain separate confirmed actions.
- **Delete project:** refuses while managed worktree scopes exist rather than
  silently orphaning a registered worktree.

Archiving and restoring a scope never mutate Git, the worktree, environment
files, setup status, or thread assignments.

## 9. First-release limitations

- Repositories with **tracked submodules** (gitlink entries in the index) are
  blocked from managed-worktree creation before any mutation. Use a project-root
  scope for those repositories.
- Environment **symlink mode** is unavailable on Windows.