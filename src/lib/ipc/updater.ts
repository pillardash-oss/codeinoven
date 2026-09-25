/**
 * Compile-time contract for every renderer-invokable main-process operation.
 * Runtime handlers still validate untrusted values at the IPC boundary.
 */
export interface UpdaterStatus {
  canAutoUpdate: boolean
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'waiting'
  currentVersion?: string
  availableVersion?: string
  downloadProgress?: number
  errorMessage?: string
}

/** Release notes of the newest published release for the configured channel. */
export interface UpdaterChangelog {
  /** Release tag, e.g. `v0.5.54-nightly.2` or `v0.5.53`. */
  tag: string
  /** ISO publish date of the release, empty when unknown. */
  publishedAt: string
  /** Markdown release body, sanitized by the renderer before display. */
  notes: string
}
