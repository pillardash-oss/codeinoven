/**
 * In-progress text for a blank (no-address-yet) browser tab.
 *
 * A blank tab has two fields that can hold the same text: the empty-state
 * field in the page area (`BrowserBlankTab`) and the toolbar's own address
 * field (`BrowserAddressBar`). The sidebar panel and the fullscreen overlay
 * each mount their own copies, so local `$state` alone cannot survive moving
 * between them. This store bridges that gap: every blank input reads its
 * initial text and caret from here and writes every keystroke (plus caret
 * moves) back, so opening fullscreen mid-typing continues exactly where the
 * user stopped.
 */
export interface BlankTabDraft {
  text: string
  /** Caret offset at the moment typing stopped, or null when unknown. */
  caret: number | null
}

class BrowserBlankDraftStore {
  private drafts = new Map<string, BlankTabDraft>()
  private listeners = new Set<() => void>()

  get(tabId: string): BlankTabDraft | null {
    return this.drafts.get(tabId) ?? null
  }

  set(tabId: string, text: string, caret: number | null): void {
    if (text === '') {
      if (this.drafts.has(tabId)) {
        this.drafts.delete(tabId)
        this.notify()
      }
      return
    }
    const current = this.drafts.get(tabId)
    if (current?.text === text && current?.caret === caret) return
    this.drafts.set(tabId, { text, caret })
    this.notify()
  }

  clear(tabId: string): void {
    if (this.drafts.delete(tabId)) this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export const browserBlankDraft = new BrowserBlankDraftStore()
