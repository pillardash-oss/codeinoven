import { loadPanelModule, PANEL_KEYS } from './lazy-panel'

/**
 * Sidebar-panel chunk warmers.
 *
 * The context sidebar's panels are dynamic imports   the Git panel, the project
 * file tree, the diff panel, the browser panel and the terminal each render
 * behind an `{#await import(...)}`   so the very first open of one pays the
 * chunk fetch and module evaluation before it can paint. In a packaged build
 * that is one file read; in a dev build it is a transform round trip, and it is
 * the whole of the delay the user sees between clicking the panel and seeing
 * it.
 *
 * Unlike the page chunks in `page-preload.ts`, these panels are not fetched on
 * hover: the Git chip warms on hover, but the rail's own tab strip, the
 * keymap's "open terminal" chords and a restored session all reach a panel with
 * no pointer event in front of it. The panels are certain to be opened in any
 * session, so the app warms every one of them once, after the first paint and
 * while the renderer is idle, instead of leaving each first open cold.
 *
 * A warm goes through `loadPanelModule`, where the rendering `{#await}` reaches
 * the same memoized promise by the same key. That is what makes the warm pay off
 * twice: the panel renders from an already-resolved promise, and a chunk that
 * failed to fetch is retried here rather than surfacing blank from the panel.
 *
 * Only chunks are warmed here. A panel's data is the panel's own business: the
 * Git panel still asks the repository what it is when it mounts, because a
 * warm-up must never be able to show the user a stale working tree.
 */

/** Warm the Git panel's module chunk so opening it is instant. */
export function preloadGitPanelChunk(): Promise<unknown> {
  return loadPanelModule(PANEL_KEYS.gitStatus, () =>
    import('$lib/components/git/GitStatusPanel.svelte')
  )
}

/** Warm the project file tree's module chunk so opening it is instant. */
export function preloadFilesPanelChunk(): Promise<unknown> {
  return loadPanelModule(PANEL_KEYS.projectFiles, () =>
    import('$lib/components/files/ProjectFilesPanel.svelte')
  )
}

/** Warm the diff panel's module chunk so opening it is instant. */
export function preloadDiffPanelChunk(): Promise<unknown> {
  return loadPanelModule(PANEL_KEYS.diffSidebar, () =>
    import('$lib/components/files/DiffSidebarPanel.svelte')
  )
}

/** Warm the terminal panel's module chunk so opening a shell is instant. */
export function preloadTerminalPanelChunk(): Promise<unknown> {
  return loadPanelModule(PANEL_KEYS.terminal, () =>
    import('$lib/components/terminal/TerminalPanel.svelte')
  )
}

/**
 * Warm every panel the context sidebar can show. Idempotent: every warmer
 * memoizes its load, so a second call costs nothing and a chunk that failed to
 * load once is retried on the next call.
 *
 * Failures are swallowed here: a warm-up is an optimisation, and a chunk that
 * cannot be fetched must surface from the panel that actually opens, not from a
 * background task whose rejection would land in the renderer's error panel
 * before the user ever asked for that panel.
 *
 * The warms run one after another rather than all at once. In a packaged build
 * each is one file read, but in a dev build each is a transform round trip on a
 * server already serving the initial module graph, and four concurrent requests
 * would land on it as a burst the moment the renderer goes idle. Chaining them
 * keeps the warm-up off the critical path on a slow machine as much as on a
 * fast one.
 */
export function warmSidebarPanels(): void {
  void warmSequentially([
    preloadGitPanelChunk,
    preloadFilesPanelChunk,
    preloadDiffPanelChunk,
    preloadTerminalPanelChunk
  ])
}

/** Await one warmer at a time; a warmer that fails never stops the next one. */
async function warmSequentially(warmers: Array<() => Promise<unknown>>): Promise<void> {
  for (const warm of warmers) {
    await warm().catch(() => undefined)
  }
}
