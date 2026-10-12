/** A product screen follows the same root-or-one-subfolder convention as the board. */
export function isDesignScreenEntry(entry: string): boolean {
  const parts = entry.split('/')
  return (
    parts.length <= 2 &&
    parts.every(
      (part) =>
        part !== '' && !part.startsWith('.') && !part.startsWith('_') && !part.includes('\\')
    ) &&
    /\.html$/iu.test(entry) &&
    entry !== 'canvas.html'
  )
}

/** Present screens as products rather than source paths. */
export function designScreenName(entry: string): string {
  return entry
    .replace(/\.html$/iu, '')
    .split('/')
    .map((part) => part.replace(/[-_]+/gu, ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase()))
    .join(' / ')
}

/** Resolve only a screen on this authored folder's own preview origin. */
export function designScreenEntryFromUrl(url: string, origin: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== origin) return null
    let entry = decodeURIComponent(parsed.pathname).slice(1)
    if (entry === '' || entry.endsWith('/')) entry += 'index.html'
    return isDesignScreenEntry(entry) ? entry : null
  } catch {
    return null
  }
}
