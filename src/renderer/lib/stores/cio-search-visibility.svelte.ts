import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.cioSearchVisibility.v1`

function load(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    // Storage unavailable — fall back to including .cio files.
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
  includeCio = $state<boolean>(load())

  setIncludeCio(value: boolean): void {
    this.includeCio = value
    this.persist()
  }

  private persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, this.includeCio ? 'on' : 'off')
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
