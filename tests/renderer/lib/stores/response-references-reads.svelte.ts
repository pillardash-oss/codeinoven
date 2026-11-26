import { flushSync } from 'svelte'
import { responseReferencesState } from '$lib/stores/response-references.svelte'

/**
 * Count how often one thread's references are re-read by a reactive reader.
 *
 * The composer stores annotations in a `$state` record shared by every
 * conversation, so a write that replaces the whole record invalidates every
 * reader in the app — the sidebar, the header and each open composer — on every
 * keystroke of an annotation comment. This watcher is the measurement of that:
 * it reads exactly one thread's list inside an effect, and a write to another
 * thread must not wake it.
 *
 * Lives in a `.svelte.ts` module because `$effect` is compiled, not imported.
 */
export interface ReferenceReads {
  /** How many times the watched thread's list has been read so far. */
  runs(): number
  stop(): void
}

export function watchThreadReferences(projectId: string, threadId: string): ReferenceReads {
  let runs = 0
  const stop = $effect.root(() => {
    $effect(() => {
      responseReferencesState.forThread(projectId, threadId)
      runs += 1
    })
  })
  flushSync()
  return { runs: () => runs, stop }
}
