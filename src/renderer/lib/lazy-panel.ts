/**
 * Resilient, memoized loader for the app's lazily imported panels.
 *
 * Every global and context-sidebar panel is rendered behind
 * `{#await import('...')}`: the very first open pays the chunk fetch and module
 * evaluation before it can paint. Measuring that delay is not the whole problem,
 * though: when the fetch *fails* (a dev server that is restarting refuses the
 * connection, an HMR-invalidated `?t=` URL the server no longer serves, a device
 * that dropped a chunk read) the bare `{#await}` has no pending and no catch
 * branch, so Svelte renders nothing. The panel then comes out **blank and stays
 * blank** until its host remounts, which is exactly the "first time I opened it,
 * it was blank" report.
 *
 * Two things keep that from happening:
 *
 * - the load is memoized by key, so the boot warm (see `sidebar-panel-preload`
 *   and `app-panel-preload`) and the rendering `{#await}` share one promise. A
 *   panel whose chunk the warm already fetched renders from an already-resolved
 *   promise instead of starting a second fetch.
 * - a load retries a bounded number of times before it is reported, because the
 *   failures above are transient by nature. A load that still fails is not cached
 *   as a permanent failure, so the next render (or `resetPanelModule` behind a
 *   Retry) fetches again instead of replaying the rejection forever.
 *
 * Only module chunks are handled here. A panel's data stays the panel's own
 * business.
 */

/**
 * The panel keys shared by every warmer and every rendering `{#await}`.
 *
 * The key is what makes a warm and a render the same load; a key held only in
 * one of the two places would memoize nothing and the panel would fetch twice.
 */
export const PANEL_KEYS = {
  notifications: 'panel:notifications',
  stickyNotes: 'panel:sticky-notes',
  gitStatus: 'panel:git-status',
  projectFiles: 'panel:project-files',
  diffSidebar: 'panel:diff-sidebar',
  terminal: 'panel:terminal',
  oven: 'panel:oven',
  actions: 'panel:actions',
  browser: 'panel:browser',
  debugger: 'panel:debugger',
  sources: 'panel:sources',
  cloudDeployment: 'panel:cloud-deployment',
  temporaryChat: 'panel:temporary-chat',
  assistantKnowledge: 'panel:assistant-knowledge',
  assignmentCoordinator: 'panel:assignment-coordinator',
  achievementCoordinator: 'panel:achievement-coordinator',
  designCoordinator: 'panel:design-coordinator',
  independentAuditCoordinator: 'panel:independent-audit-coordinator',
  memory: 'panel:memory',
  threadNote: 'panel:thread-note',
  attention: 'panel:attention',
  subagent: 'panel:subagent'
} as const

export type PanelKey = (typeof PANEL_KEYS)[keyof typeof PANEL_KEYS]

/**
 * Delay before each retry. The first attempt is immediate; a failure is usually
 * a dev server mid-restart, which a short wait outlasts.
 */
const RETRY_DELAYS_MS: readonly number[] = [200, 600]

const loads = new Map<string, Promise<{ default: unknown }>>()

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Run one loader, retrying a transient failure up to the backoff schedule. */
async function loadWithRetry<T>(load: () => Promise<{ default: T }>): Promise<{ default: T }> {
  // One attempt plus one per configured backoff gap.
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await load()
    } catch (error) {
      const gap = RETRY_DELAYS_MS[attempt]
      if (gap === undefined) throw error
      await delay(gap)
    }
  }
  // Unreachable: the loop either returns or throws on its final attempt.
  throw new Error('unreachable')
}

/**
 * Load one panel module, memoized by key and retried on a transient failure.
 *
 * The returned promise is stable for a key until the load settles successfully
 * or `resetPanelModule` drops it, which is what lets a rendering `{#await}`
 * re-evaluate its expression without restarting the fetch on every update.
 */
export function loadPanelModule<T>(
  key: string,
  load: () => Promise<{ default: T }>
): Promise<{ default: T }> {
  const cached = loads.get(key)
  if (cached) return cached as Promise<{ default: T }>

  const promise = loadWithRetry(load)
  const entry: Promise<{ default: unknown }> = promise
  loads.set(key, entry)
  void entry.catch(() => {
    // A load that exhausted its retries must not be cached as a permanent
    // failure: drop it so the next render, or an explicit retry, fetches again.
    if (loads.get(key) === entry) loads.delete(key)
  })
  return promise
}

/**
 * Forget a memoized load so the next `loadPanelModule` fetches again. This is
 * what a "Retry" action calls before it forces its `{#await}` to re-run.
 */
export function resetPanelModule(key: string): void {
  loads.delete(key)
}
