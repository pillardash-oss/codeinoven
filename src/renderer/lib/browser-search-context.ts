/**
 * Publishes the address bar's active search engine to the main process.
 *
 * The browser renders remote pages in a native `WebContentsView`, so the
 * right-click menu is built in main, which holds no config of its own. The
 * engine is needed there for one item   `Search <engine> for "..."`   and for
 * the URL it opens, so the resolved engine is pushed whenever the persisted
 * config loads or changes, exactly like the browser's shortcut table.
 *
 * A failure is silent: the browser's feature IPC is registered after first
 * paint, so the earliest reports can land before the handler exists. Until a
 * report arrives main uses the shipped default engine.
 */

import type { BrowserSearchEngine } from '$shared/browser-search-engines'
import { invoke } from '$lib/ipc.svelte'

/** Hand the resolved search engine to the main process. */
export function publishBrowserSearchEngine(engine: BrowserSearchEngine): void {
  void invoke('browser:setSearchEngine', engine).catch(() => {})
}
