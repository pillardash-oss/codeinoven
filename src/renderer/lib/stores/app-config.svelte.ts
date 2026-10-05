import {
  DEFAULT_BROWSER_HIBERNATION_MINUTES,
  DEFAULT_BROWSER_HISTORY_LIMIT,
  DEFAULT_IN_APP_NOTIFICATION_SOUND
} from '$shared/types'
import type {
  AppConfig,
  GitPullPreference,
  InAppNotificationSoundSettings,
  MediaGenerationConfig,
  ModelProfile
} from '$shared/types'
import { findBrowserSearchEngine, type BrowserSearchEngine } from '$shared/browser-search-engines'
import { keymapState } from '$lib/keymap/keymap-state.svelte'
import { publishBrowserSearchEngine } from '$lib/browser-search-context'
import {
  DEFAULT_APP_FONT_FAMILY,
  DEFAULT_APP_FONT_SIZE,
  DEFAULT_APP_FONT_WEIGHT,
  applyAppTypography
} from '$lib/app-typography'
import { isBrowserLoaded } from '$lib/stores/browser-access.svelte'

/** Fallback used until the persisted config loads (mirrors App.svelte defaults). */
const DEFAULT_MAX_DIFF_LINES = 100
const DEFAULT_ZOOM_LEVEL = 1

let maxDiffLines = $state(DEFAULT_MAX_DIFF_LINES)
let browserHibernationMinutes = $state(DEFAULT_BROWSER_HIBERNATION_MINUTES)
let browserHistoryLimit = $state(DEFAULT_BROWSER_HISTORY_LIMIT)
let openLocalhostInCioBrowser = $state(true)
let openAllLinksInCioBrowser = $state(false)
let browserSearchEngineId = $state('')
let browserCustomSearchEngines = $state<BrowserSearchEngine[]>([])
let inAppNotificationSound = $state<InAppNotificationSoundSettings>(
  structuredClone(DEFAULT_IN_APP_NOTIFICATION_SOUND)
)
let defaultPullStrategy = $state<GitPullPreference>('ask')
let fontFamily = $state(DEFAULT_APP_FONT_FAMILY)
let appFontSize = $state(DEFAULT_APP_FONT_SIZE)
let fontWeight = $state(DEFAULT_APP_FONT_WEIGHT)
let zoomLevel = $state(DEFAULT_ZOOM_LEVEL)
/** The generation backend choice, mirrored so deep components can read it. */
let mediaGeneration = $state<MediaGenerationConfig>({ providerId: null })
/**
 * Saved model profiles, mirrored so the composer can read them without the config
 * being threaded down to it. Held as a plain array of plain records: the config is
 * synced on every `config:changed`, so this is a fresh array each time rather than
 * a mutation of the previous one, which is what lets the picker rows re-key.
 */
let modelProfiles = $state<ModelProfile[]>([])

/** Push the persisted appearance preferences onto the document. The CSS itself
 *  is applied by `lib/app-typography.ts`, which the app's child documents use as
 *  well, so every window of the app wears the same typography. Zoom itself is a
 *  window-level Electron zoomFactor owned by the main process. */
function applyAppearance(): void {
  applyAppTypography(document.documentElement, { fontFamily, appFontSize, fontWeight })
  void zoomLevel // zoom is applied by the main process via setZoomFactor
}

/**
 * Reactive slice of the app config for deep components (diff viewers) that do
 * not receive the config via props. App.svelte syncs it whenever the persisted
 * config loads or is patched.
 */
