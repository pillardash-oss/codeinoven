/** Pure presentation strings for the native downloads menu. Lives apart from
 *  the manager so the menu code stays free of formatting details. */

import type { BrowserDownload } from '../../../lib/ipc-contract'

/** Human-readable byte count, matching the renderer's downloads formatting. */
export function formatDownloadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** Status line shown (disabled) under a download's filename in the menu. */
export function downloadStatusLabel(download: BrowserDownload): string {
  if (download.state === 'completed') {
    return `Completed - ${formatDownloadBytes(download.totalBytes || download.receivedBytes)}`
  }
  if (download.state === 'cancelled') return 'Cancelled'
  // A download the user paused reads as paused wherever it stopped, whether this
  // run is still holding it or an earlier one did.
  if (download.paused) {
    return download.totalBytes > 0
      ? `Paused - ${Math.round(download.progress)}% of ${formatDownloadBytes(download.totalBytes)}`
      : `Paused - ${formatDownloadBytes(download.receivedBytes)}`
  }
  if (download.state === 'interrupted') {
    const kept = `${Math.round(download.progress)}%`
    return download.resumable
      ? `Interrupted - ${kept} kept, resumable`
      : `Interrupted - ${formatDownloadBytes(download.receivedBytes)}`
  }
  return `Downloading - ${Math.round(download.progress)}% (${formatDownloadBytes(download.speedBytes)}/s)`
}
