/**
 * A request for a composition frame note to reopen one mark's comment.
 *
 * A mark drawn on a captured frame is drawn by the full screen annotator the
 * transport opens, and that surface exists only while the board is showing the
 * composition. The composer lists the mark with an edit action, so the click has
 * to name what the reader asked to edit and survive the board opening afterwards:
 * holding the request here, rather than passing it through the board's props,
 * lets whichever composition surface mounts next take it.
 */
export interface CompositionFrameFocusRequest {
  projectId: string
  threadId: string
  /** The mark whose comment the reader asked to edit. */
  referenceId: string
  /** The second on the composition the mark was drawn at. */
  seconds: number
  /** Project-relative folder of the composition the mark belongs to. */
  directory: string
  /** Distinguishes a second request for the same mark from the first, so a
   *  surface that already acted on one never treats the repeat as handled. */
  token: number
}

class CompositionFrameFocusState {
  private current: CompositionFrameFocusRequest | null = $state(null)
  private nextToken = 1

  /** Ask the surface showing one composition to reopen one mark's comment. */
  request(request: Omit<CompositionFrameFocusRequest, 'token'>): void {
    this.current = { ...request, token: this.nextToken++ }
  }

  /**
   * The request waiting for one composition, or null when it has none.
   *
   * A request naming another project, conversation or composition belongs to
   * that one's surface: the board plays one composition at a time, and a mark on
   * a composition it is not showing has nothing to land on.
   */
  pending(
    projectId: string,
    threadId: string,
    directory: string
  ): CompositionFrameFocusRequest | null {
    const request = this.current
    if (!request) return null
    if (request.projectId !== projectId || request.threadId !== threadId) return null
    return request.directory === directory ? request : null
  }

  /** Drop a request the surface has acted on. */
  consume(token: number): void {
    if (this.current?.token === token) this.current = null
  }
}

export const compositionFrameFocusState = new CompositionFrameFocusState()
