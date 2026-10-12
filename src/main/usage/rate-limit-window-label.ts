/**
 * Human label for a provider quota window, from its length in minutes.
 *
 * Shared by the harness usage normalizers that report rolling windows (Codex,
 * the ChatGPT plan usage route, ...) so one window length always reads the same
 * way in the battery popover regardless of which provider reported it.
 */
export function rateLimitWindowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === 300) return '5-hour limit'
  if (minutes === 10_080) return 'Weekly limit'
  if (minutes !== undefined) {
    if (minutes % 1_440 === 0) return `${minutes / 1_440}-day limit`
    if (minutes % 60 === 0) return `${minutes / 60}-hour limit`
    return `${minutes}-minute limit`
  }
  return fallback
}
