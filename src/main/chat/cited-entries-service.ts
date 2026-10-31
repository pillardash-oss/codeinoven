import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  CITE_ENTRY_LIMIT,
  citedEntryName,
  normalizeCitedPath,
  type CitedEntry
} from '../../lib/cited-work'
import { isInsideProject } from '../preview/served-folder'

/**
 * Resolve the paths a turn cited into the cards the conversation draws.
 *
 * The turn knows what it produced, the filesystem knows what is still there and
 * when it last changed, so nothing is taken on the turn's word: an entry that no
 * longer exists, escapes the workspace, or is a symbolic link is dropped rather
 * than drawn as a card that opens nothing. Resolution runs when the turn settles,
 * after the writes it cited have landed, which is why the modification time is
 * read here and not when the tool was called.
 */
export async function resolveCitedEntries(
  root: string,
  paths: readonly string[]
): Promise<CitedEntry[]> {
  const entries: CitedEntry[] = []
  const seen = new Set<string>()
  for (const raw of paths) {
    if (entries.length >= CITE_ENTRY_LIMIT) break
    const normalized = normalizeCitedPath(raw)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    const absolute = resolve(root, normalized)
    if (!isInsideProject(resolve(root), absolute)) continue
    const stats = await lstat(absolute).catch(() => null)
    if (!stats || stats.isSymbolicLink()) continue
    if (!stats.isFile() && !stats.isDirectory()) continue
    entries.push({
      name: citedEntryName(normalized),
      path: normalized,
      kind: stats.isDirectory() ? 'directory' : 'file',
      modifiedAt: stats.mtimeMs
    })
  }
  return entries
}
