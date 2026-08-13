/**
 * Extract model slugs from `agy models` across the old bare-slug format and
 * the current tab-separated `slug<TAB>display name` format.
 */
export function antigravityModelSlugs(output: string): string[] {
  const slugs: string[] = []
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || /^error\b/iu.test(line)) continue
    const tab = line.indexOf('\t')
    const slug = (tab === -1 ? line : line.slice(0, tab)).trim()
    if (/^[a-z0-9][a-z0-9.-]*$/iu.test(slug)) slugs.push(slug)
  }
  return slugs
}
