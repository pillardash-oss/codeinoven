import { APP_SLUG } from '$shared/brand'

const HIDE_BUILT_IN_KEY = `${APP_SLUG}.utilitiesHideBuiltIn.v1`

function loadHideBuiltIn(): boolean {
  if (typeof window === 'undefined') return false
  try {
    // The filter starts off, so only an explicit "on" hides built-ins.
    return window.localStorage.getItem(HIDE_BUILT_IN_KEY) === 'on'
  } catch {
    // Storage unavailable — keep every built-in visible.
    return false
  }
}

/**
 * View preferences for the Utilities catalog. They persist app-wide in
 * localStorage, so a filter the user set survives closing Settings and
 * restarting the app.
 */
class UtilitiesViewPrefs {
  /** Whether utilities built into CodeInOven are filtered out of the catalog. */
  hideBuiltIn = $state<boolean>(loadHideBuiltIn())

  setHideBuiltIn(value: boolean): void {
    this.hideBuiltIn = value
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(HIDE_BUILT_IN_KEY, value ? 'on' : 'off')
    } catch {
      // The preference is optional; unavailable storage must not break the page.
    }
  }
}

export const utilitiesViewPrefs = new UtilitiesViewPrefs()
