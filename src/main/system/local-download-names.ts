/**
 * The file names of the blobs this app's own renderer hands to Chromium.
 *
 * A blob URL ends in a bare UUID, so when one is saved through a surface the
 * page did not draw itself   the media controls' own Download item   Chromium
 * would suggest `3f7a1c9e-4d27-4b1f-9a2c-0b8d7e5f1a33.wav`. The renderer knows
 * what those bytes are, so it registers the name the save dialog should suggest
 * as soon as it creates the URL and forgets it when the URL is revoked; the
 * session guard in `bootstrap/session-guards.ts` reads it back when the save
 * request arrives.
 *
 * The map is deliberately small and bounded: an entry only has to outlive the
 * blob it names, and a renderer that forgets to revoke one cannot grow it.
 */

/** Names beyond this are evicted oldest-first; an app window holds far fewer. */
const MAX_NAMES = 64

const names = new Map<string, string>()

/** Remember, or with `null` forget, the file name a blob URL should be saved as. */
export function rememberLocalDownloadName(url: string, fileName: string | null): void {
  // Re-inserting keeps the eviction order honest for a name that was replaced.
  names.delete(url)
  if (fileName === null) return
  names.set(url, fileName)
  while (names.size > MAX_NAMES) {
    const oldest = names.keys().next()
    if (oldest.done) break
    names.delete(oldest.value)
  }
}

/** The name a blob URL should be saved as, or null when nothing registered one. */
export function localDownloadName(url: string): string | null {
  return names.get(url) ?? null
}
