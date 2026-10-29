/**
 * The handoff between the first-screen conversation layer and the real view.
 *
 * The two are not the same moment. The renderer releases the splash as soon as it
 * has reported the restored conversation (that is the launch's own promise), but
 * the workspace's conversation pane still has to mount, read, and lay out its
 * messages after that report, and on a slow launch that is seconds more. Hiding
 * the first-screen layer on the launch's signal therefore showed the user their
 * conversation, blanked it, and painted it again.
 *
 * So the layer stays until the pane itself says it painted. This module is that
 * one boolean, kept reactive because the layer lives in `App.svelte` and the
 * signal comes from the pane several components below it.
 */
class ConversationFirstScreenState {
  /**
   * Whether the conversation pane has painted real messages in its own frame.
   *
   * A layer that is waiting on this can therefore never uncover an empty column.
   */
  paneReady = $state(false)

  /** Record that the pane has painted its conversation. Idempotent. */
  markPaneReady(): void {
    if (this.paneReady) return
    this.paneReady = true
  }
}

export const conversationFirstScreen = new ConversationFirstScreenState()
