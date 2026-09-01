import { SvelteMap } from 'svelte/reactivity'
import type { TurnCheckpointFileDiff, TurnCheckpointSummary } from '$shared/types'

/** Per-thread working state cached across sidebar remounts. */
export interface DiffPanelCache {
  checkpoints: TurnCheckpointSummary[]
  selectedCheckpointId: string | null
  fileDiffsByCheckpoint: SvelteMap<string, TurnCheckpointFileDiff[]>
}

/** The panel unmounts every time the sidebar is hidden (same as every other
 *  context-sidebar tab), which used to reset all local state — checkpoint
 *  list, selected turn, loaded diffs — back to empty, forcing a full refetch
 *  and a spinner flash on every single toggle. Module-level state survives
 *  that remount, so reopening seeds instantly from the last known data while
 *  `refresh()` still quietly re-validates in the background. Keyed by the
 *  thread identity so a parent that reuses one panel instance across threads
 *  (instead of keying it) always reads the correct thread's cache. */
const panelCache = new SvelteMap<string, DiffPanelCache>()

export function cacheKeyFor(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

export function getOrCreateCache(projectId: string, threadId: string): DiffPanelCache {
  const key = cacheKeyFor(projectId, threadId)
  let entry = panelCache.get(key)
  if (!entry) {
    entry = {
      checkpoints: [],
      selectedCheckpointId: null,
      fileDiffsByCheckpoint: new SvelteMap()
    }
    panelCache.set(key, entry)
  }
  return entry
}