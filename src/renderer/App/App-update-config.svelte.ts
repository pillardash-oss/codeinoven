import { invoke, subscribeGuarded } from '$lib/ipc.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { isBrowserLoaded } from '$lib/stores/browser-access.svelte'
import { schemeState } from '$lib/stores/scheme.svelte'
import { publishBrowserScrollbarTheme } from '$lib/browser-page-scrollbar'
import { appConfigState } from '$lib/stores/app-config.svelte'
import { type AppConfig, type AppConfigPatch, type ThemePreference } from '$shared/types'
import { defaultConfig } from '../app-defaults'
import type { App } from './App-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the App board. */
export class AppUpdateConfig extends BoardUnit<App> {
  constructor(root: App) {
    super(root)
  }
  config = $state<AppConfig>(defaultConfig)

  settingsReady = $state(false)

  settingsError = $state<string>()

  systemDark = $state(false)

  /** The one-time start-at-login offer, raised once after the first assistant knowledge. */
  startAtLoginOfferOpen = $state(false)

  /** Set once the first run has been checked, so the guide is offered exactly once. */
  firstRunChecked = false

  effectiveTheme = $derived(
    this.config.theme === 'system' ? (this.systemDark ? 'dark' : 'light') : this.config.theme
  )

  applyTheme(): void {
    document.documentElement.classList.toggle('dark', this.effectiveTheme === 'dark')
    schemeState.sync(this.effectiveTheme)
    // A browser tab's page is a native view, so its default scrollbar cannot be
    // reached by the stylesheet: hand the app's colours to main instead. Nothing
    // about the browser belongs on a launch that never reaches it, so the push
    // waits until there is a browser to theme - the runtime makes the first one
    // when it comes up, and this covers every theme change after that.
    if (isBrowserLoaded()) publishBrowserScrollbarTheme()
  }

  async loadConfig(): Promise<void> {
    try {
      this.config = await invoke('config:get')
      appConfigState.sync(this.config)
      this.applyTheme()
      this.settingsError = undefined
      // The guide owns the first run: a user who has never walked the Projects
      // guide gets it as soon as there is a config to read.
      if (!this.firstRunChecked) {
        this.firstRunChecked = true
        if (!this.config.onboardingCompleted) workspaceState.requestViewTour('projects')
      }
    } catch {
      this.settingsError = 'Settings could not be loaded. Defaults are being used.'
      if (!this.firstRunChecked) {
        this.firstRunChecked = true
        workspaceState.requestViewTour('projects')
      }
    } finally {
      this.settingsReady = true
    }
  }

  async updateConfig(patch: AppConfigPatch): Promise<void> {
    const previous = this.config
    this.config = { ...this.config, ...patch }
    this.applyTheme()
    if (patch.sound) {
      window.dispatchEvent(
        new CustomEvent('cio:soundChanged', { detail: { ...this.config.sound, ...patch.sound } })
      )
    }
    try {
      this.config = await invoke('config:update', patch)
      appConfigState.sync(this.config)
      this.applyTheme()
      this.settingsError = undefined
      if (patch.sound) {
        window.dispatchEvent(new CustomEvent('cio:soundChanged', { detail: this.config.sound }))
      }
    } catch {
      this.config = previous
      this.applyTheme()
      this.settingsError = 'Your settings change could not be saved.'
    }
  }

  /**
   * Answer the one-time start-at-login offer. The choice and the flag that keeps
   * the question from ever being raised again are saved together, so no later
   * assistant setup asks a second time however this one is answered.
   */
  answerStartAtLoginOffer(startAtLogin: boolean): void {
    this.startAtLoginOfferOpen = false
    void this.updateConfig({ launchAtLogin: startAtLogin, launchAtLoginPrompted: true })
  }

  setPreference(pref: ThemePreference): void {
    void this.updateConfig({ theme: pref })
  }

  /**
   * Follow a config change this window did not make.
   *
   * The design board changes the work folders from its own panel, and a settings
   * page still showing the replaced folder would be describing a file that is no
   * longer on disk. Main broadcasts the saved config, so every surface agrees on
   * what was written. The window that made the change receives its own broadcast
   * too, which is the same value it already holds.
   */
  installConfigSubscription(): () => void {
    // Guarded for the same reason as the shutdown subscription above.
    return subscribeGuarded('config:changed', (next) => {
      this.config = next
      appConfigState.sync(next)
      this.applyTheme()
    })
  }
}
