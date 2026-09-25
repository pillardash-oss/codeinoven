import type { PromptReference } from '$shared/types'
import { rendererRecovery } from './renderer-recovery.svelte'

const MAX_REFERENCES_PER_THREAD = 20
const MAX_THREADS_WITH_REFERENCES = 200

export interface ResponseReferenceAnchor extends PromptReference {
  /**
   * Response selections anchor to a message range. A design reference has no
   * range: it points at an element in a served page. A document annotation is
   * anchored to character offsets inside the rendered document named by
   * `filePath`, so these stay optional for both of those kinds.
   */
  messageId?: string
  startOffset?: number
  endOffset?: number
  /** Design references: the CSS path the page re-resolves the element by after
   *  a layout shift, so its pin stays on the element. */
  selector?: string
  /** Design references: the browser tab the element was picked from, so the
   *  panel knows which tab a reference's pin belongs to. */
  tabId?: string
  /** Document annotations: the project-relative path of the document the
   *  passage was annotated in, so a document's preview pins only its own
   *  annotations and the path travels with the prompt. */
  filePath?: string
}

/**
 * Whether a reference is an excerpt selected from an assistant response.
 *
 * Only that kind is anchored to a message range: it is the one reference a
 * conversation re-highlights and edits in place, and the one the store
 * renumbers. A picked design element is pinned by its own page and an annotated
 * document passage by its own file, so both keep the label they were created
 * with.
 */
export function isResponseSelection(reference: Pick<PromptReference, 'kind'>): boolean {
  return reference.kind === undefined || reference.kind === 'selection'
}

/** Called with the thread whose references changed. */
type ReferencesListener = (projectId: string, threadId: string) => void

function referenceKey(projectId: string, threadId: string): string {
  return JSON.stringify([projectId, threadId])
}

class ResponseReferencesState {
  private references = $state<Record<string, ResponseReferenceAnchor[]>>({})
  /**
   * Parts of the app that must react to a write rather than to a rendered value.
   *
   * The browser panel is the one listener: it owns a page's pins, which are not
   * a render of this state but a set of elements drawn by an injected script, so
   * it has to be told when to re-publish them. A subscription keeps that out of
   * an `$effect`, where the write would be a side effect of a read.
   */
  private readonly listeners = new Set<ReferencesListener>()

  subscribe(listener: ReferencesListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

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
        // A response selection is named by its position, and so is a picked
        // design element: both are shown as a number by the popover, and the
        // number has to agree with the surface that pins them (a highlight
        // bubble, a page pin). A document annotation keeps the label it was
        // created with instead: its path names it on the document pin and in
        // the prompt, and it is what the model needs to find the passage.
        label: isResponseSelection(reference)
          ? `Selection ${index + 1}`
          : reference.kind === 'file'
            ? reference.label
            : `Design element ${index + 1}`
      }))
      next[key] = stored
    }
    this.references = next
    // Mirror into the recovery snapshot so annotations survive thread switches
    // and app restarts, alongside the rest of the composer draft.
    rendererRecovery.setPromptReferences(projectId, threadId, stored)
    for (const listener of this.listeners) listener(projectId, threadId)
  }

  clearThread(projectId: string, threadId: string): void {
    this.setForThread(projectId, threadId, [])
  }

  /** Attach or clear the user comment on a single reference anchor. */
  updateComment(projectId: string, threadId: string, referenceId: string, comment: string): void {
    this.updateStoredComment(projectId, threadId, referenceId, comment.trim() || undefined)
  }

  /** Persist an in-progress comment exactly as typed so dismissing the editor
   *  or restarting the app cannot discard the user's draft. */
  updateCommentDraft(
    projectId: string,
    threadId: string,
    referenceId: string,
    comment: string
  ): void {
    this.updateStoredComment(projectId, threadId, referenceId, comment.trim() ? comment : undefined)
  }

  private updateStoredComment(
    projectId: string,
    threadId: string,
    referenceId: string,
    comment: string | undefined
  ): void {
    const key = referenceKey(projectId, threadId)
    const current = this.references[key] ?? []
    this.setForThread(
      projectId,
      threadId,
      current.map((reference) =>
        reference.id === referenceId ? { ...reference, comment } : reference
      )
    )
  }
}

export const responseReferencesState = new ResponseReferencesState()
