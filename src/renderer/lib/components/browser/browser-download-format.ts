import type { BrowserDownload } from '$shared/ipc-contract'
import { formatCompactAge } from '$shared/date-time-format'
import { formatBytes } from '$lib/format/bytes'

export function browserDownloadHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function browserDownloadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  return formatBytes(bytes)
}

/**
 * How long ago a download started, in the shortest form that still says whether
 * it is from this session or an earlier one. Downloads are kept across restarts,
 * so a row that only showed a percentage could be days old without saying so.
 */
export function browserDownloadAge(startedAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return ''
  return formatCompactAge(startedAt, now)
}

/**
 * The one-line summary under a download's filename.
 *
 * Movement comes first because that is what the user watches: the bytes against
 * the total, then the speed they are arriving at, then how long the download has
 * been going. The source host is last on purpose. It never changes while a
 * download runs, and a narrow row truncates its tail, so putting it first spent
 * the visible room on the one part that never moves.
 */
export function browserDownloadDetail(download: BrowserDownload, now: number = Date.now()): string {
  const parts: string[] = []
  if (download.receivedBytes > 0) {
    parts.push(
      browserDownloadShowsProgress(download) && download.totalBytes > 0
        ? `${browserDownloadBytes(download.receivedBytes)} of ${browserDownloadBytes(download.totalBytes)}`
        : browserDownloadBytes(download.receivedBytes)
    )
  }
  if (download.state === 'progressing' && !download.paused && download.speedBytes > 0) {
    parts.push(`${browserDownloadBytes(download.speedBytes)}/s`)
  }
  // "Now" says nothing in a row that is already counting bytes upward, so the
  // duration only appears once it is long enough to read as one.
  const duration = browserDownloadAge(download.startedAt, now)
  if (duration.length > 0 && duration !== 'Now') parts.push(duration)
  const host = browserDownloadHost(download.url)
  if (host.length > 0) parts.push(host)
  return parts.join(' · ')
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
