/**
 * Publishes the "let websites override application keymaps" choice to main.
 *
 * The choice is read in the main process, which is the only side that sees a key
 * pressed in a page before the application menu does. Main holds no config of its
 * own, so the value is pushed whenever the persisted config loads or changes,
 * exactly like the browser's shortcut table and its active search engine.
 *
 * A failure is silent: the browser's feature IPC is registered after first paint,
 * so the earliest reports can land before the handler exists. Until a report
 * arrives main keeps the default, which is the on state.
 */

import { invoke } from '$lib/ipc.svelte'

/** Hand the page-override choice to the main process. */
export function publishBrowserAllowSiteKeymapOverride(allows: boolean): void {
  void invoke('browser:setSiteKeymapOverride', allows).catch(() => {})
}
