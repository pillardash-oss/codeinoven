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

export function browserDownloadStateLabel(download: BrowserDownload): string {
  if (download.state === 'completed') return 'Completed'
  if (download.state === 'cancelled') return 'Cancelled'
  if (download.state === 'interrupted') return 'Interrupted'
  return download.paused ? 'Paused' : 'Downloading'
}

export function browserDownloadTone(
  download: BrowserDownload
): 'success' | 'danger' | 'warning' | 'neutral' | 'info' {
  if (download.state === 'completed') return 'success'
  if (download.state === 'cancelled') return 'neutral'
  if (download.state === 'interrupted') return 'danger'
  return download.paused ? 'warning' : 'info'
}
