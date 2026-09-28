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
 * Warm every browser surface's module chunk so opening the browser is instant.
 *
 * The browser is not in the first-paint chunk, so each of its surfaces is a
 * dynamic import: the view itself, the app header's centre, the switcher's
 * browser row, the workspace's fullscreen browser and its browser menus, and the
 * sidebar's browser panel. They are all warmed together, because reaching for the
 * browser reaches for more than one of them in the same interaction - clicking a
 * tab in the sidebar opens the panel and moves the header centre at once.
 *
 * Only chunks are warmed here. The browser's stores are wired by `loadBrowser`,
 * because a chunk is not a surface: loading a module must not subscribe the
 * renderer to browser state on its own. `loadBrowser` calls this, so a caller only
 * ever has to ask for the browser once.
 */
export function preloadBrowserChunk(): void {
  browserChunkPromise ??= Promise.all([
    import('$lib/components/browser/BrowserView.svelte'),
    import('$lib/components/browser/BrowserPanel.svelte'),
    import('$lib/components/layout/AppHeaderBrowserCenter.svelte'),
    import('$lib/components/threads/SwitcherBrowserRow.svelte'),
    import('$lib/components/workspace/WorkspaceFullscreenBrowser.svelte'),
    import('$lib/components/workspace/WorkspaceBrowserMenu.svelte'),
    import('$lib/components/workspace/WorkspaceBrowserDataModal.svelte'),
    import('$lib/components/workspace/WorkspaceBrowserDownloadsModal.svelte')
  ]).catch((error: unknown) => {
    // Reset so a transient failure can be retried on the next reach.
    browserChunkPromise = null
    throw error
  })
}
