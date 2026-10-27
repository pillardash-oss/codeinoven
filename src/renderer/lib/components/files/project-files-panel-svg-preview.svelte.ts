import { invoke } from '$lib/ipc.svelte'
import type { ProjectTextFile } from '$shared/types'

export interface SvgPreviewInput {
  projectId: string
  activePath: string | null
  isSvg: boolean
  /** The editor's live draft for this file, or null while it has no session.
   *  A draft wins over the disk read, so an unsaved SVG edit shows in the
   *  preview immediately and a save never leaves a stale rendering behind. */
  draft: string | null
  /** Reads the current reload token, so a superseded read can drop its blob. */
  currentReloadToken: () => number
  scopeBucketId: string
  /** Optional trailing thread-mount argument for `projectFiles:*` invokes. */
  mountThreadId: string | null
}

/**
 * SVG preview loader.
 *
 * SVG is rendered natively in the renderer via a blob URL (animated SVGs
 * play), instead of the privileged `appfile://` scheme, which intentionally
 * refuses to serve project-controlled SVG. `sync` returns the effect cleanup
 * that revokes the current blob, so a reload or unmount never leaks it.
 */
export class ProjectFilesPanelSvgPreview {
  url = $state<string | null>(null)
  failed = $state(false)

  sync(input: SvgPreviewInput): () => void {
    if (!input.activePath || !input.isSvg) {
      this.revoke()
      return () => {}
    }
    if (input.draft !== null) {
      this.replace(input.draft)
      return () => this.revoke()
    }
    const path = input.activePath
    const reloadToken = input.currentReloadToken()
    let cancelled = false
    this.failed = false
    void invoke(
      'projectFiles:read',
      input.projectId,
      path,
      input.scopeBucketId,
      input.mountThreadId ?? undefined
    )
      .then((source: ProjectTextFile | null) => {
        if (cancelled || !source) return
        // A newer reload request superseded this read; its own run will land
        // the fresh blob, so drop the stale content.
        if (input.currentReloadToken() !== reloadToken) return
        this.replace(source.content)
      })
      .catch(() => {
        if (cancelled) return
        this.failed = true
      })
    return () => {
      cancelled = true
      this.revoke()
    }
  }

  private replace(content: string): void {
    this.failed = false
    const previous = this.url
    this.url = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }))
    if (previous) URL.revokeObjectURL(previous)
  }

  private revoke(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url)
      this.url = null
    }
    this.failed = false
  }
}
