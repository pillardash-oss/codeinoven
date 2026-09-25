import { invoke } from '$lib/ipc.svelte'
import type { InstalledSkillLocation } from '$shared/types'

/** Session bookkeeping: one in-flight load, and one successful load is enough. */
let loaded = false
let pending: Promise<void> | null = null

/**
 * Where marketplace skills are already installed.
 *
 * The state comes from main (the utility registry plus the skill folders on
 * disk) rather than from a renderer flag, so a skill installed in an earlier
 * session still reads as installed. Every marketplace surface shares this one
 * store, which keeps the install a single cheap refresh instead of one probe
 * per list row.
 */
class InstalledSkillStore {
  /** Every recorded install location, across all marketplace skills. */
  locations = $state<InstalledSkillLocation[]>([])
  loading = $state(false)
  error = $state('')

  /** Install locations recorded for one marketplace skill. */
  locationsFor(skillId: string): InstalledSkillLocation[] {
    return this.locations.filter((location) => location.skillId === skillId)
  }

  isInstalled(skillId: string): boolean {
    return this.locations.some((location) => location.skillId === skillId)
  }

  /** Loads at most once per session; concurrent callers share one request. */
  ensureLoaded(): Promise<void> {
    if (loaded) return Promise.resolve()
    return this.refresh()
  }

  /** Re-reads the install locations, e.g. right after an install succeeded. */
  refresh(): Promise<void> {
    if (pending) return pending
    this.loading = true
    pending = invoke('utilities:installedSkillLocations')
      .then((locations) => {
        this.locations = locations
        this.error = ''
        loaded = true
      })
      .catch((loadError: unknown) => {
        this.error =
          loadError instanceof Error ? loadError.message : 'Installed skills could not be read.'
      })
      .finally(() => {
        this.loading = false
        pending = null
      })
    return pending
  }
}

export const installedSkillState = new InstalledSkillStore()
