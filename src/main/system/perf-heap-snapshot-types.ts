/**
 * What a heap snapshot produced, as it crosses IPC.
 *
 * Kept apart from the writer so the renderer-facing contract can name the shape
 * without importing a module that reaches for Electron's `webContents`.
 */
export interface HeapSnapshotResult {
  /** Absolute path of the written `.heapsnapshot` file. */
  file: string
  /** Size on disk in bytes: a snapshot of a bloated renderer is hundreds of MB. */
  bytes: number
  /** Which window it belongs to. */
  surface: string
}
