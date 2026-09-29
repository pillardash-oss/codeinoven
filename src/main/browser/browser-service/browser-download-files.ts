/**
 * The bytes of a download that is not finished, and how they are kept.
 *
 * Chromium writes a download straight into the file the user chose, and it
 * deletes that file whenever the download is cancelled or the process that
 * owned it exits (verified on Electron 44: pausing does not save it, and a
 * session teardown removes it even when nothing was done to the item). The
 * bytes therefore have to be *moved* somewhere Chromium will not touch before
 * the app quits, or a download cannot be resumed on the next launch.
 *
 * A download's kept bytes live next to the file the user chose, under
 * {@link STAGED_DOWNLOAD_SUFFIX}, so the move is a rename on one filesystem and
 * the staged copy of a big download can never fill a different volume.
 *
 * Every operation here answers with what happened instead of throwing: a
 * download is user data on a user's disk (an unmounted volume, a removed
 * folder, a read-only file), and none of those may break the download manager.
 */

import { copyFile, rename, rm, stat } from 'node:fs/promises'
import { Logger } from '../../system/logger'

/** Suffix of the file a stopped download's bytes are kept in, beside the target. */
export const STAGED_DOWNLOAD_SUFFIX = '.codeinoven-part'

/** Where a download's kept bytes live for the given target path. */
export function stagedDownloadPath(savePath: string): string {
  return `${savePath}${STAGED_DOWNLOAD_SUFFIX}`
}

/**
 * Size of a file in bytes, or 0 when it is missing or unreadable. Zero is the
 * honest answer for every caller here: a file that cannot be measured cannot be
 * resumed from, and every resume path already treats "no bytes" as such.
 */
export async function fileSizeOf(path: string): Promise<number> {
  if (path.length === 0) return 0
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

/** Remove a file, ignoring the case where there is nothing to remove. */
export async function removeFileQuietly(path: string): Promise<void> {
  if (path.length === 0) return
  try {
    await rm(path, { force: true })
  } catch (error: unknown) {
    Logger.error('A partial download file could not be removed:', error)
  }
}

/**
 * Move a download's partial bytes out of Chromium's reach, so a quit keeps them.
 *
 * A rename is the normal path (instant, same filesystem, no extra disk use).
 * Every step is prepared for the case where the move fails (paused on Windows,
 * a cross-device path, a locked file), an empty file, and a download whose
 * target was deleted by hand: this runs while the app is quitting, so it may
 * never throw and may never wait.
 */
export async function stagePartialDownload(savePath: string): Promise<string> {
  const stagedPath = stagedDownloadPath(savePath)
  const bytes = await fileSizeOf(savePath)
  await removeFileQuietly(stagedPath)
  if (bytes === 0) return ''
  try {
    await rename(savePath, stagedPath)
    return stagedPath
  } catch (error: unknown) {
    // A copy would leave the original for Chromium to delete, which is still a
    // correct outcome: the staged copy is what the next launch resumes from.
    try {
      await copyFile(savePath, stagedPath)
      return stagedPath
    } catch (copyError: unknown) {
      Logger.error('A partial download could not be kept for a later resume:', copyError, error)
      return ''
    }
  }
}

/**
 * Put kept bytes back at a download's target path, so Chromium can append to
 * them.
 *
 * Whatever sits at the target now is replaced: the user already agreed to that
 * path in the save dialog, and the bytes being restored are the download's own
 * continuation. Answers with the number of bytes now at the target (0 when
 * nothing could be restored), which is the offset a resume may start from.
 */
export async function restoreStagedDownload(stagedPath: string, savePath: string): Promise<number> {
  const bytes = await fileSizeOf(stagedPath)
  if (bytes === 0) return 0
  try {
    await rm(savePath, { force: true })
    await rename(stagedPath, savePath)
    return bytes
  } catch (error: unknown) {
    try {
      await copyFile(stagedPath, savePath)
      await removeFileQuietly(stagedPath)
      return await fileSizeOf(savePath)
    } catch (copyError: unknown) {
      Logger.error('Kept partial download bytes could not be restored:', copyError, error)
      return 0
    }
  }
}
