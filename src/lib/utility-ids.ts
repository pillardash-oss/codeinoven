/**
 * Stable app-owned utility ids.
 *
 * These are plain string constants with no Node dependency, so they can be
 * imported from browser-bound renderer code (e.g. the agent-behavior prompt
 * copy) and from main-process utilities alike. Keep this module free of any
 * Node-only import   renderer bundles must stay clear of `fs`/`path`/`crypto`.
 */

/**
 * Prefix of the synthetic, turn-scoped utility that exposes the app-owned
 * gateway to a harness. The full id carries the thread id, so a transport can
 * recognise the gateway (and treat its calls as human-paced) without matching a
 * name a user could also choose.
 */
export const GATEWAY_UTILITY_ID_PREFIX = 'cio:utility-gateway:'

/** Stable id of the browser control utility backed by the in-app browser. */
export const APP_BROWSER_UTILITY_ID = 'cio:browser'

/** Stable id of the Cua Driver computer-use MCP utility. */
export const APP_CUA_DRIVER_UTILITY_ID = 'cio:cua-driver'

/** Stable id of the app-owned scope and Git-worktree management utility. */
export const APP_SCOPE_UTILITY_ID = 'cio:scope'

/**
 * Stable id of the app-owned Android device skill, a playbook an agent applies
 * with its own shell rather than a tool the app executes. Named `adb` rather
 * than `device` on purpose, because a device in the app's own vocabulary means
 * an attached Android device, not an app role.
 */
export const APP_ADB_UTILITY_ID = 'cio:adb'

/**
 * App-owned knowledge a user may switch off.
 *
 * `cio:adb` is advice: an agent applies that playbook with its own shell, so a
 * user who already has a better runbook for Android must be able to stop ours
 * competing with it in every turn.
 *
 * Everything else the app owns stays locked, because the app supplies the
 * wiring behind it and a turn that lost it would fail in a way the user cannot
 * explain. `cio:scope` is the case to keep in mind: its kind is `skill`, but it
 * is executed, and the Git panel's review flow
 * (`src/renderer/lib/components/git/git-status-panel-prompts.ts`) tells an agent
 * to activate it by id, so switching it off breaks a shipped path rather than
 * freeing one. New app-owned entries are locked by default and join this list
 * only on purpose.
 */
const DISABLEABLE_APP_OWNED_UTILITY_IDS: ReadonlySet<string> = new Set([APP_ADB_UTILITY_ID])

/**
 * Whether a utility's `enabled` flag may be toggled, from the Utilities page or
 * anywhere else. Anything the user installed is theirs to switch off; an
 * app-owned entry is locked unless it is listed as disableable above.
 */
export function canToggleUtilityEnabled(utility: { id: string; appOwned: boolean }): boolean {
  return !utility.appOwned || DISABLEABLE_APP_OWNED_UTILITY_IDS.has(utility.id)
}
