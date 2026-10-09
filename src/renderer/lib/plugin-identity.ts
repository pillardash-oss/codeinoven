/**
 * The short mark a plugin shows when its package ships no icon. Most plugin
 * catalogs declare no icon at all, so this is the normal case rather than a
 * fallback for a failed load.
 */
export function pluginInitials(displayName: string): string {
  const words = displayName.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0)
  if (words.length === 0) return '?'
  return words
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join('')
}
