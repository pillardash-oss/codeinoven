/**
 * Lazy loader for the ghostty-web terminal library.
 *
 * `ghostty-web` is a ~670 KB (raw) / ~195 KB (gzip) VT parser + canvas renderer
 * that every terminal surface in the app shares: the Actions run terminal, the
 * context-sidebar shell, and the provider login terminal. All three are
 * reachable from the app shell, so a plain `import ... from 'ghostty-web'`
 * anywhere in that graph pulled the entire library into the eagerly-loaded
 * closure   every launch paid for a terminal most sessions never open.
 *
 * The library is therefore loaded on demand, the first time a terminal is
 * actually created, and the module namespace is cached so later terminals reuse
 * the same copy (a second copy would also mean a second wasm instance and
 * separate `SelectionManager` prototype patching).
 */

/** The ghostty-web module namespace. */
type GhosttyWebModule = typeof import('ghostty-web')

let modulePromise: Promise<GhosttyWebModule> | null = null

/** Load (once) and return the ghostty-web module namespace. */
export function loadGhosttyWeb(): Promise<GhosttyWebModule> {
  modulePromise ??= import('ghostty-web').catch((error: unknown) => {
    // Drop the rejected promise so a transient chunk-fetch failure (for example
    // a rebuild that invalidated the hash while the panel was open) can retry
    // on the next terminal instead of poisoning every later attempt.
    modulePromise = null
    throw error
  })
  return modulePromise
}
