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

The commands chosen in the creation dialog are an **immutable request
snapshot**: they are executed for exactly that worktree even if the
project-level defaults change later, and retries replay the persisted
per-command records instead of whatever the defaults contain at retry time.
During creation the source checkout's current branch, HEAD commit, and
uncommitted changes are surfaced, together with a warning that dirty changes
will not be included in the new worktree.

A checkout that is **re-created after its setup already ran** (a repair
restoring it from the managed branch) no longer contains what the recorded
results describe. Repair therefore resets every command record to `pending`
and marks the scope's setup `stale`; the scope then offers **Re-run setup**
and the run replays the persisted commands from the first one, exactly like a
creation run. `stale` is a factual statement about the working tree, not a
failure.

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

Every Git-panel operation status, diff, stage, unst-age, commit, branch
list/checkout/create/delete, fetch, pull, push, merge, rebase, stash,
discard/ignore, reset, amend, log, and PR create/compare resolves its
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
- **Sync with another end** (`git:syncWith`, `git:syncPeers`) trades committed
  work between two ends of the same repository, in either direction. "Main" is
  not a special case carved out of it: it is the peer whose checkout is the
  project root, so the two flows share one implementation and cannot drift.
  The ends are offered by scope and by branch:
  - every checkout (the project root and each non-archived managed worktree
    scope) can contribute commits _and_ receive them,
  - every local branch no checkout holds can contribute commits only,
  - a branch a checkout already holds is offered as that checkout instead, so
    one end never appears twice under two names,
  - an unhealthy worktree still appears, marked with the reason it cannot be
    used, and the checkout the operation runs in appears marked as itself
    rather than being hidden.

  `git:syncPeers` resolves that list, and `git:syncWith` resolves the chosen
  `{ kind: 'root' | 'worktree' | 'branch' }` peer, so the name the picker showed
  is the name every error and toast uses. Both directions fail closed before
  moving any ref: a peer that is this very checkout, a detached HEAD, an
  integration already in progress, or a target with uncommitted files all refuse
  with an actionable message, and a merge in progress in the _other_ checkout is
  reported as well because its HEAD would be detached too.

  `from` reads the peer and writes this checkout: it refreshes the peer branch's
  remote-tracking ref first when the repository has a remote (vaulted token when
  present, a failed refresh is reported and never fatal), then integrates the
  remote-tracking ref when it strictly contains the local branch, otherwise the
  local branch, so commits that exist only in the other checkout are never
  skipped. The strategy follows the configured pull preference (`merge`,
  `rebase`, or `ff-only`; `ask` opens the chooser).

  `to` reads this checkout and writes the peer: this branch's commits are folded
  into the branch the peer has checked out, which is why a branch peer refuses
  this direction outright (a branch no checkout holds has nowhere to receive
  commits). Nothing is ever pushed publishing stays an explicit user action and
  the chooser always confirms first, even when the pull preference is not `ask`,
  because the write lands in a checkout the panel is not showing. Strategies:
  - `merge` integrates in the receiving checkout (fast-forward when possible,
    merge commit otherwise). A merge that would conflict is rolled back and
    refused with the `from` workflow as the fix, so a one-click action can never
    strand another checkout mid-merge where the user cannot see it.
  - `rebase` replays this branch's commits on top of the peer's branch, then
    fast-forwards the peer onto the rebased branch: conflicts stay in the
    checkout the panel shows, the peer stays linear and is never rewritten.
  - `ff-only` moves the peer only when it has not diverged.

  A conflicted `from`, or a conflicted `to` rebase, is left in the working tree
  for the standard conflict UI instead of being aborted. `incoming` reports how
  many commits the receiving end did not have, and `peerAhead` how far the moved
  branch is from its upstream afterwards, so the caller can say exactly what
  happened and that nothing was published.

  The UI reaches it two ways, and both start from a **managed worktree scope**:
  a worktree is the only scope with a second checkout to trade with. The Git
  panel, attached to one, keeps **Sync from main** and **Sync to main** for the
  common case (named, no chooser) and adds **Sync from branch…** and **Sync to
  branch…**, which open one shared peer chooser that the scope menu reuses as
  **Merge from project…** right below **Merge into project…**. The control is not
  rendered at all for the project root, so `main` never offers to sync with
  itself; the project root is reached as a peer from the worktree instead.

