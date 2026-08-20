import type { AppConfig } from '$shared/types'

/** Fallback used until the persisted config loads (mirrors App.svelte defaults). */
const DEFAULT_MAX_DIFF_LINES = 100

let maxDiffLines = $state(DEFAULT_MAX_DIFF_LINES)
let openLocalhostInCioBrowser = $state(true)

/**
 * Reactive slice of the app config for deep components (diff viewers) that do
 * not receive the config via props. App.svelte syncs it whenever the persisted
 * config loads or is patched.
 */
export const appConfigState = {
  get maxDiffLines(): number {
    return maxDiffLines
  },
  get openLocalhostInCioBrowser(): boolean {
    return openLocalhostInCioBrowser
  },
  sync(config: AppConfig): void {
    maxDiffLines = config.maxDiffLines
    openLocalhostInCioBrowser = config.openLocalhostInCioBrowser
  }
}
