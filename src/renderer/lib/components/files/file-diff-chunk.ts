/**
 * The diff viewer's chunk.
 *
 * `FileDiffView` and the row renderer behind it are the heaviest thing a file
 * panel can show, and every surface that can show a diff (project files, the
 * git changes tree and the hover popover) is mounted on the first screen. A
 * static import therefore put the whole renderer in the initial closure, where
 * the launch paid ~93 KB raw / ~31 KB gzip for a diff nobody had opened yet.
 *
 * The loader is memoized so the panels that mount together share one fetch, and
 * a chunk that failed to load is forgotten rather than cached as a permanent
 * failure.
 */

type FileDiffViewModule = typeof import('./FileDiffView.svelte')

let pending: Promise<FileDiffViewModule> | null = null

/** Load the diff renderer, fetching it at most once. */
export function loadFileDiffView(): Promise<FileDiffViewModule> {
  pending ??= import('./FileDiffView.svelte').catch((error: unknown) => {
    pending = null
    throw error
  })
  return pending
}