- Credential and identity operations (`git:get/setCredential`,
  `git:get/setIdentity`) stay project-scoped: worktrees share the repository's
  `.git` config and credential vault anyway.

## 6b. Long worktree runs live in the dock

Creating, adopting, re-running setup for, and deleting a scope all mutate a
checkout, so none of them is instant. Each one runs as an **app-level job**
(`src/renderer/lib/stores/scope-jobs.svelte.ts`) rendered by
`src/renderer/lib/components/scope/ScopeJobDockHost.svelte` at the app root, not
as a modal the user has to sit through. A job survives navigation, can be
minimized to a dock chip that still names what it is doing, states its outcome
in the panel (branch and directory for a created or adopted worktree, the
removed checkout for a deletion), and can be dismissed once it is finished.

Worktree stages stream from main on `scope:worktree:progress`, so a job a user
started and a job an agent started through `cio:scope` render identically. A
removal has no streamed stages main can send: the renderer performs it as an
ordered sequence of its own steps (settle the scope's threads, remove the
managed checkout and its branch when the scope has one, drop the scope from the
board), and the checklist reports those steps instead. A removal job never
absorbs worktree progress events, so a create or adopt running in the same
project still shows its own live stages.

## 7. Health states

Managed scopes expose a typed health result:

| Category                 | Meaning                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| `healthy`                | Directory exists and Git registers it at the expected path on the expected branch |
| `missing`                | The managed checkout directory is gone                                            |
| `unregistered`           | Git does not register the expected directory as a worktree                        |
| `locked`                 | The worktree is locked by Git                                                     |
| `prunable`               | Git reports a stale registration                                                  |
| `branch-mismatch`        | The worktree checks out a different branch                                        |
| `path-mismatch`          | The expected branch is registered at another directory                            |
| `repository-unavailable` | Git discovery failed or the project has no local repo                             |

Resolution fails closed for every non-`healthy` category. Repair, unlock,
restore, adopt, or detach actions appear in the UI; unhealthy scopes show
recovery guidance instead of operating on the project root. Detection is
passive but live: nothing polls the filesystem, and every surface that has a
reason to touch a scope (entering the board or the scoped sidebar, switching
the docked scope, attaching the Git panel, opening the scope's actions menu, or
any failed operation in it) re-reads that scope's health asynchronously,
throttled per scope. Every scope-root error message ends with the action that
resolves it, so a surface that can only render text still says how to fix it.

### 7a. Repair and adoption

The **Repair worktree** action maps one-to-one onto health categories:
locked registrations are unlocked, prunable registrations are pruned (and
re-created from the managed branch when the checkout is gone), missing
checkouts are restored from their `cio/` branch, relocated checkouts are
moved back under the config root with `git worktree move`, switched branches
are re-checked out, and unregistered directories get a best-effort
`git worktree repair`. The resulting health state is surfaced afterwards;
repair never silently falls back to the project directory. A step Git refuses
(unlocking, moving, re-checking out, relinking, re-creating) fails with the
recovery the user has to perform, never with a silent no-op.

A restored checkout contains only what the managed branch committed, so repair
**reconciles** it: the untracked root `.env` files are propagated again
(section 5), and the recorded setup is marked `stale` so the scope offers
**Re-run setup** (section 4). Work that was never committed is gone with the
directory and is never presented as recovered. When the managed branch itself
no longer exists, the restore cannot be done and the failure says so, naming
delete-scope as the way to clear the record.

