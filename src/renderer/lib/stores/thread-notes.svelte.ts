/**
 * Renderer-side presence of user-only thread notes. Notes themselves are read
 * on demand via `note:get`; this store only tracks WHICH threads have a note
 * so sidebar rows and the right-dock indicator can react without an IPC call
 * per row. Synced from `note:list` on init and kept fresh by `note:changed`
 * events (saved/deleted) and `thread:deleted` cleanup.
 */
import { SvelteSet } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'

class ThreadNotesState {
  /** Thread ids that currently have a note. Thread ids are globally unique,
   *  so the set is project-agnostic. */
  private _ids = new SvelteSet<string>()
  private initialized = false

  has(threadId: string): boolean {
    return this._ids.has(threadId)
  }

  /** Load the initial note presence and subscribe to live changes. Idempotent. */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    void invoke('note:list')
      .then((ids) => {
        for (const id of ids) this._ids.add(id)
      })
      .catch(() => {})
    const unsubscribeChanged = subscribe('note:changed', (_projectId, threadId, hasNote) => {
      if (hasNote) this._ids.add(threadId)
      else this._ids.delete(threadId)
    })
    const unsubscribeDeleted = subscribe('thread:deleted', (_projectId, threadId) => {
      this._ids.delete(threadId)
    })
    // Cleanup happens only when the whole renderer tears down; keep the
    // subscriptions referenced so they are never garbage collected.
    this.dispose = () => {
      unsubscribeChanged()
      unsubscribeDeleted()
    }
  }

  dispose: (() => void) | null = null
}

export const threadNotesState = new ThreadNotesState()
