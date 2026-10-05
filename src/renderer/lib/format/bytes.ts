/**
 * Human byte counts, shared by every surface that reports a size.
 *
 * Kept out of the sound settings helpers it grew up in: a cleanup run, a model
 * download and a browser download all report the same numbers, and none of them
 * should have to import a speech module to do it.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`
}
