import type { PromptReference } from '$shared/types'
import { rendererRecovery } from './renderer-recovery.svelte'

const MAX_REFERENCES_PER_THREAD = 20
const MAX_THREADS_WITH_REFERENCES = 200

export interface ResponseReferenceAnchor extends PromptReference {
  messageId: string
  startOffset: number
  endOffset: number
}

function referenceKey(projectId: string, threadId: string): string {
  return JSON.stringify([projectId, threadId])
}

class ResponseReferencesState {
  private references = $state<Record<string, ResponseReferenceAnchor[]>>({})

  forThread(projectId: string, threadId: string): ResponseReferenceAnchor[] {
    return this.references[referenceKey(projectId, threadId)] ?? []
  }

  setForThread(projectId: string, threadId: string, references: ResponseReferenceAnchor[]): void {
    const key = referenceKey(projectId, threadId)
    const next = { ...this.references }
    let stored: ResponseReferenceAnchor[] = []
    if (references.length === 0) {
      delete next[key]
    } else {
      if (!(key in next) && Object.keys(next).length >= MAX_THREADS_WITH_REFERENCES) {
        const oldestKey = Object.keys(next)[0]
        if (oldestKey) delete next[oldestKey]
      }
      stored = references.slice(0, MAX_REFERENCES_PER_THREAD).map((reference, index) => ({
        ...reference,
        label: `Selection ${index + 1}`
      }))
      next[key] = stored
    }
    this.references = next
    // Mirror into the recovery snapshot so annotations survive thread switches
    // and app restarts, alongside the rest of the composer draft.
    rendererRecovery.setPromptReferences(projectId, threadId, stored)
  }

  clearThread(projectId: string, threadId: string): void {
    this.setForThread(projectId, threadId, [])
  }

  /** Attach or clear the user comment on a single reference anchor. */
  updateComment(projectId: string, threadId: string, referenceId: string, comment: string): void {
    const key = referenceKey(projectId, threadId)
    const current = this.references[key] ?? []
    this.setForThread(
      projectId,
      threadId,
      current.map((reference) =>
        reference.id === referenceId
          ? { ...reference, comment: comment.trim() || undefined }
          : reference
      )
    )
  }
}

export const responseReferencesState = new ResponseReferencesState()
