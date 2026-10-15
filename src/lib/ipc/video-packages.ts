/**
 * The optional video inference pack.
 *
 * Every video operation except GPU background removal runs on the bundled
 * `ffmpeg-static` binary, so the app ships without the heavy matting stack. The
 * `remove-background` operation needs `@remotion/video-matting` and its
 * neighbours, and those are installed on demand into the app's own config
 * folder. This module is the shared contract between the main-process installer
 * and the Settings block that drives it.
 */

/** Where the pack install stands. Progress phases never report `idle`. */
export type VideoPackagesPhase =
  'idle' | 'preparing' | 'installing' | 'installed' | 'failed' | 'cancelled'

export interface VideoPackagesState {
  /** The installed ledger is present and all four pinned packages resolve. */
  installed: boolean
  /** Pinned pack version, or null when nothing is installed. */
  version: string | null
  /** Bytes the installed pack occupies on disk; 0 when not installed. */
  sizeBytes: number
  phase: VideoPackagesPhase
  /**
   * Install progress, 0-100. Null while the package manager reports no
   * percentage, which the settings block renders as indeterminate.
   */
  percent: number | null
  /** Latest install failure, present only after a failed install. */
  error?: string | null
}

/** One live install stage, broadcast to every window like the search download. */
export type VideoPackagesProgressEvent = VideoPackagesState
