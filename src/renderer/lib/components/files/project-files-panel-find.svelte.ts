import { findNavState } from '$lib/stores/find-nav.svelte'

export interface EditorReplaceRequest {
  nonce: number
  action: 'one' | 'all'
  query: string
  replacement: string
}

/** Find/replace state for the file editor surfaces, mirrored into the shared
 *  find-nav store so the in-file bar and the global shortcuts stay in sync. */
export class ProjectFilesPanelFind {
  value = $state('')
  active = $state(0)
  total = $state(0)
  nonce = $state(0)
  replaceValue = $state('')
  private replaceAction = $state<'one' | 'all'>('one')
  private replaceNonce = $state(0)

  replaceRequest = $derived<EditorReplaceRequest | null>(
    this.replaceNonce === 0
      ? null
      : {
          nonce: this.replaceNonce,
          action: this.replaceAction,
          query: this.value,
          replacement: this.replaceValue
        }
  )

  close(): void {
    findNavState.closeEditorFind()
    this.value = ''
    this.active = 0
    this.total = 0
  }

  setQuery(query: string): void {
    this.value = query
    this.active = 0
    this.total = 0
    findNavState.editorFindQuery = query
    findNavState.editorFindActiveIndex = 0
    findNavState.editorFindMatches = 0
    findNavState.editorFindOpen = true
  }

  setMatches(matches: number): void {
    this.total = matches
    findNavState.editorFindMatches = matches
  }

  /** Re-scan the current query against a document that changed without going
   *  through the find bar (for example after the file was beautified). */
  rescan(): void {
    this.nonce += 1
  }

  next(): void {
    if (this.total === 0) return
    const next = (this.active + 1) % this.total
    this.active = next
    findNavState.editorFindActiveIndex = next
  }

  prev(): void {
    if (this.total === 0) return
    const prev = (this.active - 1 + this.total) % this.total
    this.active = prev
    findNavState.editorFindActiveIndex = prev
  }

  replaceOne(): void {
    if (!this.value || this.total === 0) return
    this.replaceAction = 'one'
    this.replaceNonce += 1
  }

  replaceAll(): void {
    if (!this.value || this.total === 0) return
    this.replaceAction = 'all'
    this.replaceNonce += 1
  }

  handleReplaceDone(replaced: number): void {
    if (replaced === 0) return
    this.active = 0
    findNavState.editorFindActiveIndex = 0
    // Force the editor to re-scan matches after the document changed.
    this.nonce += 1
  }
}
