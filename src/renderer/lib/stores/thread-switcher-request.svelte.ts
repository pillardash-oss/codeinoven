/**
 * Pointer open requests for the Ctrl+Tab thread switcher.
 *
 * The switcher itself lives in the workspace, while the app logo that should
 * open it with the mouse lives in the app header. The header publishes one
 * request per logo click; the switcher opens its mouse-friendly list from the
 * latest request. A request with no entries to show is a no-op, so the dialog
 * never appears over an empty list.
 */
class ThreadSwitcherRequestState {
  /** Bumped once per logo click. The switcher opens from the latest value. */
  requestId = $state(0)

  requestOpen(): void {
    this.requestId += 1
  }
}

export const threadSwitcherRequest = new ThreadSwitcherRequestState()