The board and the scoped sidebar also render the cause and the fix for an
unhealthy scope next to a **Repair worktree** button, and the Git panel
replaces its generic error with the same banner when the checkout it is
attached to is the reason its operations fail. Rendered guidance and thrown
error text come from the same source (`src/lib/scope-worktree-health.ts`), so
they cannot drift apart.

**Adoption** registers an existing raw Git worktree (for example one created
manually with `git worktree add`) as a managed scope root. Adoption requires
a registered, non-detached, non-bare worktree on a named branch that is not
the main project checkout and whose branch is not already managed. The
checkout is moved beneath the canonical config-root path with
`git worktree move`, attached to the scope, and then treated exactly like a
freshly created managed worktree (environment propagation, optional setup,
typed health).

## 8. Destructive lifecycle

Every destructive action is preceded by a confirmation dialog backed by a
**state-bound, single-use preflight**. The preflight reports dirty files,
unique commits on the scope's managed branch that are not reachable from any
remote-tracking ref (unrelated local branches never block this scope),
active processes in the scope, and branch ownership, and mints one
confirmation ID bound to that snapshot. The ID is consumed at execution;
stale or mismatched IDs are rejected.

- **Remove worktree (keep scope):** removes the worktree checkout and
  re-points the scope to the project directory. The scope, its threads and the
  branch are all kept only the isolated checkout is gone. Refused when the
  worktree is dirty or unpushed unless the dialog's forced second confirmation
  is enabled, and the confirmed force is passed to Git so a forced detach can
  never leave the directory behind while the scope claims it is gone. A
  checkout whose directory was already deleted externally detaches cleanly.
