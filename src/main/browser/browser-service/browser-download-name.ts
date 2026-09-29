/**
 * What a download is called on screen.
 *
 * Chromium's `DownloadItem.getFilename()` is the name it *suggested* (the
 * `download` attribute, a `Content-Disposition`, or the URL's last segment), and
 * it keeps answering with that suggestion after the user renames the file in the
 * save dialog: the chosen name only ever appears in `getSavePath()`. Verified on
 * Electron 44 (`.cio/tmp/download-name-probe`): with the file saved as
 * `my-own-name.png`, `getFilename()` still returned `vacation-photo.png` at every
 * point of the download, from the dialog's answer to `done`.
 *
 * The path is therefore the truth as soon as it exists, and the suggestion is
 * only the answer while the save dialog is still open. Without this, a download
 * the user renamed sits in the list under a name no file on their disk has.
 */

import { safeBasename } from './browser-validation'

/**
 * The name to show for a download: the last segment of the file the user chose,
 * or Chromium's suggestion while there is no chosen path yet.
 */
export function downloadFileName(suggested: string, savePath: string): string {
  const chosen = lastPathSegment(savePath)
  if (chosen.length === 0) return suggested
  return safeBasename(chosen)
}

/**
 * The last segment of a path, splitting on both separators so a Windows path is
 * read correctly whatever platform this runs on (`node:path.basename` only knows
 * the separator of the platform it is running on).
 */
function lastPathSegment(savePath: string): string {
  const cut = Math.max(savePath.lastIndexOf('/'), savePath.lastIndexOf('\\'))
  return savePath.slice(cut + 1)
}
