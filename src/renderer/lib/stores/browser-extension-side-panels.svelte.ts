import { invoke, subscribe } from '$lib/ipc.svelte'
import type { BrowserExtensionSidePanel, BrowserViewBounds } from '$shared/ipc-contract'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
import { reportError } from './app-errors.svelte'

/**
 * The extension side panels the browser is hosting, whole, in the order main
 * reported them.
 *
 * An extension's own side panel is not markup this app renders: Electron compiles
 * `chrome.sidePanel` out, so main hosts the extension's own document in a native
 * `WebContentsView` and composites it over the rectangle the rail measures, the
 * way it hosts a tab's page and an extension's action popup. This store is the
 * renderer's mirror of which panels exist, so the rail can name one, decide
 * whether the active tab holds any, and place the document without asking for
 * state it would then have to re-read on every change.
 *
 * Like every browser store this one is inert until {@link start} is called. The
 * panels belong to the browser, the browser is not part of the first paint, and a
 * launch that never opens it must not pay for a listener or a read.
 */
class BrowserExtensionSidePanelsState {
  /** Every panel main is hosting, in the order it reports them. */
  panels: BrowserExtensionSidePanel[] = $state([])

  /** Whether {@link start} has wired the runtime. Idempotent. */
  private started = false

  /**
   * Register the runtime's one subscription and read the panels once.
   *
   * The panels belong to the global browser's reserved profile, which is the app
   * browser the rail is drawn for, so that is the project the first read asks
   * about. Idempotent, because a rail that opens before the browser runtime seam
   * ran (and the seam itself) both ask for it without coordinating.
   */
  start(): void {
    if (this.started) return
    this.started = true
    // One subscription for the renderer's lifetime: a panel that opens while the
    // rail is showing another tool still has to be there when the tool is picked,
    // and one that closes itself while the rail is elsewhere must still leave the
    // list.
    subscribe('browser:extensionSidePanels', (panels) => this.apply(panels))
    void this.load(GLOBAL_BROWSER_PROJECT_ID)
  }

  /** Apply main's whole list: the report is short and always complete. */
  private apply(panels: BrowserExtensionSidePanel[]): void {
    this.panels = panels
  }

  /** Re-read the panels one project holds, so a rail opened on a new session (or
   *  after a change this renderer missed) shows what main actually has. */
  async load(projectId: string): Promise<void> {
    try {
      this.panels = await invoke('browser:getExtensionSidePanels', projectId)
    } catch (error: unknown) {
      reportError(error, 'Browser extension side panels could not be loaded.')
    }
  }

  /** Every side panel open in one browser tab, in report order. */
  panelsForTab(appTabId: string): BrowserExtensionSidePanel[] {
    return this.panels.filter((panel) => panel.appTabId === appTabId)
  }

  /** The side panel the rail shows for one browser tab, or null when it holds
   *  none. An extension keys one panel, so the first entry is that tab's panel. */
  panelForTab(appTabId: string): BrowserExtensionSidePanel | null {
    return this.panelsForTab(appTabId)[0] ?? null
  }

  /** Whether one browser tab holds any side panel, for the rail's own rule about
   *  staying open. */
  hasPanelForTab(appTabId: string): boolean {
    return this.panels.some((panel) => panel.appTabId === appTabId)
  }

  /** One panel by the extension that owns it, or null once it is gone. */
  find(extensionId: string): BrowserExtensionSidePanel | null {
    return this.panels.find((panel) => panel.extensionId === extensionId) ?? null
  }

  /** Place one panel's document over the frame the rail measured for it. */
  show(extensionId: string, bounds: BrowserViewBounds): void {
    void invoke('browser:showExtensionSidePanel', extensionId, bounds).catch(() => {})
  }

  /** Take a panel's document off screen. It keeps running where main keeps it. */
  hide(extensionId: string): void {
    void invoke('browser:hideExtensionSidePanel', extensionId).catch(() => {})
  }

  /** Give a panel's document the keyboard, for the panel the user just reached. */
  focus(extensionId: string): void {
    void invoke('browser:focusExtensionSidePanel', extensionId).catch(() => {})
  }

  /** Close a panel on the user's behalf: its document stops and it leaves the
   *  rail, which is what its own close control asks for. */
  close(extensionId: string): void {
    void invoke('browser:closeExtensionSidePanel', extensionId).catch((error: unknown) => {
      reportError(error, 'That extension side panel could not be closed.')
    })
  }
}

export const browserExtensionSidePanels = new BrowserExtensionSidePanelsState()
