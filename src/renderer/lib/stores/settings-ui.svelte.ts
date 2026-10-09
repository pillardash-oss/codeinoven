/** Inner tabs the Harnesses settings page splits its content into. */
export type HarnessesTab = 'harnesses' | 'accounts' | 'auxiliary' | 'custom'

/**
 * Shared settings UI state — lets the app header show which settings
 * section is on screen without prop-drilling through the view tree.
 */
class SettingsUiState {
  /** Label of the active settings section; null while Settings is off screen. */
  activeTabLabel = $state<string | null>(null)

  /**
   * Whether the settings search spotlight is open. It lives here rather than in
   * `SettingsView` because the app header owns the search button now, so the
   * header and the view share one flag.
   */
  searchOpen = $state(false)

  /**
   * Inner tab the Harnesses page is showing.
   *
   * It lives here rather than inside `ProvidersView` because the settings search
   * has to be able to reveal a card that sits inside one of those tabs: the
   * section is navigated to first, the tab is selected, and only then can the
   * block be scrolled to. A tab the search cannot reach is a card the search
   * silently fails to find.
   */
  harnessesTab = $state<HarnessesTab>('harnesses')

  /**
   * An Oven another surface asked the Ovens page to reveal.
   *
   * `sequence` lets a second request for the same Oven (a right-click after the
   * first reveal) run again instead of looking already handled.
   */
  ovenFocus = $state<{ id: string; sequence: number } | null>(null)

  /** Ask the Ovens page to scroll to and flash one Oven. */
  focusOven(id: string): void {
    this.ovenFocus = { id, sequence: (this.ovenFocus?.sequence ?? 0) + 1 }
  }

  /**
   * A request for the Ovens page to open the New Oven editor.
   *
   * The Add Project flow sends this before navigating here, so a user with no
   * Ovens lands straight in the creation form instead of an empty list. A
   * monotonic counter lets a second request run again once the first is taken.
   */
  newOvenRequest = $state(0)
  #newOvenRequestTaken = 0

  /** Ask the Ovens page to open the New Oven editor. */
  requestNewOven(): void {
    this.newOvenRequest += 1
  }

  /**
   * Claim a pending New Oven request.
   *
   * Returns true exactly once per request, so the page survives a remount
   * without reopening the editor the user already dismissed.
   */
  takeNewOvenRequest(): boolean {
    if (this.newOvenRequest <= this.#newOvenRequestTaken) return false
    this.#newOvenRequestTaken = this.newOvenRequest
    return true
  }
}

export const settingsUiState = new SettingsUiState()
