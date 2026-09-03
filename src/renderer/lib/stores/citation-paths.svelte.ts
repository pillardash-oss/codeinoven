import { invoke } from '$lib/ipc.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { isAbsoluteCitationPath } from '$lib/agent-source-citations'
import { INBOX_PROJECT_ID } from '$shared/types'

/**
 * Shared, reactive cache of file citations confirmed to exist on disk.
 *
 * File citations only become clickable links when the cited path resolves to a
 * real file inside the active project. The renderer cannot stat the filesystem
 * synchronously, so MarkdownView registers candidate paths here and the store
 * batch-checks them against main. Every successful resolution bumps a reactive
 * version, so `$derived` markdown re-lexes and the link appears only then.
 *
 * Absolute paths (e.g. Codex `:codex-file-citation` tokens) are probed for
 * existence independently of the project root; they only ever become links and
 * clicks are still constrained to the main process's approved scopes.
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
  private readonly inflight = new Map<
    string,
    Promise<void>
  >() /** Absolute paths outside the project root confirmed to exist on disk. */
  private readonly externalKnown = new Set<string>()
  private readonly externalChecked = new Set<string>()
  private readonly externalPending = new Set<string>()
  private externalInflight: Promise<void> | null = null
  /** Reactive version — bumped whenever a resolution changes the known set. */
  private refreshKey = $state(0)

  /** Reactive revision of the resolved-citation state. Callers whose memoized
   *  output depends on `isValidPath`/`isKnownExternalPath` must read this in
   *  their reactive context AND fold it into their cache key — otherwise a
   *  memo hit after a resolution bump returns stale, un-linkified output
   *  forever (the linkify-after-mount bug). */
  get revision(): number {
    return this.refreshKey
  }

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
    const cacheKey = `${projectId}:${workspaceState.activeScopeBucketIdFor(projectId)}`
    return this.cacheFor(cacheKey).known.has(path)
  }

  /** Whether an absolute path (outside the project root) exists on disk. */
  isKnownExternalPath(path: string): boolean {
    void this.refreshKey
    return this.externalKnown.has(path)
  }

  /** Queue existence checks for candidate paths in the active project. Absolute
   *  candidates are probed externally; everything else resolves inside the
   *  project root — or the active scope's worktree root when the open thread
   *  belongs to a managed scope. */
  ensureActiveProjectChecked(candidates: string[]): void {
    const project = workspaceState.activeProject
    if (
      !project ||
      project.id === INBOX_PROJECT_ID ||
      project.source !== 'local' ||
      !project.path.trim() ||
      candidates.length === 0
    ) {
      return
    }
    const external: string[] = []
    const projectCandidates: string[] = []
    for (const candidate of candidates) {
      if (isAbsoluteCitationPath(candidate)) external.push(candidate)
      else projectCandidates.push(candidate)
    }
    if (projectCandidates.length > 0) {
      this.ensureChecked(
        project.id,
        projectCandidates,
        workspaceState.activeScopeBucketIdFor(project.id)
      )
    }
    if (external.length > 0) this.ensureExternalChecked(external)
  }

  /**
   * Queue existence checks, deduplicating candidates already resolved and
   * coalescing bursts (e.g. every MarkdownView mounting at once) into one
   * inflight drain per project.
   */
  ensureChecked(projectId: string, candidates: string[], scopeBucketId?: string): void {
    if (projectId === INBOX_PROJECT_ID) return
    const cacheKey = `${projectId}:${scopeBucketId ?? ''}`
    const cache = this.cacheFor(cacheKey)
    for (const candidate of candidates) {
      if (candidate.length === 0 || cache.checked.has(candidate)) continue
      cache.checked.add(candidate)
      cache.pending.add(candidate)
    }
    if (cache.pending.size === 0 || this.inflight.has(cacheKey)) return

    const drain = this.drain(projectId, scopeBucketId, cache)
    this.inflight.set(cacheKey, drain)
    void drain.finally(() => {
      if (this.inflight.get(cacheKey) === drain) this.inflight.delete(cacheKey)
    })
  }

  private async drain(
    projectId: string,
    scopeBucketId: string | undefined,
    cache: CitationPathsCache
  ): Promise<void> {
    while (cache.pending.size > 0) {
      const batch = [...cache.pending]
      cache.pending.clear()
      try {
        const resolved = await invoke(
          'projectFiles:resolveCitationPaths',
          projectId,
          batch,
          scopeBucketId
        )
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

  private ensureExternalChecked(candidates: string[]): void {
    for (const candidate of candidates) {
      if (candidate.length === 0 || this.externalChecked.has(candidate)) continue
      this.externalChecked.add(candidate)
      this.externalPending.add(candidate)
    }
    if (this.externalPending.size === 0 || this.externalInflight) return

    const drain = this.drainExternal()
    this.externalInflight = drain
    void drain.finally(() => {
      this.externalInflight = null
    })
  }

  private async drainExternal(): Promise<void> {
    while (this.externalPending.size > 0) {
      const batch = [...this.externalPending]
      this.externalPending.clear()
      try {
        const resolved = await invoke('projectFiles:resolveExternalCitationPaths', batch)
        let changed = false
        for (const [candidate, exists] of Object.entries(resolved)) {
          if (exists) {
            this.externalKnown.add(candidate)
            changed = true
          }
        }
        if (changed) this.refreshKey++
      } catch {
        // Unresolvable external citations simply never become links.
      }
    }
  }
}

export const citationPathsState = new CitationPathsState()