export const appConfigState = {
  get maxDiffLines(): number {
    return maxDiffLines
  },
  get browserHibernationMinutes(): number {
    return browserHibernationMinutes
  },
  /** How many pages the browser's history keeps; the history store evicts older
   *  visits for newer ones past this. */
  get browserHistoryLimit(): number {
    return browserHistoryLimit
  },
  get openLocalhostInCioBrowser(): boolean {
    return openLocalhostInCioBrowser
  },
  get openAllLinksInCioBrowser(): boolean {
    return openAllLinksInCioBrowser
  },
  /** The engine an address field searches with, already resolved: a removed
   *  custom engine falls back to the shipped default instead of a dead id. */
  get browserSearchEngine(): BrowserSearchEngine {
    return findBrowserSearchEngine(browserSearchEngineId, browserCustomSearchEngines)
  },
  /** Which in-app alert groups may play their quieter sound. */
  get inAppNotificationSound(): InAppNotificationSoundSettings {
    return inAppNotificationSound
  },
  get defaultPullStrategy(): GitPullPreference {
    return defaultPullStrategy
  },
  get fontFamily(): string {
    return fontFamily
  },
  get appFontSize(): number {
    return appFontSize
  },
  get fontWeight(): number {
    return fontWeight
  },
  get zoomLevel(): number {
    return zoomLevel
  },
  get mediaGeneration(): MediaGenerationConfig {
    return mediaGeneration
  },
  /** Named presets the user applies from the model picker. */
  get modelProfiles(): ModelProfile[] {
    return modelProfiles
  },
  sync(config: AppConfig): void {
    maxDiffLines = config.maxDiffLines
    browserHibernationMinutes = config.browserHibernationMinutes
    browserHistoryLimit = config.browserHistoryLimit
    openLocalhostInCioBrowser = config.openLocalhostInCioBrowser
    openAllLinksInCioBrowser = config.openAllLinksInCioBrowser
    browserSearchEngineId = config.browserSearchEngine
    browserCustomSearchEngines = config.browserCustomSearchEngines ?? []
    // Main builds the browser's native context menu, so it needs the active
    // engine to label and run "Search <engine> for ...". It holds no config of
    // its own, so the resolved engine is pushed whenever it changes - but the
    // push waits for a browser to exist, because nothing about the browser
    // belongs on a launch that never reaches one. The browser's runtime sends the
    // value it missed the moment it comes up.
    if (isBrowserLoaded()) {
      publishBrowserSearchEngine(
        findBrowserSearchEngine(browserSearchEngineId, browserCustomSearchEngines)
      )
    }
    inAppNotificationSound = {
      ...DEFAULT_IN_APP_NOTIFICATION_SOUND,
      ...config.inAppNotificationSound
    }
    defaultPullStrategy = config.defaultPullStrategy
    fontFamily = config.fontFamily
    appFontSize = config.appFontSize
    fontWeight = config.fontWeight
    zoomLevel = config.zoomLevel
    mediaGeneration = { providerId: config.mediaGeneration.providerId }
    modelProfiles = config.modelProfiles ?? []
    // The persisted keybindings overwrite the registry defaults, so every
    // handler that asks keymapState for an id picks up the user's binding.
    keymapState.setOverrides(config.keybindings)
    applyAppearance()
  }
}

/** Options for the Appearance font-family picker. */
export const FONT_FAMILY_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono (default)' },
  { id: 'satoshi', label: 'Satoshi' },
  { id: 'system', label: 'System default' },
  { id: 'sf-mono', label: 'SF Mono' },
  { id: 'menlo', label: 'Menlo' },
  { id: 'monaco', label: 'Monaco' },
  { id: 'fira-code', label: 'Fira Code' }
]

/** Font weights offered in Appearance settings. */
export const FONT_WEIGHT_OPTIONS: Array<{ id: number; label: string }> = [
  { id: 200, label: 'Extra light (default)' },
  { id: 300, label: 'Light' },
  { id: 400, label: 'Regular' },
  { id: 500, label: 'Medium' }
]

/** Zoom levels offered in Appearance settings, as percentages. */
export const ZOOM_LEVEL_OPTIONS: Array<{ id: number; label: string }> = [
  { id: 0.5, label: '50%' },
  { id: 0.67, label: '67%' },
  { id: 0.75, label: '75%' },
  { id: 0.8, label: '80%' },
  { id: 0.9, label: '90%' },
  { id: 1, label: '100%' },
  { id: 1.1, label: '110%' },
  { id: 1.25, label: '125%' },
  { id: 1.5, label: '150%' },
  { id: 1.75, label: '175%' },
  { id: 2, label: '200%' }
]
