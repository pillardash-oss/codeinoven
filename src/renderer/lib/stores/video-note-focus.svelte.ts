/**
 * A request for the video timeline to select one note and open its comment editor.
 *
 * A video note's comment is written on the surface that draws its row, which is
 * the composition's timeline, while the note itself is listed in the
 * conversation's composer. Its edit action therefore has to name the note the
 * reader asked to edit, and the board may only exist afterwards: that same click
 * is what opens the video board. Holding the request here, rather than passing it
 * through the panel's props, lets whichever timeline mounts for that composition
 * take it.
 */
export interface VideoNoteFocusRequest {
  projectId: string
  threadId: string
  referenceId: string
  /** The second the note sits at, so the timeline can seek before it selects. */
  seconds: number
  /** Project-relative composition folder the note belongs to. */
  directory: string
  /** Distinguishes a second request for the same note from the first, so a
   *  timeline that already acted on one never treats the repeat as handled. */
  token: number
}

class VideoNoteFocusState {
  private current: VideoNoteFocusRequest | null = $state(null)
  private nextToken = 1

  /** Ask the timeline showing one composition to select one note's row. */
  request(request: Omit<VideoNoteFocusRequest, 'token'>): void {
    this.current = { ...request, token: this.nextToken++ }
  }

  /**
   * The request waiting for one timeline, or null when it has none.
   *
   * A request that names another project or conversation belongs to that
   * conversation's board: a project owns a single video board, and it can be
   * showing a composition while its conversation is not the one on screen.
   */
  pending(projectId: string, threadId: string): VideoNoteFocusRequest | null {
    const request = this.current
    if (!request || request.projectId !== projectId || request.threadId !== threadId) return null
    return request
  }

  /** Drop a request the timeline has acted on. */
  consume(token: number): void {
    if (this.current?.token === token) this.current = null
  }
}

export const videoNoteFocusState = new VideoNoteFocusState()