- **Delete scope:** full cleanup for a managed scope removes the worktree
  checkout, deletes the scope bucket and the `cio/` branch in one confirmed
  action. The dialog also offers to permanently delete the scope's threads
  (otherwise they return to the Default scope). Deleting a project-rooted
  scope just removes the bucket; its threads follow the same choice.

  The confirmation stays a dialog, but the removal itself is a dock job
  (section 6b), exactly like a create or an adopt: confirming closes the dialog
  and hands the work to a run the user can background. Every value the run needs
  (the scope's threads, whether it owns a checkout, the thread disposition) is
  read before the dialog closes, and the removal mints its own fresh preflight
  token rather than reusing the dialog's display-only one, so the token can
  never be stale by the time the checkout is removed. Because it is a job, the
  dialog closes on the run already in progress instead of queueing a second
  removal that could only fail.

- **Archive / Restore:** never destructive. Hides or restores the scope on the
  board without touching Git, the worktree, or threads; archiving never
  implies removal.
- **Delete project:** refuses while managed worktree scopes exist rather than
  silently orphaning a registered worktree.

The scope actions menu intentionally exposes only the non-overlapping
operations (reveal-in-file-manager, merge-into-project, merge-from-project,
remove-worktree-keep-scope, archive, delete). It is a portaled popup
(`bits-ui` `DropdownMenu`, `collisionPadding`), not a panel positioned inside
the sidebar's own overflow, so it cannot be clipped when a scope sits near an
edge of the board or the scoped sidebar; while it is open the trigger stays
visible through its own open state rather than hover. **Reveal in File Manager**
opens a managed scope's checkout in the OS file manager through the same shared
helper (`src/renderer/lib/os-file-manager.ts`) and the same re-validating
`shell:revealPath` contract the file surfaces use. It takes the path from the
scope's health (the actual path when Git disagrees with the expected one), so a
relocated checkout still reveals correctly, and a refusal from main is reported
as a failure instead of passing as a silent no-op. _Merge from project…_ is the
peer sync described in section
6a run from this scope's checkout with the project root preselected, so bringing
the project root's commits into a worktree never requires opening the Git panel
from a thread in that scope. A leftover
`Delete branch`-style entry is not needed: removing a worktree while keeping
its scope is _Remove worktree (keep scope)_, and permanently removing a scope
is _Delete scope_ (which also removes the worktree and branch). Branch-level
maintenance that keeps the worktree lives in the Git panel.

Archiving and restoring a scope never mutate Git, the worktree, environment
files, setup status, or thread assignments.

## 8a. Agent-created scopes (`cio:scope`)

Agents create and manage worktree scopes through one app-owned utility,
`cio:scope` (`src/lib/utility-ids.ts`, seeded by
`src/main/utilities/utility-registry-service.ts`, executed by
`src/main/workspaces/scope-tool-service.ts`). It is deliberately **not** a tool
in any harness's tool list: a session that never involves a worktree must not
carry the schema, and most sessions never want one. It behaves exactly like the
other app-owned utilities (`cio:cua-driver`, `cio:browser`), so an agent reaches
it the same way:

1. `cio_util_find` (query `worktree`) returns it as an on-demand utility,
2. `cio_util_init` activates it and hands back the full contract
   (`SCOPE_CAPABILITY_DOCS` in `src/lib/scope-tool.ts`), which is the only place
   that contract enters context,
3. `cio_util_use` invokes it with `utility_id: "cio:scope"`, `operation: <action>`
   and `input: <the action's fields>`.

The activation is banked per thread, so later turns can invoke it by id without
searching again, and `cio_util_docs_lookup` re-lists the contract after
compaction. Because it is an ordinary registry utility, the Utilities screen
lists it, and disabling it there removes both the capability and the one-line
pointer the turn instructions add for it.

Agents are told to use it **only** when the user explicitly asks to work in a
separate worktree, never on their own initiative: that rule is in the turn
instruction, in the registry description a search returns, and in the activated
contract.

Running `git worktree add` directly is **not** supported. A raw worktree is
invisible to the app: it never appears on the scope board, gets no health check,
no environment propagation, no setup run, and no entry in the sync or
lifecycle tooling. A worktree made through `cio:scope` is a normal managed
scope from the moment it exists. On Pi, the bash gate routes
`git worktree add|remove|move|lock|unlock|prune` through the permission card
(`src/main/drivers/pi-core-tools-extension.ts`) so a raw worktree can only
happen while the user is looking at the request; `git worktree list` and
`repair` stay ungated.

Actions (one `operation` per call; a target scope resolves by id or display name
and defaults to the calling thread's scope):

- **Reads** `list`, `status`, `conflicts`, `source_info`, `detect_adoptable`.
- **Writes** `create`, `rename`, `pin`/`unpin`, `archive`/`restore`, `adopt`,
  `repair`, `retry_setup`, `sync_from_main`, `sync_to_main`.
- **Destructive** `detach_worktree`, `delete_scope`, `merge_into_project`.

`create` forks from the project checkout's current branch unless `baseBranch`
names another one; naming, environment propagation and setup commands all follow
the scope board's worktree defaults, and the calling thread moves into the new
scope by default (`attachThread: false` keeps it where it is). An agent-run
create, adopt or retry streams the same `scope:worktree:progress` stages a
user-run one does and lands as a docked job chip labelled as an agent run.

Confirmed board changes are pushed to the renderer (`scope:boardChanged`), so a
scope an agent creates, renames, archives, deletes, syncs or merges appears on
the board without the user having to reopen it.

### Destructive actions an agent asks for

The capability never destroys anything on first ask. A destructive call without
`confirm: true` changes nothing and returns the state-bound snapshot plus an
explicit challenge (`Are you sure you want to <action>? [YES] [NO]`).

With `confirm: true` the behaviour depends on the thread's permission level:

- **Full Access** no app dialog. The in-tool challenge above is the only gate,
  so the model itself must confront the consequences before confirming.
- **Auto Review** the app shows a confirmation dialog
  (`scope:agentConfirmation`) listing the scope, the summary, the discrete
  consequences, the dirty files, and the unpushed commits. The agent's tool call
  is parked until the user answers, and an unanswered request expires into a
  denial. Live processes in the scope block the action outright.

`delete_scope` on a scope that still owns threads refuses to run until the call
names the disposition: `threads: "move-to-default"` keeps the conversations,
`threads: "delete"` deletes them with the scope.

## 9. First-release limitations

- Repositories with **tracked submodules** (gitlink entries in the index) are
  blocked from managed-worktree creation before any mutation. Use a project-root
  scope for those repositories.
- Environment **symlink mode** is unavailable on Windows.

## 10. Running dev side by side with a worktree

A managed worktree is a complete checkout of its managed branch, so `bun dev`
runs inside it while the project root keeps its own instance open. The pieces
that make that safe are listed here.

### 10.1 Renderer port

The renderer origin carries persisted state (recovery snapshot, thread visits,
UI preferences in origin-keyed `localStorage`), so the port is pinned instead of
drifting:

- the project root keeps the stable `5173`;
- a linked worktree derives its own stable port from its own path (pool
  `5200` to `5999`), so each worktree keeps the same origin across restarts;
- `CODEINOVEN_RENDERER_PORT=<port>` overrides the choice.

`strictPort` stays on, so a port that is already taken fails the launch loudly
instead of silently moving the origin and dropping that persisted state. If two
worktrees ever derive the same port, or a second independent clone resolves the
`5173` default, set `CODEINOVEN_RENDERER_PORT` for one of them. Resolution lives
in `electron.vite.config.ts`.

### 10.2 App data root

Every instance shares CodeInOven's config root by default, which is a supported
configuration: the instance registry, the atomic `mkdir` cross-process locks,
and the WAL SQLite connection with `busy_timeout` are all built for several live
instances. Sharing means shared projects, threads, settings, logs, and window
state.

To give one instance a data root of its own, pass an absolute path:

```
CODEINOVEN_CONFIG_ROOT=/abs/path/to/instance-config bun dev
```

Unpackaged launches (`bun dev`, `electron-vite preview`) and the packaged
startup smoke harness honor it; a shipped app ignores it, so a stray environment
variable can never repoint a user's real data root. When the variable is set,
every launch logs whether it was honored. Managed worktrees are created
thereunder, so a different root has its own project registry: use it for a
throwaway instance, not for opening the worktree you want to review.

### 10.3 Chromium profile

Cookies, embedded-browser partitions, and the remote pairing material live in
the platform Electron profile, which instances share. `--user-data-dir` splits
it (electron-vite appends `ELECTRON_CLI_ARGS` to the dev Electron command):

```
ELECTRON_CLI_ARGS='["--user-data-dir=/abs/path/to/instance-profile"]' bun dev
```

### 10.4 Before the first dev run in a new worktree

The checkout is complete, but gitignored build inputs are not. Run the project's
setup commands (`bun install`, and `bun run harness:build-pi` when the instance
should use the bundled Pi rather than a PATH `pi`). The `predev` hook reuses the
compiled speech workers from the machine-local shared build cache, so it does
not recompile them when the package sources are unchanged. It compiles only on a
real miss, and on Apple Silicon that compile needs the Xcode Metal toolchain,
installed once with `xcodebuild -downloadComponent MetalToolchain`. Untracked
root `.env` files are copied by creation (section 5).

### 10.5 Concurrent-instance caveats

- Remote mode stays off in dev unless `CODEINOVEN_DEV_REMOTE_MODE=1`. With it on
  in two instances, keep them apart with `LAN_PORT` and `LAN_LOCAL_PORT`.
- `bun dev:remote-pwa` owns its own port, overridable with `REMOTE_PWA_DEV_PORT`.
- Settings, logs, the gateway plugin data directory, and the speech process
  journal are single files under the config root, so two instances writing them
  concurrently is last-write-wins. Give an instance its own
  `CODEINOVEN_CONFIG_ROOT` when that matters.
