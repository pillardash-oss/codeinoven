import type { TurnCheckpointSummary } from '$shared/types'
import { summarizeChanges, type ChangeCardSummary } from './run-changes-summary'

export class RunChangesState {
  summary = $state.raw<ChangeCardSummary | null>(null)
  error = $state('')

  constructor(source: () => TurnCheckpointSummary) {
    $effect(() => {
      const checkpoint = source()
      const abort = new AbortController()
      this.summary = null
      this.error = ''
      void summarizeChanges(checkpoint, abort.signal).then(
        (summary) => {
          if (!abort.signal.aborted) this.summary = summary
        },
        (reason: unknown) => {
          if (!abort.signal.aborted)
            this.error = reason instanceof Error ? reason.message : 'Change summary failed.'
        }
      )
      return () => abort.abort()
    })
  }
}
