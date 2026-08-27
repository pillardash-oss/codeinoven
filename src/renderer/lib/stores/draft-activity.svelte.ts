import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'

/**
 * Global composer-draft activity pub/sub.
 *
 * Surfaces subscribe to know when any thread enters or leaves the draft state,
 * and every transition is forwarded to the main process so the turn-grading
 * timers can pause while the user is composing. Publishing is edge-triggered
 * (only empty ↔ non-empty toggles notify) so keystrokes stay local.
 */

type DraftActivityListener = (
  projectId: string,
  threadId: string,
  drafting: boolean
) => void

const listeners = new SvelteSet<DraftActivityListener>()

/** Last state forwarded to main per thread, so toggles are only sent once. */
const forwardedDrafting = new SvelteMap<string, boolean>()

/** Subscribe to draft activity transitions across every thread. */
export function onDraftActivity(listener: DraftActivityListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Publish a thread's current drafted-content state. */
export function publishDraftActivity(
  projectId: string,
  threadId: string,
  drafting: boolean
): void {
  for (const listener of listeners) listener(projectId, threadId, drafting)
  const key = `${projectId}:${threadId}`
  if (forwardedDrafting.get(key) === drafting) return
  forwardedDrafting.set(key, drafting)
  void invoke('thread:draftActivity', projectId, threadId, drafting).catch(() => {
    forwardedDrafting.set(key, !drafting)
  })
}
