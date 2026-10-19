import { loadPanelModule, PANEL_KEYS } from './lazy-panel'

/**
 * Global app-panel chunk warmers.
 *
 * The app's global panels   notifications and sticky notes   are dynamic
 * imports behind `{#await import(...)}` in `AppPanelHost.svelte`, so the first
 * open of one pays its chunk fetch and module evaluation before it can paint.
 * In a packaged build that is one file read; in a dev build it is a transform
 * round trip, and it is the whole of the delay the user sees between clicking
 * the notification bell and seeing the panel, which reads as a blank panel that
 * "did not load" the first time.
 *
 * The context sidebar's panels warm through `sidebar-panel-preload.ts`, but the
 * global panels are reached only from the rail's own tab strip   there is no
 * hover in front of the click   so nothing warms them and their first open is
 * always cold. The panels are certain to be opened in any session, so the app
 * warms each chunk once, after the first paint and while the renderer is idle,
 * instead of leaving the first open to fetch its module on the click.
 *
 * A warm goes through `loadPanelModule`, where the rendering `{#await}` reaches
 * the same memoized promise by the same key, so a panel the warm already fetched
 * renders instantly and a fetch that failed is retried here rather than
 * surfacing blank from the panel.
 *
 * Only chunks are warmed here. A panel's data is the panel's own business: the
 * notification panel still builds its entries from the stores it reads when it
 * mounts, because a warm-up must never be able to show the user stale content.
 */

/** Warm the notification panel's module chunk so its first open is instant. */
export function preloadNotificationPanelChunk(): Promise<unknown> {
  return loadPanelModule(PANEL_KEYS.notifications, () =>
    import('$lib/components/notifications/NotificationPanel.svelte')
  )
}

/** Warm the sticky-notes panel's module chunk so its first open is instant. */
export function preloadStickyNotesPanelChunk(): Promise<unknown> {
  return loadPanelModule(PANEL_KEYS.stickyNotes, () =>
    import('$lib/components/notes/StickyNotesPanel.svelte')
  )
}

/**
 * Warm every global app panel. Idempotent: every warmer memoizes its load, so a
 * second call costs nothing and a chunk that failed to load once is retried on
 * the next call.
 *
 * Failures are swallowed here: a warm-up is an optimisation, and a chunk that
 * cannot be fetched must surface from the panel that actually opens, not from a
 * background task whose rejection would land in the renderer's error panel
 * before the user ever asked for that panel.
 *
 * The warms run one after another rather than all at once. In a packaged build
 * each is one file read, but in a dev build each is a transform round trip on a
 * server already serving the initial module graph, and concurrent requests would
 * land on it as a burst the moment the renderer goes idle. Chaining them keeps
 * the warm-up off the critical path on a slow machine as much as on a fast one.
 */
export function warmAppPanels(): void {
  void warmSequentially([preloadNotificationPanelChunk, preloadStickyNotesPanelChunk])
}

/** Await one warmer at a time; a warmer that fails never stops the next one. */
async function warmSequentially(warmers: Array<() => Promise<unknown>>): Promise<void> {
  for (const warm of warmers) {
    await warm().catch(() => undefined)
  }
}
