/**
 * Presentation and contract for the app-owned scope and Git-worktree utility
 * (`cio:scope`, `src/lib/utility-ids.ts`).
 *
 * The capability is deliberately **not** a tool in any harness's tool list, and
 * no surface injects its contract: a session that never involves a worktree
 * must not pay for the schema, and most sessions never want one. It is an
 * ordinary app-owned utility instead, so an agent reaches it exactly the way it
 * reaches `cio:cua-driver` or `cio:browser`: search the gateway, activate the
 * result, then invoke it. The contract below enters context at activation and
 * nowhere else, and only because the turn asked for the work.
 *
 * Every transport (the per-turn MCP gateway, Codex `dynamicTools`, the
 * generated Pi extension, the application tool catalog) derives its tool list
 * from `GATEWAY_TOOLS`, so keeping the capability out of that catalog is what
 * keeps it out of all of them.
 */

/** Display name shown in a search result, the Utilities UI and the thread bank. */
export const SCOPE_CAPABILITY_NAME = 'Scope and Git-worktree management'
/** Search query advertised in the turn instructions, so no surface hardcodes a term. */
export const SCOPE_CAPABILITY_SEARCH_QUERY = 'worktree'
/**
 * Registry description: the search result and bank summary. States the
 * explicit-ask rule in the first sentence an agent can see, before it has
 * activated anything.
 */
export const SCOPE_CAPABILITY_SUMMARY =
  'Create and manage app-owned Git worktree scopes for the active project: fork an isolated checkout for a feature, list and inspect scopes, sync a worktree with the project main branch in either direction, read and finish conflicts, repair, adopt, archive, rename, and (with confirmation) detach or delete. Every checkout it creates appears on the scope board with its branch, health and threads, and the calling thread can move into it. Use it only when the user explicitly asks to work in a separate worktree, never on your own initiative. Never run raw `git worktree add`: a raw worktree stays invisible to the app.'

/**
 * The capability contract, returned by activation and by the post-compaction
 * docs lookup. This is the only place an agent reads how to drive the
 * capability, so it must be complete: every action, every field it accepts, and
 * the rules that are not negotiable.
 */
export const SCOPE_CAPABILITY_DOCS = `Scope and Git-worktree management for the active project.

Call it through the gateway invoke tool: utility_id "cio:scope", operation = one of the actions below, input = that action's fields.

Only create a worktree when the user explicitly asked you to work in a separate one. Never create one on your own initiative, and never run \`git worktree add\`: a raw worktree is invisible to the app (no scope-board entry, no health check, no environment or setup handling, no sync or lifecycle tooling), so the user cannot see or manage it.

Fields every action accepts:
- scope: target scope by id or display name. Omit to target the scope the calling thread is in.
- confirm: destructive actions only (see below).

Read actions:
- list, status, conflicts, source_info, detect_adoptable (sourcePath).

Write actions:
- create: title, baseBranch?, runSetup?, environmentMode? (copy|symlink), setupCommands? ([{executable, args}]), attachThread?. Forks the project checkout's current branch unless baseBranch names another, follows the project's worktree defaults, and moves this thread into the new scope unless attachThread is false.
- rename (name), pin, unpin, archive, restore.
- adopt (sourcePath, runSetup?): adopt an existing Git worktree checkout as a managed scope.
- repair, retry_setup: fix an unhealthy checkout, or re-run its setup commands.
- sync_from_main, sync_to_main (strategy: merge|rebase|ff-only).

Destructive actions, which challenge before they act:
- detach_worktree: unregister the checkout and keep the scope.
- delete_scope (deleteBranch?, threads: move-to-default|delete).
- merge_into_project (target?, mode: merge-keep|merge-delete|merge-move-to-default).

Without confirm true nothing is destroyed: the call returns the preflight plus an explicit challenge. Call again with confirm true only when the user really asked for that exact action. On an auto-review thread the app also asks the user to approve, and live processes in the target scope refuse outright.`
