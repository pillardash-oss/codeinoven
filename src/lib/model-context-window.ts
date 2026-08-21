/**
 * Fill catalog gaps only for stable, documented model families. Harness/native
 * catalog values always win; this table is deliberately conservative so an
 * unknown future model remains unknown instead of inheriting a fabricated cap.
 */
export function fallbackModelContextWindow(harnessId: string, modelId: string): number | undefined {
  const normalized = modelId.toLocaleLowerCase()

  // Muse Code's default is Muse Spark, whose public model family supports a
  // 1M-token window. A discovered Muse catalog still overrides this fallback.
  if (harnessId === 'muse' && (normalized === 'default' || normalized.includes('muse-spark'))) {
    return 1_000_000
  }

  if (/gemini-(?:2\.5|3(?:[.-]|$))/u.test(normalized)) return 1_048_576
  if (/claude-(?:sonnet|opus)-(?:4-6|4-7|4-8|5)(?:-|$)/u.test(normalized)) return 1_000_000
  if (/gpt-oss-(?:20b|120b)/u.test(normalized)) return 131_072
  if (/gpt-4o(?:-|$)/u.test(normalized)) return 128_000
  if (/deepseek-(?:chat|reasoner|v3)/u.test(normalized)) return 128_000

  return undefined
}
