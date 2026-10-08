import { APP_SLUG } from '$shared/brand'

const HIDE_BUILT_IN_KEY = `${APP_SLUG}.utilitiesHideBuiltIn.v1`
const FOLDED_VENDORS_KEY = `${APP_SLUG}.utilitiesFoldedVendors.v1`

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

function loadFoldedVendors(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(FOLDED_VENDORS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    // A corrupt or unavailable preference must not break the page.
    return []
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

  /**
   * Vendor ids whose group is folded. Ids are the stable `<kind>:<identity>`
   * keys the vendor resolver produces, so a fold survives the group being
   * rebuilt from a fresh catalog read.
   */
  #foldedVendors = $state<string[]>(loadFoldedVendors())

  setHideBuiltIn(value: boolean): void {
    this.hideBuiltIn = value
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(HIDE_BUILT_IN_KEY, value ? 'on' : 'off')
    } catch {
      // The preference is optional; unavailable storage must not break the page.
    }
  }

  /** Whether the given vendor group is folded (its rows hidden). */
  isVendorFolded(vendorId: string): boolean {
    return this.#foldedVendors.includes(vendorId)
  }

  toggleVendorFold(vendorId: string): void {
    this.#foldedVendors = this.#foldedVendors.includes(vendorId)
      ? this.#foldedVendors.filter((id) => id !== vendorId)
      : [...this.#foldedVendors, vendorId]
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(FOLDED_VENDORS_KEY, JSON.stringify(this.#foldedVendors))
    } catch {
      // The preference is optional; unavailable storage must not break the page.
    }
  }
}

export const utilitiesViewPrefs = new UtilitiesViewPrefs()
