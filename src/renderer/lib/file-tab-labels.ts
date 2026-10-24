/** Resolve duplicate filenames with at most two parent folders, in linear time. */
export function fileTabLabels(paths: readonly string[]): Map<string, string> {
  const parts = new Map(paths.map((path) => [path, path.split(/[\\/]/).filter(Boolean)]))
  const counts = [new Map<string, number>(), new Map<string, number>()]
  for (const segments of parts.values()) {
    for (let depth = 1; depth <= 2; depth++) {
      const suffix = segments.slice(-depth).join('/')
      counts[depth - 1].set(suffix, (counts[depth - 1].get(suffix) ?? 0) + 1)
    }
  }
  return new Map(
    [...parts].map(([path, segments]) => {
      let depth = 1
      while (depth < 3 && (counts[depth - 1].get(segments.slice(-depth).join('/')) ?? 0) > 1) {
        depth++
      }
      return [path, segments.slice(-depth).join('/')]
    })
  )
}
