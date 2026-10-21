/** Mutually exclusive, path-based categories. Tests take precedence over components. */
export interface ChangeBreakdown {
  totalFiles: number
  categories: { label: string; files: number; percentage: number }[]
}

/** Self-contained so the Node worker can execute the same classifier as web workers. */
export function buildChangeBreakdown(paths: string[]): ChangeBreakdown {
  const labels = [
    'Tests',
    'Components',
    'Documentation',
    'Configuration',
    'Styles',
    'Assets',
    'Source',
    'Other'
  ]
  const counts = new Array<number>(labels.length).fill(0)
  const unique = new Set(paths.map((path) => path.replaceAll('\\', '/')))
  for (const original of unique) {
    const path = original.toLowerCase()
    const name = path.split('/').at(-1) ?? path
    const extension = name.split('.').at(-1) ?? ''
    let category: number
    if (
      /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|fixtures)(\/|$)/.test(path) ||
      /(^|[._-])(test|spec)([._-]|$)/.test(name) ||
      /_test\.(go|rs|py)$/.test(name) ||
      /^test_.*\.py$/.test(name)
    )
      category = 0
    else if (
      ['svelte', 'vue', 'jsx', 'tsx'].includes(extension) ||
      (/(^|\/)components\//.test(path) && ['ts', 'js'].includes(extension))
    )
      category = 1
    else if (
      ['md', 'mdx', 'rst', 'txt', 'adoc'].includes(extension) ||
      /^(readme|license|changelog|contributing)(\.|$)/.test(name)
    )
      category = 2
    else if (
      ['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'lock'].includes(extension) ||
      /(^|\.)(config|rc)(\.|$)/.test(name) ||
      /^\.[a-z]+rc(\.|$)/.test(name) ||
      /^(\.env|\.gitignore|\.gitattributes|dockerfile|makefile|bun\.lockb)/.test(name)
    )
      category = 3
    else if (['css', 'scss', 'sass', 'less', 'styl'].includes(extension)) category = 4
    else if (
      [
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'svg',
        'ico',
        'avif',
        'mp4',
        'webm',
        'mov',
        'mp3',
        'wav',
        'ogg',
        'woff',
        'woff2',
        'ttf',
        'otf'
      ].includes(extension)
    )
      category = 5
    else if (
      [
        'ts',
        'js',
        'mjs',
        'cjs',
        'mts',
        'cts',
        'py',
        'go',
        'rs',
        'c',
        'cpp',
        'h',
        'hpp',
        'java',
        'kt',
        'swift',
        'rb',
        'php',
        'sh',
        'sql',
        'html',
        'ex',
        'exs',
        'cs',
        'dart'
      ].includes(extension)
    )
      category = 6
    else category = 7
    counts[category] += 1
  }
  return {
    totalFiles: unique.size,
    categories: labels.flatMap((label, index) =>
      counts[index]
        ? [
            {
              label,
              files: counts[index],
              percentage: Number(((counts[index] / unique.size) * 100).toFixed(1))
            }
          ]
        : []
    )
  }
}

export function formatChangeSummary(
  breakdown: ChangeBreakdown | undefined | null,
  totals?: { additions: number; deletions: number; partial?: boolean } | null,
  fileCount = breakdown?.totalFiles ?? 0
): string {
  return [
    totals
      ? `Lines +${totals.additions} −${totals.deletions}${totals.partial ? ' (partial)' : ''}`
      : null,
    `Total ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`,
    ...(breakdown?.categories.map(
      (category) =>
        `${category.label} ${category.percentage}% (${category.files} ${category.files === 1 ? 'file' : 'files'})`
    ) ?? [])
  ]
    .filter(Boolean)
    .join(' · ')
}
