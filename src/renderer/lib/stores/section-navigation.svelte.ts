/**
 * Cross-component section navigation for the Sources panel.
 *
 * Section sources are recorded per assistant message. When a user clicks a
 * section entry in the Sources panel, the panel posts a target here and the
 * active ThreadView scrolls the transcript to that message's heading.
 */
export interface SectionNavigationTarget {
  projectId: string
  threadId: string
  messageId: string
  section: string
}

class SectionNavigationState {
  last = $state<SectionNavigationTarget | null>(null)
  /** Bumped on every request so repeated clicks to the same section re-trigger. */
  sequence = $state(0)

  request(target: SectionNavigationTarget): void {
    this.last = target
    this.sequence += 1
  }
}

export const sectionNavigationState = new SectionNavigationState()
