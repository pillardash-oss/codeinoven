/**
 * Shared settings UI state — lets the app header show which settings
 * section is on screen without prop-drilling through the view tree.
 */
class SettingsUiState {
  /** Label of the active settings section; null while Settings is off screen. */
  activeTabLabel = $state<string | null>(null)
}

export const settingsUiState = new SettingsUiState()
