import type { BrowserDownload } from '$shared/ipc-contract'

export function browserDownloadHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function browserDownloadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * How long ago a download started, in the shortest form that still says whether
 * it is from this session or an earlier one. Downloads are kept across restarts,
 * so a row that only showed a percentage could be days old without saying so.
 */
export function browserDownloadAge(startedAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return ''
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Whether this download has bytes on disk to continue from, which is what makes
 *  its progress worth showing even though it is not running right now. */
export function browserDownloadShowsProgress(download: BrowserDownload): boolean {
  return (
    download.state === 'progressing' || (download.state === 'interrupted' && download.resumable)
  )
}

/**
 * A download the user paused reads as paused wherever it stopped: a pause they
 * chose outlives the run that was downloading it, and it is their intent rather
 * than a property of the download in flight.
 */
export function browserDownloadStateLabel(download: BrowserDownload): string {
  if (download.state === 'completed') return 'Completed'
  if (download.state === 'cancelled') return 'Cancelled'
  if (download.paused) return 'Paused'
  if (download.state === 'interrupted') return 'Interrupted'
  return 'Downloading'
}

export function browserDownloadTone(
  download: BrowserDownload
): 'success' | 'danger' | 'warning' | 'neutral' | 'info' {
  if (download.state === 'completed') return 'success'
  if (download.state === 'cancelled') return 'neutral'
  if (download.paused) return 'warning'
  if (download.state === 'interrupted') return 'danger'
  return 'info'
}
