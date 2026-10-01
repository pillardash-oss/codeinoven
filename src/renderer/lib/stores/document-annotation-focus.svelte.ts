/**
 * A request for the annotate view to open one document annotation's note editor.
 *
 * A document annotation's comment is written on the surface that draws its
 * passage, which is the file panel's annotate view, while the annotation itself is
 * listed in the conversation's composer. Its edit action therefore has to name the
 * annotation the reader asked to edit, and the panel may only exist afterwards:
 * that same click is what opens the document. Holding the request here, rather
 * than passing it through the panel's props, lets whichever annotate view mounts
 * for that document take it.
 */
export interface DocumentAnnotationFocusRequest {
  projectId: string
  threadId: string
  referenceId: string
  /** Distinguishes a second request for the same annotation from the first, so a
   *  view that already acted on one never treats the repeat as handled. */
  token: number
}

class DocumentAnnotationFocusState {
  private current: DocumentAnnotationFocusRequest | null = $state(null)
  private nextToken = 1

  /** Ask the annotate view showing one document to open one annotation's note. */
  request(projectId: string, threadId: string, referenceId: string): void {
    this.current = { projectId, threadId, referenceId, token: this.nextToken++ }
  }

  /**
   * The request waiting for one annotate view, or null when it has none.
   *
   * A request that names another project or conversation belongs to that
   * conversation's panel: a project owns a single file panel, and it can be
   * showing a document while its conversation is not the one on screen.
   */
  pending(projectId: string, threadId: string): DocumentAnnotationFocusRequest | null {
    const request = this.current
    if (!request || request.projectId !== projectId || request.threadId !== threadId) return null
    return request
  }

  /** Drop a request the annotate view has acted on. */
  consume(token: number): void {
    if (this.current?.token === token) this.current = null
  }
}

export const documentAnnotationFocusState = new DocumentAnnotationFocusState()
