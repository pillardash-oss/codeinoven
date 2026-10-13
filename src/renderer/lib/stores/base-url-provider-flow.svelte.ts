import type { BaseUrlProvider } from '$shared/types'

/**
 * The app-wide custom base-URL provider editor.
 *
 * The editor is a dockable panel rather than a blocking dialog, so it has to
 * outlive the surface that opened it: minimizing it leaves a chip behind while
 * the user keeps working, and a docked chip inside the settings page would be
 * unmounted the moment the user navigates away. Surfaces therefore publish a
 * request here, and `BaseUrlProviderHost` draws the one panel above every view
 *   the same split `providerConnectFlow` uses for the Add-provider modal.
 */
export interface BaseUrlProviderEditorRequest {
  /** Provider being edited, or null to create one. */
  provider: BaseUrlProvider | null
  /** Harness pre-selected in create mode. */
  defaultHarnessId: string
  /** Called with the persisted provider after a successful save. */
  onSaved?: (provider: BaseUrlProvider) => void
  /**
   * Called when the panel is dismissed without saving (footer Cancel, the close
   * affordance, Escape, or the dock chip), so a surface that handed the user off
   * to this editor can take them back where they came from.
   */
  onClosed?: () => void
  /**
   * Called when the footer's Back button returns the user to the surface that
   * handed off   the Add-provider modal's custom tab.
   */
  onBack?: () => void
}

class BaseUrlProviderFlowStore {
  request = $state.raw<BaseUrlProviderEditorRequest | null>(null)

  /**
   * Open the editor for a provider (or for a new one), replacing any request
   * already in flight: the host keys its panel on the request, so editing
   * another provider from the list behind a docked panel always starts from that
   * provider's own values instead of the previous draft.
   */
  open(request: BaseUrlProviderEditorRequest): void {
    this.request = request
  }

  close(): void {
    this.request = null
  }
}

export const baseUrlProviderFlow = new BaseUrlProviderFlowStore()
