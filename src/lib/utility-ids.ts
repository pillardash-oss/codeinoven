/**
 * Stable app-owned utility ids.
 *
 * These are plain string constants with no Node dependency, so they can be
 * imported from browser-bound renderer code (e.g. the agent-behavior prompt
 * copy) and from main-process utilities alike. Keep this module free of any
 * Node-only import   renderer bundles must stay clear of `fs`/`path`/`crypto`.
 */

/** Stable id of the browser control utility backed by the in-app browser. */
export const APP_BROWSER_UTILITY_ID = 'cio:browser'

/** Stable id of the Cua Driver computer-use MCP utility. */
export const APP_CUA_DRIVER_UTILITY_ID = 'cio:cua-driver'

/** Stable id of the app-owned scope and Git-worktree management utility. */
export const APP_SCOPE_UTILITY_ID = 'cio:scope'

/**
 * Stable id of the app-owned Android target control utility, backed by adb.
 * Named `adb` rather than `device` on purpose: `device` already means a paired
 * phone running the CodeInOven PWA (see `remote_devices` and
 * `src/renderer/lib/remote/device-identity.ts`).
 */
export const APP_ADB_UTILITY_ID = 'cio:adb'
