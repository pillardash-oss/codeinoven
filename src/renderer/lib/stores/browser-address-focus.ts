/**
 * Pending "the address bar of this tab should take the keyboard" requests.
 *
 * A tab the user opens starts empty on purpose: nothing loads until an address
 * is typed, so the panel that shows it should come up with the caret already in
 * the address bar. The request is made where the tab is created (the sidebar
 * strip, the full screen strip and the browser's own new-tab shortcut) and taken
 * by the panel that mounts for that tab, which is the earliest moment the input
 * exists.
 *
 * Taking a request removes it, so returning to a tab later never pulls focus
 * back to its address bar. Requests live only in this process and are never
 * persisted: a request belongs to the tab being opened now.
 */
class BrowserAddressFocus {
  private readonly pending = new Set<string>()

  /** Ask `tabId`'s address bar to take the keyboard once its panel is up. */
  request(tabId: string): void {
    this.pending.add(tabId)
  }

  /** Take the pending request for `tabId`, answering whether there was one. */
  take(tabId: string): boolean {
    return this.pending.delete(tabId)
  }
}

export const browserAddressFocus = new BrowserAddressFocus()
