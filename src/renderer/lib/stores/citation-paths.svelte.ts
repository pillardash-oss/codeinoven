import { invoke } from '$lib/ipc.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'

/**
 * Shared, reactive cache of file citations confirmed to exist on disk.
 *
 * File citations only become clickable links when the cited path resolves to a
 * real file inside the active project. The renderer cannot stat the filesystem
 * synchronously, so MarkdownView registers candidate paths here and the store
 * batch-checks them against main. Every successful resolution bumps a reactive
 * version, so `$derived` markdown re-lexes and the link appears only then.
 */
interface CitationPathsCache {
  /** Candidate strings confirmed to resolve to an existing project entry. */
  known: Set<string>
  /** Candidate strings already sent to main (positive or negative). */
  checked: Set<string>
  /** Candidates queued for the next batch existence check. */
  pending: Set<string>
}

class CitationPathsState {
  private readonly projects = new Map<string, CitationPathsCache>()
  private readonly inflight = new Map<string, Promise<void>>()
  /** Reactive version — bumped whenever a resolution changes the known set. */
  private refreshKey = $state(0)

  private cacheFor(projectId: string): CitationPathsCache {
    let cache = this.projects.get(projectId)
    if (!cache) {
      cache = { known: new Set(), checked: new Set(), pending: new Set() }
      this.projects.set(projectId, cache)
    }
    return cache
  }

  /** Whether a normalized citation path is a real entry in the active project. */
  isValidPath(path: string): boolean {
    const projectId = workspaceState.activeProject?.id
    if (!projectId) return false
    void this.refreshKey
    return this.cacheFor(projectId).known.has(path)
  }

  /** Queue existence checks for candidate paths in the active project. */
  ensureActiveProjectChecked(candidates: string[]): void {
    const projectId = workspaceState.activeProject?.id
    if (!projectId || candidates.length === 0) return
    this.ensureChecked(projectId, candidates)
  }

  /**
   * Queue existence checks, deduplicating candidates already resolved and
   * coalescing bursts (e.g. every MarkdownView mounting at once) into one
   * inflight drain per project.
   */
  ensureChecked(projectId: string, candidates: string[]): void {
    const cache = this.cacheFor(projectId)
    for (const candidate of candidates) {
      if (candidate.length === 0 || cache.checked.has(candidate)) continue
      cache.checked.add(candidate)
      cache.pending.add(candidate)
    }
    if (cache.pending.size === 0 || this.inflight.has(projectId)) return

    const drain = this.drain(projectId, cache)
    this.inflight.set(projectId, drain)
    void drain.finally(() => {
      if (this.inflight.get(projectId) === drain) this.inflight.delete(projectId)
    })
  }

  private async drain(projectId: string, cache: CitationPathsCache): Promise<void> {
    while (cache.pending.size > 0) {
      const batch = [...cache.pending]
      cache.pending.clear()
      try {
        const resolved = await invoke('projectFiles:resolveCitationPaths', projectId, batch)
        const known = cache.known
        let changed = false
        for (const [candidate, resolvedPath] of Object.entries(resolved)) {
          if (resolvedPath) {
            known.add(candidate)
            changed = true
          }
        }
        if (changed) this.refreshKey++
      } catch {
        // Unresolvable citations simply never become links.
      }
    }
  }
}

export const citationPathsState = new CitationPathsState()
