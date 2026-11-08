/**
 * The walkthrough a question card handed to the user, owned by the app rather
 * than by the card that opened it.
 *
 * A walkthrough is the step-by-step text the user runs or pastes to produce an
 * answer. Following it means leaving the app, and the card that carries it is
 * replaced the moment the question settles, so the panel must not live inside
 * that card: `QuestionWalkthroughDock` is mounted at the app root and is a view
 * of this state. One walkthrough is open at a time, because only one question
 * card is on screen at a time, and opening another entry's walkthrough replaces
 * the text instead of stacking a second panel.
 */
class QuestionWalkthroughState {
  /** Whether the panel exists at all. False drops it, and its dock chip with it. */
  open = $state(false)
  /** Whether the panel is collapsed into its dock chip. */
  minimized = $state(false)
  /** What the walkthrough belongs to: the question header or an option label. */
  subject = $state('')
  /** The step-by-step text itself, copied verbatim. */
  text = $state('')

  /** Show one entry's walkthrough, expanded, replacing whatever was open. */
  show(subject: string, text: string): void {
    if (!text) return
    this.subject = subject
    this.text = text
    this.minimized = false
    this.open = true
  }

  /** Collapse into the chip so the app stays usable while the steps are followed. */
  minimize(): void {
    if (!this.open) return
    this.minimized = true
  }

  /** Bring the collapsed panel back on screen. */
  restore(): void {
    this.minimized = false
  }

  /** Drop the panel and its chip. */
  close(): void {
    this.open = false
    this.minimized = false
  }
}

export const questionWalkthrough = new QuestionWalkthroughState()
