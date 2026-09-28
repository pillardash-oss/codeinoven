/**
 * Page-chunk preload warmers.
 *
 * Settings and Scope are lazy-loaded chunks (`{#await import(...)}` in
 * App.svelte), so the very first open pays the chunk fetch + module eval.
 * Firing the import on hover   while the mouse is still over the entry
 * button   makes the subsequent click resolve instantly, because the module
 * registry already holds the chunk. Re-invocations are no-ops.
 */

let settingsChunkPromise: Promise<unknown> | null = null
let scopeChunkPromise: Promise<unknown> | null = null
let browserChunkPromise: Promise<unknown> | null = null

/** Warm the SettingsView module chunk so opening Settings is instant. */
export function preloadSettingsChunk(): void {
  settingsChunkPromise ??= import('$lib/components/settings/SettingsView.svelte').catch((error) => {
    // Reset so a transient failure can be retried on the next hover.
    settingsChunkPromise = null
    throw error
  })
}

/** Warm the ScopeView module chunk so opening the scope board is instant. */
export function preloadScopeChunk(): void {
  scopeChunkPromise ??= import('$lib/components/scope/ScopeView.svelte').catch((error) => {
    scopeChunkPromise = null
    throw error
  })
}

/**
 * Warm the BrowserView module chunk so opening the browser is instant.
 *
 * Only the chunk is warmed here. The browser's stores are wired by
 * `startBrowserRuntime`, which the caller fires alongside this, because a chunk
 * is not a surface: loading the module must not subscribe the renderer to browser
 * state on its own.
 */
export function preloadBrowserChunk(): void {
  browserChunkPromise ??= import('$lib/components/browser/BrowserView.svelte').catch((error) => {
    browserChunkPromise = null
    throw error
  })
}
