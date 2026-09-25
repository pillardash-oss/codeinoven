import { documentPreviewFrame } from '$lib/document-preview-frame'
import { invoke } from '$lib/ipc.svelte'
import type { ProjectFileInfo } from '$shared/types'

/**
 * HTML document-preview loader for the file viewer.
 *
 * A read is started only once per (path, reload token) pair; the in-flight
 * guard keeps churn on `activeTab` from restarting the IPC chain and leaving
 * the spinner stuck. A bumped reload token deliberately bypasses both guards
 * so Reload re-reads the file from disk.
 */
export class ProjectFilesPanelDocumentPreview {
  html = $state<string | null>(null)
  loading = $state(false)
  failed = $state(false)
  error = $state<string | null>(null)

  /** Path whose HTML is currently loaded - guards against tab swaps. */
  private htmlPath: string | null = null
  /** Reload token the loaded HTML belongs to. */
  private htmlToken: number | null = null
  /** Path whose HTML is currently being fetched. Deliberately not reactive:
   *  the effect both reads and writes it, so making it reactive would retrigger
   *  the load on its own write. */
  private inFlightPath: string | null = null
  /** Monotonic ownership token for the active chain. */
  private effectToken = 0

  sync(
    projectId: string,
    activePath: string | null,
    requested: boolean,
    reloadToken: number,
    scopeBucketId: string
  ): void {
    if (!requested || !activePath) {
      this.reset()
      return
    }
    const path = activePath
    if ((this.htmlPath === path && this.htmlToken === reloadToken) || this.inFlightPath === path) {
      return
    }
    this.inFlightPath = path
    const token = ++this.effectToken
    this.loading = true
    this.failed = false
    this.error = null
    // Hard cap: a hung IPC chain must never leave the spinner spinning forever.
    const timeout = setTimeout(() => {
      if (token !== this.effectToken) return
      this.html = null
      this.htmlPath = path
      this.htmlToken = reloadToken
      this.inFlightPath = null
      this.failed = true
      this.error = 'Document preview timed out'
      this.loading = false
    }, 15000)
    // `file:readDocumentPreview` requires an absolute path, but the tab only
    // carries a project-relative path (which may live inside a managed worktree
    // scope). Resolve the authoritative absolute path through main first.
    void invoke('projectFiles:info', projectId, path, scopeBucketId)
      .then((info: ProjectFileInfo) => invoke('file:readDocumentPreview', info.absolutePath))
      .then((html: string | null) => {
        if (token !== this.effectToken) return
        // documentPreviewFrame sanitizes and wraps the raw converter HTML in
        // a styled page so the preview matches the chat-attachment document
        // preview instead of rendering transparent.
        this.html = html ? documentPreviewFrame(html) : null
        this.htmlPath = path
        this.htmlToken = reloadToken
        this.inFlightPath = null
        this.failed = html === null
        this.error = html === null ? 'The document could not be converted for preview' : null
      })
      .catch((error: unknown) => {
        if (token !== this.effectToken) return
        this.html = null
        this.htmlPath = path
        this.htmlToken = reloadToken
        this.inFlightPath = null
        this.failed = true
        this.error = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        clearTimeout(timeout)
        // Only the current chain may settle the spinner; a stale chain that
        // lands after a newer load started must leave it alone.
        if (token === this.effectToken) this.loading = false
      })
  }

  private reset(): void {
    this.html = null
    this.htmlPath = null
    this.htmlToken = null
    this.inFlightPath = null
    this.failed = false
    this.error = null
    this.loading = false
  }
}
