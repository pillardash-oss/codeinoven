/**
 * Stable app-owned utility ids.
 *
 * These are plain string constants with no Node dependency, so they can be
 * imported from browser-bound renderer code (e.g. the agent-behavior prompt
 * copy) and from main-process utilities alike. Keep this module free of any
 * Node-only import — renderer bundles must stay clear of `fs`/`path`/`crypto`.
 */

/** Stable id of the browser control utility backed by the in-app browser. */
export const APP_BROWSER_UTILITY_ID = 'cio:browser'

/** Stable id of the Cua Driver computer-use MCP utility. */
export const APP_CUA_DRIVER_UTILITY_ID = 'cio:cua-driver'
