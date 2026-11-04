# Bound assistant tasks

An assistant task lives on the Assistant view and can run in a real project
checkout. This page documents the model, the gate that refuses an unusable
checkout, and the run receipt that states what a run actually did.

## Why the model exists

`Thread.projectId` used to answer three questions at once: where a thread is
listed, which checkout its session, file tree and Git panel read, and whether a
project-board row arrived on its own. They coincide for every project thread, so
nothing ever had to tell them apart. A task that lives on the Assistant view and
works in a project checkout is the first thread where they differ.

So the thread gained a second, optional pair:

| Field               | Means                                                                           |
| ------------------- | ------------------------------------------------------------------------------- |
| `Thread.projectId`  | **Home.** Which view lists the thread. Never changes when a task binds.         |
| `Thread.boundScope` | **Workspace.** The project scope its runs read and write. Assistant-space only. |

The pair is persisted as `bound_scope_project_id`, `bound_scope_scope_id` and
`bound_scope_home_project_id` (schema version 6, `src/main/database/migrations/v006.ts`).
A path is deliberately not stored: a worktree can be moved, a project relocated
or a worktree repaired, and a persisted path would outlive all three as a lie.

## One resolver, every surface

`src/lib/bound-scope.ts` is the only place that answers "which checkout does this
thread work in":

- A project thread resolves to its own project and scope bucket.
- A bound assistant task resolves to the scope it is bound to.
- An unbound assistant task, a standalone chat and a browser conversation
  resolve to nothing, which is their app-owned workspace directory.

The rail (`src/renderer/lib/components/workspace/WorkspaceContextPanelContent.svelte`),
the composer shoe (`ThreadView-composer-scope.svelte.ts`), the receipt and the
park gate all call it, so no two surfaces can name different checkouts.

Binding is validated twice: `src/main/ipc/validation/threads.ts` rejects a
malformed pair at the IPC boundary, and the thread manager asserts that the
project exists and the scope is still on its board before storing it. A rebind is
an explicit, confirmed action from the task's own scope picker.

## The park gate

`src/main/chat/run-scope-gate.ts` inspects a bound thread's scope before a turn
starts. A healthy or project-rooted scope proceeds; an unhealthy one parks the
run with the resolver's typed health category and the app's own repair guidance
(`src/lib/scope-worktree-health.ts`), then refuses the turn.

The one outcome this prevents is silence: a run that could not prove its
checkout would otherwise write into the assistant's storage folder while the user
believes it worked in their project. Parking sets `status: 'working-paused'`,
`lastOutcome: 'parked'`, and a typed `parkReason` that the task row and the
receipt both read. The reason clears the moment a turn actually starts.

## The run receipt

A run's receipt answers "what did this run do", not "what is in this checkout".

- **Shape.** `src/lib/types/receipt.ts`, shaped by `src/lib/run-receipt.ts`.
- **Service.** `src/main/chat/run-receipt-service.ts`, with its concerns in
  `src/main/chat/run-receipt/`: Git facts, checks, cache, base.
- **Channel.** `receipt:read` (`src/lib/ipc/invoke-receipt.ts`), validated in
  `src/main/ipc/validation/receipt.ts`.
- **Renderer.** `src/renderer/lib/stores/run-receipt.svelte.ts`, rendered by
  `src/renderer/lib/components/threads/RunReceipt.svelte` and its folder.

### Why it lives off the main thread

Receipt reads must never become a per-file Git storm, so one read performs:

1. one `getStatus` for the branch,
2. one bounded `log` walked only as far as the run's base,
3. one `rangeFiles` for `base..head`, and one for the working tree,
4. one bounded page of the thread's own tool messages, for the checks.

No synchronous child process is used anywhere in the receipt modules, and a test
greps them for `execFileSync`/`spawnSync`/`execSync` so a regression fails loudly.
`GitService.rangeFiles` (`src/main/git/git/git-service-ranges.ts`) is the single
bounded range read: `--name-status` and `--numstat`, both with `-z`, joined by
destination path.

### Caching and invalidation

Receipts are cached under `(projectId, scopeBucketId, baseSha, headSha)`. Entries
expire on read (ten minutes) rather than on an interval, so an idle app owns no
timer for them, and the conversation calls `refresh` when a run settles. A
repeated render of an unchanged run performs no Git work at all.

### What it refuses to invent

- No recorded base: `no-base`, with no figures. Borrowing today's HEAD would
  attribute the whole checkout to a run that may have started anywhere.
- Still running: `running`.
- Git unreadable: `error`, with the real reason.
- Bounded lists say `truncated` explicitly; they never present a cut as complete.
- Checks come only from shell tool calls that reached a terminal state, with the
  exit code the harness reported. A prose-only run has no checks.

## Tests

| Layer              | Files                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure logic         | `tests/lib/bound-scope.test.ts`, `tests/lib/run-receipt.test.ts`, `tests/lib/run-receipt-checks.test.ts`                                                                                                                                                                    |
| Main / persistence | `tests/main/thread-bound-scope.test.ts`, `tests/main/run-park-on-scope-health.test.ts`, `tests/main/run-receipt-service.test.ts`, `tests/main/run-receipt-cache.test.ts`, `tests/main/run-receipt-base.test.ts`, `tests/main/database/thread-bound-scope-migration.test.ts` |
| Renderer           | `tests/renderer/run-receipt-*.test.ts`, `tests/renderer/thread-dispatch-badge.test.ts`, `tests/renderer/board-excludes-bound-tasks.test.ts`, `tests/renderer/assistant-row-scope.test.ts`                                                                                   |
