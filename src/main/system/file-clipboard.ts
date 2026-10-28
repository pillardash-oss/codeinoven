import { ClipboardItem, clipboard } from 'electron'
import { pathToFileURL } from 'node:url'
import { Logger } from './logger'

/**
 * Put real files on the OS clipboard, alongside the text the copy stands for.
 *
 * A copy made inside the app has two audiences. Another app (Finder, Mail, a
 * chat client) has to receive the files themselves; a composer in this app has
 * to receive the `@tag` text it renders as a file reference. One pasteboard
 * payload carries both: `text/plain` holds the tags, `text/uri-list` holds the
 * files.
 *
 * `text/uri-list` is the shape that actually works. Chromium expands it into
 * `public.file-url` plus `NSFilenamesPboardType` on macOS and into a native URI
 * list on Linux, and it is the only shape that survives multiple files: writing
 * one `ClipboardItem` per file gets flattened to a single pasteboard item, so
 * only the last file would paste. (Measured on Electron 44/macOS with a
 * NSPasteboard dump; see `.cio/work/file-copy-clipboard/plan.md`.)
 *
 * The text is written even when no file could be resolved, so a copy that loses
 * its file URLs still carries something useful, and the write is never allowed
 * to take the app down over a clipboard the OS refused.
 */
export async function writeFilePathsToClipboard(
  absolutePaths: readonly string[],
  text: string
): Promise<void> {
  const payload: Record<string, string> = {}
  if (text.length > 0) payload['text/plain'] = text
  const urls = absolutePaths.map((path) => toFileUrl(path)).filter(Boolean)
  if (urls.length > 0) payload['text/uri-list'] = urls.join('\r\n')
  if (Object.keys(payload).length === 0) return
  await clipboard.write([new ClipboardItem(payload)])
}

/** A `file://` URL for an absolute path, percent-encoded so a path with spaces
 *  or `#` still pastes as the same file. A path the URL encoder rejects is
 *  skipped rather than written as a URL that points somewhere else. */
function toFileUrl(path: string): string {
  try {
    return pathToFileURL(path).href
  } catch (error) {
    Logger.error('clipboard:fileUrl failed:', error)
    return ''
  }
}
