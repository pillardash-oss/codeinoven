/**
 * One download as `chrome.downloads` describes it.
 *
 * Electron compiles the `downloads` namespace out of the extension runtime
 * entirely, so a download manager extension (AB Download Manager, and every
 * other capture-by-extension tool) has no way to see a download this browser
 * started, and no way to take it over. The app's download manager owns every
 * download instead, and hands each one to an installed extension in the shapes
 * the API documents, so a listener written against Chrome runs here unmodified.
 *
 * Kept apart from the manager because it is pure translation: state names, ids
 * and paths, with no download lifecycle in it.
 */

import type { BrowserDownload } from '../../../lib/ipc-contract'

/** The `state` a `chrome.downloads.DownloadItem` reports. The API has no
 *  "cancelled" state: a cancellation arrives as a settled `interrupted` item
 *  whose `error` is `USER_CANCELED`, which is how a listener tells them apart. */
export type BrowserDownloadExtensionState = 'in_progress' | 'complete' | 'interrupted'

/**
 * The `chrome.downloads.DownloadItem` an extension receives.
 *
 * `filename` is the absolute path the API promises, because that is what a
 * download manager pastes into its own queue; `url`/`finalUrl` are the transfer's
 * address, which is the whole point of letting the extension see it.
 */
export interface BrowserDownloadExtensionItem {
  id: number
  url: string
  finalUrl: string
  filename: string
  mime: string
  startTime: string
  state: BrowserDownloadExtensionState
  paused: boolean
  error: string
  canResume: boolean
  bytesReceived: number
  totalBytes: number
  fileSize: number
  danger: 'safe'
  exists: boolean
}

/**
 * The item for one tracked download, under the numeric id the extension uses to
 * call back into `chrome.downloads.cancel`, `pause`, `resume` and `erase`.
 */
export function extensionDownloadItem(
  download: BrowserDownload,
  id: number
): BrowserDownloadExtensionItem {
  const finished = download.state === 'completed'
  const state: BrowserDownloadExtensionState =
    download.state === 'progressing' ? 'in_progress' : finished ? 'complete' : 'interrupted'
  // Chrome reports a cancellation as an interrupted transfer the user caused, and
  // a failure as a network one. An extension that only reads `error` to decide
  // whether to offer a retry gets the same answer it would from Chrome.
  const error =
    download.state === 'cancelled'
      ? 'USER_CANCELED'
      : download.state === 'interrupted'
        ? 'NETWORK_FAILED'
        : ''
  return {
    id,
    url: download.url,
    finalUrl: download.url,
    filename: download.savePath,
    mime: download.mimeType,
    startTime: new Date(download.startedAt).toISOString(),
    state,
    paused: download.paused,
    error,
    canResume: download.resumable,
    bytesReceived: download.receivedBytes,
    totalBytes: download.totalBytes,
    fileSize: finished ? download.receivedBytes : 0,
    danger: 'safe',
    exists: finished && download.savePath.length > 0
  }
}
