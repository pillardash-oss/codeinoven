import { getVSIFileIcon, getVSIFolderIcon } from '@baybreezy/file-extension-icon'
import { CIO_FOLDER_ICON_CLOSED, CIO_FOLDER_ICON_OPEN } from './cio-folder-icons'

// The VSCode Icons theme always returns a generic icon when a path or folder
// name has no specific match. Resolve it once from a guaranteed-unknown input so
// callers can keep a richer category-based fallback (Lucide) instead.
const GENERIC_FILE_ICON = getVSIFileIcon('__codeinoven__no_specific_icon__')
const GENERIC_FOLDER_ICON = getVSIFolderIcon('__codeinoven__no_specific_icon__')
const GENERIC_FOLDER_ICON_OPEN = getVSIFolderIcon('__codeinoven__no_specific_icon__', true)

// Base64-encoding the resolved SVG on every render is wasteful for file trees
// with many rows, so cache resolved data-URIs keyed by the raw input.
const fileCache = new Map<string, string | null>()
const folderCache = new Map<string, string | null>()
const inlineFileCache = new Map<string, string>()
const inlineFolderCache = new Map<string, string>()

/**
 * Resolve a VSCode Icons data-URI for a file path (matched by exact filename or
 * extension), or `null` when only the generic file icon applies — letting the
 * caller fall back to a category-based Lucide icon.
 */
export function getFileTypeIconDataUri(path: string): string | null {
  const cached = fileCache.get(path)
  if (cached !== undefined) return cached
  const icon = getVSIFileIcon(path)
  const result = icon === GENERIC_FILE_ICON ? null : icon
  fileCache.set(path, result)
  return result
}

/**
 * Resolve a VSCode Icons data-URI for a folder name (matched by folder name,
 * e.g. `node_modules`, `src`, `api`), or `null` when only the generic folder
 * icon applies — letting the caller fall back to a Lucide folder icon.
 */
export function getFolderTypeIconDataUri(name: string, open = false): string | null {
  if (name.toLowerCase() === '.cio') {
    return open ? CIO_FOLDER_ICON_OPEN : CIO_FOLDER_ICON_CLOSED
  }
  const key = `${open ? 'open' : 'closed'}:${name}`
  const cached = folderCache.get(key)
  if (cached !== undefined) return cached
  const icon = getVSIFolderIcon(name, open)
  const generic = open ? GENERIC_FOLDER_ICON_OPEN : GENERIC_FOLDER_ICON
  const result = icon === generic ? null : icon
  folderCache.set(key, result)
  return result
}

/** Resolve the complete colored file icon used by compact inline badges. */
export function getInlineFileTypeIconDataUri(path: string): string {
  const cached = inlineFileCache.get(path)
  if (cached) return cached
  const icon = getVSIFileIcon(path)
  inlineFileCache.set(path, icon)
  return icon
}

/** Resolve the complete colored folder icon used by compact inline badges. */
export function getInlineFolderTypeIconDataUri(name: string): string {
  if (name.toLowerCase() === '.cio') return CIO_FOLDER_ICON_CLOSED
  const cached = inlineFolderCache.get(name)
  if (cached) return cached
  const icon = getVSIFolderIcon(name)
  inlineFolderCache.set(name, icon)
  return icon
}
