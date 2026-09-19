import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import { scopeState, type ScopeProject } from '$lib/stores/scope.svelte'
import type { Thread } from '$shared/types'

/** How long a project's thread list stays reusable across picker opens. */
const THREADS_TTL_MS = 30_000

/**
 * Picker data for the memory scope controls.
 *
 * Projects come from the app-wide scope store, which every surface already
 * loads, so opening a picker costs nothing. Threads are heavier and per
 * project, so each project's list is fetched once on demand and cached for a
 * short window instead of loading every thread in the app.
 */
class MemoryScopeOptionsState {
  threadsByProject: Map<string, Thread[]> = $state(new SvelteMap())
  loadingProjectIds: string[] = $state([])
  private fetchedAt = new Map<string, number>()
  private inflight = new Map<string, Promise<void>>()

  get projects(): ScopeProject[] {
    return scopeState.projects
  }

  threadsFor(projectId?: string): Thread[] {
    if (!projectId) return []
    return this.threadsByProject.get(projectId) ?? []
  }

  isLoading(projectId?: string): boolean {
    return projectId ? this.loadingProjectIds.includes(projectId) : false
  }

  /** Load a project's threads if they are missing or stale. Safe to spam. */
  async ensureThreads(projectId?: string): Promise<void> {
    if (!projectId) return
    const fetchedAt = this.fetchedAt.get(projectId) ?? 0
    if (this.threadsByProject.has(projectId) && Date.now() - fetchedAt < THREADS_TTL_MS) return
    const pending = this.inflight.get(projectId)
    if (pending) return pending
    const request = this.loadThreads(projectId).finally(() => this.inflight.delete(projectId))
    this.inflight.set(projectId, request)
    return request
  }

  private async loadThreads(projectId: string): Promise<void> {
    this.loadingProjectIds = [...this.loadingProjectIds, projectId]
    try {
      const threads = await invoke('thread:list', projectId)
      this.threadsByProject.set(projectId, threads)
      this.fetchedAt.set(projectId, Date.now())
    } catch {
      // A failed picker read must never blank data that already rendered.
    } finally {
      this.loadingProjectIds = this.loadingProjectIds.filter((id) => id !== projectId)
    }
  }
}

export const memoryScopeOptions = new MemoryScopeOptionsState()
