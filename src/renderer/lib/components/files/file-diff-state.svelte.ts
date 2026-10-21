import type { DiffDetails } from './file-diff'
import { diffDetailsAsync, type DiffWorkerInput } from './file-diff-async'

/** Owns a cancellable worker request for a reactive preview. */
export class FileDiffState {
  details = $state.raw<DiffDetails | null>(null)
  error = $state('')

  constructor(source: () => DiffWorkerInput | null) {
    $effect(() => {
      const input = source()
      const abort = new AbortController()
      this.details = null
      this.error = ''
      if (input) {
        void diffDetailsAsync(input, abort.signal).then(
          (details) => {
            if (!abort.signal.aborted) this.details = details
          },
          (reason: unknown) => {
            if (!abort.signal.aborted) {
              this.error = reason instanceof Error ? reason.message : 'Diff preview failed.'
            }
          }
        )
      }
      return () => abort.abort()
    })
  }
}
