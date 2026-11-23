import { invoke } from '$lib/ipc.svelte'
import type { ProjectEnvFile } from '$shared/project-env'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'

/**
 * Which paths already hold stored env keys.
 *
 * The env panel is the only place a value is ever read, and what it reads is a
 * manifest: a file, its key names and a reference per name, never a value. This
 * store keeps that manifest so the explorer's Secrets button can answer "there are
 * keys here" without opening anything.
 *
 * The panel publishes the manifest it just read back into this map, so a key added
 * on the open panel lights the button immediately instead of only on a remount.
 */
class ProjectSecretsPresence {
  /** Manifests per project, keyed by project id. */
  private manifests = new SvelteMap<string, ProjectEnvFile[]>()
  /** Projects whose manifest has been read in this window. */
  private readProjects = new SvelteSet<string>()
  /** Projects with a read in flight, so two mounts share one call. */
  private reading = new SvelteSet<string>()

  /**
   * Read a project's manifest once per window.
   *
   * A manifest that cannot be read leaves the button exactly as it was: the dot is
   * an orientation cue, not a state the reader acts on, so a failed read must not
   * become an error on a tree that is otherwise fine.
   */
  async ensure(projectId: string): Promise<void> {
    if (!projectId || this.readProjects.has(projectId) || this.reading.has(projectId)) return
    this.reading.add(projectId)
    try {
      this.publish(projectId, await invoke('secrets:envList', projectId))
    } catch {
      // Nothing to report: the env panel itself is where a read failure is shown.
    } finally {
      this.reading.delete(projectId)
    }
  }

  /** Take a manifest a caller already holds, keeping the dot in step with an edit. */
  publish(projectId: string, files: readonly ProjectEnvFile[]): void {
    if (!projectId) return
    this.manifests.set(projectId, [...files])
    this.readProjects.add(projectId)
  }

  /**
   * Whether the group the Secrets button would edit holds a key.
   *
   * The project root answers for the whole project, because the root is where the
   * panel opens for someone who has not walked to a subfolder yet; a subfolder
   * answers only for its own files.
   */
  hasKeys(projectId: string, group: string): boolean {
    const files = this.manifests.get(projectId)
    if (!files) return false
    return files.some((file) => file.entries.length > 0 && (group === '' || file.group === group))
  }
}

export const projectSecretsPresence = new ProjectSecretsPresence()
