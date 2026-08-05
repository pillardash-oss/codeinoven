import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'

/**
 * Lazily resolves the git remote `origin` URL for each project and caches the
 * result so repeated lookups (thread hover popovers, composer pills) never
 * re-spawn git. A null value is cached too, so unreachable remotes are not
 * retried on every hover.
 */
class ProjectRemotes {
  remotes: SvelteMap<string, string | null> = $state(new SvelteMap())
  private pending = new Map<string, Promise<string | null>>()

  get(projectId: string): string | null | undefined {
    return this.remotes.get(projectId)
  }

  async ensure(projectId: string, projectPath: string): Promise<string | null> {
    const cached = this.remotes.get(projectId)
    if (cached !== undefined) return cached

    const inFlight = this.pending.get(projectId)
    if (inFlight) return inFlight

    const request = invoke('repository:remoteOrigin', projectPath)
      .then((url) => {
        this.remotes.set(projectId, url)
        return url
      })
      .catch(() => {
        this.remotes.set(projectId, null)
        return null
      })
    this.pending.set(projectId, request)
    try {
      return await request
    } finally {
      this.pending.delete(projectId)
    }
  }
}

export const projectRemotes = new ProjectRemotes()
