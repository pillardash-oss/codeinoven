/**
 * Open requests for the active view's own panel search.
 *
 * The panel that owns the search lives in the workspace (the project, thread and
 * chat lists) or in the assistant sidebar, while the keymap is handled by the
 * app shell. One request is published per chord, and whichever panel is on
 * screen opens its search from the latest request. The conversation keeps
 * `mod+f` for its own find, so this is the panel's chord and nothing else.
 */
class PanelSearchRequestState {
  /** Bumped once per chord. A panel opens its search from the latest value. */
  requestId = $state(0)

  requestOpen(): void {
    this.requestId += 1
  }
}

export const panelSearchRequest = new PanelSearchRequestState()
