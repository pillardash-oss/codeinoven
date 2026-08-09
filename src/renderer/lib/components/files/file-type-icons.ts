import { CIO_FOLDER_ICON_CLOSED, CIO_FOLDER_ICON_OPEN } from './cio-folder-icons'

type FileExtensionIcons = typeof import('@baybreezy/file-extension-icon')

let iconLibraryPromise: Promise<FileExtensionIcons> | null = null

/** The icon database is several megabytes of generated SVG mappings. Keep it
 * outside the desktop startup closure and load it only when a file/folder icon
 * is actually visible. The shared promise coalesces simultaneous tree rows. */
function loadIconLibrary(): Promise<FileExtensionIcons> {
  iconLibraryPromise ??= import('@baybreezy/file-extension-icon')
  return iconLibraryPromise
}

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
export async function getFileTypeIconDataUri(path: string): Promise<string | null> {
  const cached = fileCache.get(path)
  if (cached !== undefined) return cached
  const { getVSIFileIcon } = await loadIconLibrary()
  const icon = getVSIFileIcon(path)
  const generic = getVSIFileIcon('__codeinoven__no_specific_icon__')
  const result = icon === generic ? null : icon
  fileCache.set(path, result)
  return result
}

/**
 * Resolve a VSCode Icons data-URI for a folder name (matched by folder name,
 * e.g. `node_modules`, `src`, `api`), or `null` when only the generic folder
 * icon applies — letting the caller fall back to a Lucide folder icon.
 */
export async function getFolderTypeIconDataUri(name: string, open = false): Promise<string | null> {
  if (name.toLowerCase() === '.cio') {
    return open ? CIO_FOLDER_ICON_OPEN : CIO_FOLDER_ICON_CLOSED
  }
  const key = `${open ? 'open' : 'closed'}:${name}`
  const cached = folderCache.get(key)
  if (cached !== undefined) return cached
  const { getVSIFolderIcon } = await loadIconLibrary()
  const icon = getVSIFolderIcon(name, open)
  const generic = getVSIFolderIcon('__codeinoven__no_specific_icon__', open)
  const result = icon === generic ? null : icon
  folderCache.set(key, result)
  return result
}

/** Resolve the complete colored file icon used by compact inline badges. */
export async function getInlineFileTypeIconDataUri(path: string): Promise<string> {
  const cached = inlineFileCache.get(path)
  if (cached) return cached
  const { getVSIFileIcon } = await loadIconLibrary()
  const icon = getVSIFileIcon(path)
  inlineFileCache.set(path, icon)
  return icon
}

/** Resolve the complete colored folder icon used by compact inline badges. */
export async function getInlineFolderTypeIconDataUri(name: string): Promise<string> {
  if (name.toLowerCase() === '.cio') return CIO_FOLDER_ICON_CLOSED
  const cached = inlineFolderCache.get(name)
  if (cached) return cached
  const { getVSIFolderIcon } = await loadIconLibrary()
  const icon = getVSIFolderIcon(name)
  inlineFolderCache.set(name, icon)
  return icon
}
