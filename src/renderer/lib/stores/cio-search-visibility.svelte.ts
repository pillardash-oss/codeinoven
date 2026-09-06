import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.cioSearchVisibility.v1`
const IGNORED_STORAGE_KEY = `${APP_SLUG}.ignoredSearchVisibility.v1`

function loadFlag(key: string): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(key) !== 'off'
  } catch {
    // Storage unavailable — fall back to including everything.
    return true
  }
}

/**
 * Whether `.cio` scratch entries participate in file search surfaces (the
 * composer @ tag search and the file explorer search). Persisted app-wide in
 * localStorage, so the last toggled state survives across threads and
 * projects until the user flips the switch again.
 */
class CioSearchVisibilityStore {
  includeCio = $state<boolean>(loadFlag(STORAGE_KEY))
  /** Whether git-ignored entries participate in file search surfaces. */
  includeIgnored = $state<boolean>(loadFlag(IGNORED_STORAGE_KEY))

  setIncludeCio(value: boolean): void {
    this.includeCio = value
    this.persist(STORAGE_KEY, value)
  }

  setIncludeIgnored(value: boolean): void {
    this.includeIgnored = value
    this.persist(IGNORED_STORAGE_KEY, value)
  }

  private persist(key: string, value: boolean): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, value ? 'on' : 'off')
    } catch {
      // The preference is optional; unavailable storage must not break search.
    }
  }
}

export const cioSearchVisibility = new CioSearchVisibilityStore()

/** Whether a project-relative path lives inside the `.cio` scratch directory. */
export function isCioScratchPath(path: string): boolean {
  return path === '.cio' || path.startsWith('.cio/')
}

/** Whether a search-result entry must be hidden for the current visibility
 *  preferences (scratch paths and/or git-ignored entries). */
export function isEntryHiddenByVisibility(path: string, ignored?: boolean): boolean {
  if (!cioSearchVisibility.includeCio && isCioScratchPath(path)) return true
  return !cioSearchVisibility.includeIgnored && ignored === true
}
