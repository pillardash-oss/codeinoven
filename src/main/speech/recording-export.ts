import { dialog } from '../system/file-dialogs'
/**
 * Save a stored recording to a path the user picks.
 *
 * The bytes written are the bytes playback served: the container sniffing and
 * the one-time ffmpeg conversion in `playback-audio.ts` decide what a recording
 * is played *as*, and what the user saves has to be that same media, with the
 * extension that goes with it.
 *
 * The save happens through a native dialog in the main process, never through a
 * renderer download. Downloads this app's renderer starts are denied at the
 * session level (see `bootstrap/session-guards.ts`), which is why the old
 * anchor-based Download button did nothing at all: Chromium cancelled the
 * request with no dialog and no file.
 */

import { BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { SpeechPlaybackAudio } from '../../lib/speech/types'

/**
 * Write a recording's playable bytes to the path the user chooses.
 *
 * Resolves to that path, or null when the user cancelled the dialog. A save
 * that cannot be written throws, so a failure is never reported as a cancel.
 */
export async function saveRecordingAs(
  attemptId: string,
  audio: SpeechPlaybackAudio
): Promise<string | null> {
  const extension = audio.extension.startsWith('.') ? audio.extension : `.${audio.extension}`
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  if (win && !win.isFocused()) win.focus()
  const options: Electron.SaveDialogOptions = {
    title: 'Save recording',
    defaultPath: `recording-${attemptId}${extension}`,
    filters: [
      { name: `${extension.slice(1).toUpperCase()} audio`, extensions: [extension.slice(1)] }
    ]
  }
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, audio.bytes)
  return result.filePath
}
