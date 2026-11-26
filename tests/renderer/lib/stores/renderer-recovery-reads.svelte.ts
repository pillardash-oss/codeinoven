import { flushSync } from 'svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'

/**
 * Count how often one thread's stored draft is re-read by a reactive reader.
 *
 * Every composer draft lives in one `$state` record shared by the whole app, so
 * a write that replaces the record invalidates every reader: the sidebar's draft
 * scan, each mounted row, and the composer of every open thread. A keystroke in
 * one draft must wake only that draft's readers, and this watcher is the
 * measurement of it.
 *
 * Lives in a `.svelte.ts` module because `$effect` is compiled, not imported.
 */
export interface DraftReads {
  /** How many times the watched thread's draft has been read so far. */
  runs(): number
  stop(): void
}

export function watchThreadDraft(projectId: string, threadId: string): DraftReads {
  let runs = 0
  const stop = $effect.root(() => {
    $effect(() => {
      rendererRecovery.draftFor(projectId, threadId)
      runs += 1
    })
  })
  flushSync()
  return { runs: () => runs, stop }
}

/**
 * Count how often the set of threads holding a draft is recomputed.
 *
 * `listDraftThreadRefs` walks the record's keys, which is a different read from
 * reading one entry: it has to keep updating when a draft appears or empties,
 * which is why the record's own version still moves for those writes.
 */
export function watchDraftThreadRefs(): DraftReads {
  let runs = 0
  const stop = $effect.root(() => {
    $effect(() => {
      rendererRecovery.listDraftThreadRefs()
      runs += 1
    })
  })
  flushSync()
  return { runs: () => runs, stop }
}
