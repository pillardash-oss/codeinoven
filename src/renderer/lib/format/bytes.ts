/**
 * Human byte counts, shared by every surface that reports a size.
 *
 * Kept out of the sound settings helpers it grew up in: a cleanup run, a model
 * download and a browser download all report the same numbers, and none of them
 * should have to import a speech module to do it.
 */
const KIB = 1024
const MIB = KIB ** 2
const GIB = KIB ** 3
const TIB = KIB ** 4
const PIB = KIB ** 5

export function formatBytes(bytes: number): string {
  if (bytes < KIB) return `${bytes} B`
  if (bytes < MIB) return `${(bytes / KIB).toFixed(1)} KB`
  if (bytes < GIB) return `${(bytes / MIB).toFixed(1)} MB`
  if (bytes < TIB) return `${(bytes / GIB).toFixed(2)} GB`
  if (bytes < PIB) return `${(bytes / TIB).toFixed(2)} TB`
  return `${(bytes / PIB).toFixed(2)} PB`
}
