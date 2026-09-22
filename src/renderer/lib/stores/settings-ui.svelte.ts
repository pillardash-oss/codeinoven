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
   * Inner tab the Harnesses page is showing.
   *
   * It lives here rather than inside `ProvidersView` because the settings search
   * has to be able to reveal a card that sits inside one of those tabs: the
   * section is navigated to first, the tab is selected, and only then can the
   * block be scrolled to. A tab the search cannot reach is a card the search
   * silently fails to find.
   */
  harnessesTab = $state<HarnessesTab>('harnesses')
}

export const settingsUiState = new SettingsUiState()
