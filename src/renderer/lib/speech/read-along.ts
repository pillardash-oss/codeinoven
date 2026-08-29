/**
 * Char offset into `text` that advances whole words as the spoken fraction
 * grows, so the read-along highlight never cuts a word in half. A word counts
 * as spoken once the playhead passes its start.
 */
export function spokenWordOffset(text: string, progress: number): number {
  if (progress >= 1) return text.length
  if (progress <= 0) return 0
  const cut = text.length * progress
  let offset = 0
  for (const part of text.split(/(\s+)/u)) {
    if (/^\s+$/u.test(part)) {
      offset += part.length
      continue
    }
    if (offset >= cut) break
    offset += part.length
  }
  return offset
}
