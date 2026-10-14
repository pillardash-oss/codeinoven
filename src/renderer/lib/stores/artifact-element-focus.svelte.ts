/**
 * A request for one inline artifact card to open an element pick's comment editor.
 *
 * A pick made inside an inline SVG artifact has its comment written on the card
 * that draws the SVG, while the pick itself is listed in the conversation's
 * composer. Its edit action therefore has to name the pick the reader asked to
 * edit, and the card may carry several picks of its own, so the request is held
 * here and whichever card owns that artifact takes it. Passing it through
 * component props would mean threading a conversation-scoped value through the
 * markdown renderer into every artifact card, which is what this avoids.
 */
export interface ArtifactElementFocusRequest {
  projectId: string
  threadId: string
  /** The artifact whose card must act on the request. */
  artifactKey: string
  referenceId: string
  /** Distinguishes a second request for the same pick from the first, so a card
   *  that already acted on one never treats the repeat as handled. */
  token: number
}

class ArtifactElementFocusState {
  private current: ArtifactElementFocusRequest | null = $state(null)
  private nextToken = 1

  /** Ask the card drawing one artifact to open one pick's comment editor. */
  request(projectId: string, threadId: string, artifactKey: string, referenceId: string): void {
    this.current = { projectId, threadId, artifactKey, referenceId, token: this.nextToken++ }
  }

  /**
   * The request waiting for one card, or null when it has none.
   *
   * A request that names another project, conversation or artifact belongs to
   * that card: the same SVG can be rendered by several cards at once (inline and
   * in the fullscreen viewer), and each owns its own picks.
   */
  pending(
    projectId: string,
    threadId: string,
    artifactKey: string
  ): ArtifactElementFocusRequest | null {
    const request = this.current
    if (!request) return null
    if (request.projectId !== projectId || request.threadId !== threadId) return null
    if (request.artifactKey !== artifactKey) return null
    return request
  }

  /** Drop a request the card has acted on. */
  consume(token: number): void {
    if (this.current?.token === token) this.current = null
  }
}

export const artifactElementFocusState = new ArtifactElementFocusState()
