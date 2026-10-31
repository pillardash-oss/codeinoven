/**
 * Compile-time contract for every renderer-invokable main-process operation.
 * Runtime handlers still validate untrusted values at the IPC boundary.
 */
import type { BrowserDownload } from './browser'
import type { CloseConfirmationProject } from './notifications'

export interface UpdaterStatus {
  canAutoUpdate: boolean
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'waiting'
  currentVersion?: string
  availableVersion?: string
  downloadProgress?: number
  errorMessage?: string
  /**
   * Set while an update is available but its automatic install is on hold
   * because earlier installs of that exact version were rejected. The update
   * stays installable by hand.
   */
  blockedReason?: string
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

/**
 * A live terminal session an install would take down with the app. Read from the
 * main process, which owns the pty handles: the renderer's own session list only
 * exists once the terminal chunk has loaded, and a gate that trusted it could
 * report an idle install while a shell was still running.
 */
export interface UpdateBlockerTerminal {
  sessionId: string
  /** The shell that owns the session, e.g. `zsh`, so a row can name it. */
  shell: string
  /** The directory the shell was opened in. */
  cwd: string
}

/**
 * Everything standing between the app and the update it is waiting to install,
 * as the force-install modal needs to show it.
 *
 * The thread half reuses the close-confirmation shape on purpose. It is the same
 * question the close gate already answers from the same source
 * (`getActiveThreadProjects`), so sharing the shape keeps one rendering of "still
 * working" rather than two that drift apart.
 */
export interface UpdateBlockers {
  /** The version the pending install will apply, empty when none is pending. */
  version: string
  /**
   * The install gate's own count of what it is waiting on. The lists below come
   * from each source's detail, so this is what makes the modal's wording agree
   * with the number the rail is already showing.
   */
  activeCount: number
  /** Working threads, grouped by project and most active first. */
  projects: CloseConfirmationProject[]
  /** Live terminal sessions, oldest first. */
  terminals: UpdateBlockerTerminal[]
  /**
   * Browser downloads in flight, oldest first.
   *
   * The unattended install waits for these instead of quitting through a
   * download, because a quit stops the transfer. They are still listed in the
   * force-install modal: an install the user asks for pauses every one of them
   * and keeps the bytes already received, so the next launch continues where
   * they stopped.
   */
  downloads: BrowserDownload[]
}

/**
 * What a pending install is still waiting on, pushed on every deferred decision.
 *
 * Both halves are reported separately: the rail and Settings name what is
 * actually holding the install back, and "waiting for a download" reads very
 * differently from "waiting for a working thread".
 */
export interface UpdaterWaitingWork {
  /** Working sessions and live terminal processes. */
  threads: number
  /** Browser downloads whose bytes are still arriving. */
  downloads: number
}
