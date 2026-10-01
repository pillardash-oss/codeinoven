/**
 * What a download record means after the app restarted.
 *
 * A record written by an earlier run describes a download no run is watching, so
 * the only truth left is what is on disk: the bytes that survived (moved aside
 * before the quit, or left in place by a crash) decide whether the download can
 * continue or has to start over. This module is that decision, kept pure so the
 * manager's launch path is a read, a stat and a call rather than a nest of
 * conditions.
 */

import type { BrowserDownloadState } from '../../../lib/ipc-contract'
import type { PersistedBrowserDownload } from './browser-download-store'

/** What the file system says about one record's bytes. */
export interface DownloadDiskFacts {
  /** Bytes at the record's save path, or 0 when the file is not there. */
  saveBytes: number
  /** Bytes in the record's kept-aside file, or 0 when it is not there. */
  stagedBytes: number
}

/**
 * Whether the response said enough about itself to continue it later.
 *
 * Chromium validates the range request of a resumed download with the `ETag` or
 * the `Last-Modified` it already holds (a strong ETag first, then the date). A
 * response that named neither leaves nothing to validate against, and appending
 * bytes from a file the server has since replaced would produce a corrupt one, so
 * such a download is offered a fresh start instead.
 */
export function hasResumeValidator(eTag: string, lastModified: string): boolean {
  return eTag.length > 0 || lastModified.length > 0
}

/** A recovered record: the fields a restart rewrites, and nothing else. */
export interface RecoveredDownloadState {
  state: BrowserDownloadState
  /** The user's own pause survives a restart, because it is their intent and not
   *  a property of the download in flight. */
  paused: boolean
  receivedBytes: number
  progress: number
  resumable: boolean
  error: string
}

/**
 * Reconcile one record against the bytes it left behind.
 *
 * A record that already finished keeps its meaning (a completed download stays
 * completed, a cancelled one stays cancelled). An unfinished one becomes
 * `interrupted`, because no run is downloading it any more, and it is marked
 * resumable exactly when bytes are on disk to continue from. A download whose
 * bytes already add up to its declared length is the one case that is settled as
 * completed: the last byte landed, and only the completion event was lost.
 */
export function recoverDownloadRecord(
  record: PersistedBrowserDownload,
  facts: DownloadDiskFacts
): RecoveredDownloadState {
  if (record.state === 'completed') {
    return {
      state: 'completed',
      paused: false,
      receivedBytes: record.receivedBytes,
      progress: 100,
      // Finished bytes are not a resume point: the file is complete, so Resume is
      // never the action this record offers.
      resumable: false,
      error: ''
    }
  }
  if (record.state === 'cancelled') {
    return {
      state: 'cancelled',
      paused: false,
      receivedBytes: record.receivedBytes,
      progress: record.progress,
      resumable: false,
      error: ''
    }
  }

  // The kept-aside copy is this app's own continuation of the download, so it
  // wins over whatever the save path holds; a crash leaves bytes only at the save
  // path. The offset never exceeds what the manager actually wrote, so a file
  // that was longer before the download started can never be mistaken for
  // downloaded bytes.
  const bytesOnDisk = facts.stagedBytes > 0 ? facts.stagedBytes : facts.saveBytes
  const offset = Math.min(record.receivedBytes, bytesOnDisk)
  const progress = record.totalBytes > 0 ? Math.min(100, (offset / record.totalBytes) * 100) : 0

  if (record.totalBytes > 0 && offset >= record.totalBytes) {
    return {
      state: 'completed',
      paused: false,
      receivedBytes: record.totalBytes,
      progress: 100,
      resumable: false,
      error: ''
    }
  }

  const resumable =
    offset > 0 &&
    record.totalBytes > offset &&
    record.savePath.length > 0 &&
    record.url.length > 0 &&
    hasResumeValidator(record.eTag, record.lastModified)
  if (record.state === 'interrupted' && record.error.length > 0) {
    return {
      state: 'interrupted',
      paused: record.paused,
      receivedBytes: offset,
      progress,
      resumable,
      error: record.error
    }
  }
  return {
    state: 'interrupted',
    paused: record.paused,
    receivedBytes: offset,
    progress,
    resumable,
    error: errorForRecoveredRun(record, resumable)
  }
}

/** The line the user reads when the app itself is why a download stopped. */
function errorForRecoveredRun(record: PersistedBrowserDownload, resumable: boolean): string {
  if (record.paused) return resumable ? '' : 'Its partial file is gone, so it has to start over.'
  if (resumable) return 'The download stopped when CodeInOven closed. Resume it to continue.'
  return 'The download stopped when CodeInOven closed and its partial file is gone, so it has to start over.'
}
