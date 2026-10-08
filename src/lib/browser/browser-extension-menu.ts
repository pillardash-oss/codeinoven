/**
 * Native context menu for one browser extension.
 *
 * Pins only left-click today, and panel rows have no right-click at all. This
 * contract carries what main needs to build the OS menu and names the choice
 * back, so header pins and panel rows share one menu like a normal browser:
 * open, options, enable, pin, per-site access, manage, remove.
 */

export interface BrowserExtensionMenuInput {
  extensionId: string
  extensionName: string
  enabled: boolean
  pinned: boolean
  pinCapReached: boolean
  hasPopup: boolean
  hasOptions: boolean
  /** Host of the tab on screen, or null when no tab or no http(s) page. */
  host: string | null
  /** Whether the extension runs on that host right now. */
  runsOnHost: boolean
  /** Whether the extension runs in the tab jar on screen. */
  runsInJar: boolean
  tabControl: boolean
  enabledInTab: boolean
  tabScoped: boolean
}

export type BrowserExtensionMenuChoice =
  | 'open-popup'
  | 'open-options'
  | 'toggle-enabled'
  | 'toggle-pin'
  | 'allow-site'
  | 'block-site'
  | 'clear-site-rules'
  | 'only-tab'
  | 'disable-tab'
  | 'enable-tab'
  | 'reset-tabs'
  | 'manage'
  | 'remove'
