import {
  applyAppearanceTypography,
  DEFAULT_APP_FONT_FAMILY,
  DEFAULT_APP_FONT_WEIGHT,
  DEFAULT_ZOOM_LEVEL,
  normalizeAppFontFamily,
  normalizeAppFontSize,
  normalizeAppFontWeight,
  normalizeZoomLevel,
  type AppearanceTheme
} from '#shared/app-appearance'
import { syncSystemBars } from '#lib/system-bars'

/**
 * How this phone draws the app: the theme, the face, the base size, the weight and
 * the zoom.
 *
 * The choices are the shared table the desktop offers, so the phone is not a
 * second product with its own ideas about type. What differs is where they land:
 * a phone has no main process to zoom its page, so zoom multiplies the root size
 * here and every rem in the stylesheet follows, which magnifies the interface
 * without changing the viewport the shell has to fill.
 *
 * The values live in `localStorage` rather than Capacitor's Preferences because
 * the first frame reads them synchronously in `app.html`, before any store has
 * run: a dark phone that opens light reads as a bug.
 */

const KEY = 'cio.mobile.appearance'

/**
 * The phone's own baseline. Both clients scale every rem from the base size, but
 * their stylesheets were drawn against different ones: the desktop's at 15px, the
 * phone's at the browser's 16px. The range is shared; the starting point is not.
 */
const BASE_FONT_SIZE = 16

interface StoredAppearance {
  theme?: unknown
  fontFamily?: unknown
  appFontSize?: unknown
  fontWeight?: unknown
  zoomLevel?: unknown
}

export interface AppearanceChoices {
  theme: AppearanceTheme
  fontFamily: string
  appFontSize: number
  fontWeight: number
  zoomLevel: number
}

function read(): StoredAppearance {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as StoredAppearance) : {}
  } catch {
    // A phone with no storage, or one holding a broken record, still draws.
    return {}
  }
}

function themeFrom(value: unknown): AppearanceTheme {
  return value === 'dark' || value === 'light' ? value : 'system'
}

class AppearanceStore {
  theme = $state<AppearanceTheme>('system')
  fontFamily = $state(DEFAULT_APP_FONT_FAMILY)
  appFontSize = $state(BASE_FONT_SIZE)
  fontWeight = $state(DEFAULT_APP_FONT_WEIGHT)
  zoomLevel = $state(DEFAULT_ZOOM_LEVEL)

  /** What the reader chose, in one shape a screen can read and a document can persist. */
  get choices(): AppearanceChoices {
    return {
      theme: this.theme,
      fontFamily: this.fontFamily,
      appFontSize: this.appFontSize,
      fontWeight: this.fontWeight,
      zoomLevel: this.zoomLevel
    }
  }

  /** Read the stored choices once, at start-up, before the first screen draws. */
  restore(): void {
    const stored = read()
    this.theme = themeFrom(stored.theme)
    this.fontFamily = normalizeAppFontFamily(stored.fontFamily)
    this.appFontSize =
      stored.appFontSize === undefined ? BASE_FONT_SIZE : normalizeAppFontSize(stored.appFontSize)
    this.fontWeight = normalizeAppFontWeight(stored.fontWeight)
    this.zoomLevel = normalizeZoomLevel(stored.zoomLevel)
  }

  /** Change one choice, draw it, and keep it for the next open. */
  set(patch: Partial<AppearanceChoices>): void {
    if (patch.theme !== undefined) this.theme = patch.theme
    if (patch.fontFamily !== undefined) this.fontFamily = normalizeAppFontFamily(patch.fontFamily)
    if (patch.appFontSize !== undefined) this.appFontSize = normalizeAppFontSize(patch.appFontSize)
    if (patch.fontWeight !== undefined) this.fontWeight = normalizeAppFontWeight(patch.fontWeight)
    if (patch.zoomLevel !== undefined) this.zoomLevel = normalizeZoomLevel(patch.zoomLevel)
    this.apply()
  }

  /** Write the choices onto the document. Safe to call more than once. */
  apply(): void {
    const root = document.documentElement
    root.classList.remove('dark', 'light')
    if (this.theme === 'dark') root.classList.add('dark')
    if (this.theme === 'light') root.classList.add('light')
    // The platform draws form controls and scrollbars from this, and the system
    // bars read it through syncSystemBars.
    root.style.colorScheme = this.theme === 'system' ? 'light dark' : this.theme
    applyAppearanceTypography(root, {
      fontFamily: this.fontFamily,
      appFontSize: this.appFontSize,
      fontWeight: this.fontWeight,
      zoomLevel: this.zoomLevel
    })
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(this.choices))
    } catch {
      // A phone with no storage still holds the choice for this session.
    }
    void syncSystemBars()
  }
}

export const appearance = new AppearanceStore()
