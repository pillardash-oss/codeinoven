/**
 * PWA installability for the remote client.
 *
 * Browsers never auto-prompt a fresh visit; the site must capture the
 * `beforeinstallprompt` event and surface its own install affordance. This
 * store does that, and also teaches the sidebar whether the app is already
 * running installed (standalone) so an install button can stay hidden.
 *
 * iOS Safari has no `beforeinstallprompt` — installation goes through the
 * Share menu's "Add to Home Screen". There we expose a how-to guide instead of
 * a direct install prompt.
 */

import { remoteLog } from './logger'

const INSTALLED_KEY = 'codeinoven.pwa.installed'

/** Chrome/Edge/Android install prompt event, not present in lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** iOS exposes `navigator.standalone` to signal a home-screen instance. */
interface StandaloneNavigator extends Navigator {
  standalone?: boolean
}

class PwaInstall {
  /** True while running from an installed (standalone) home-screen instance. */
  installed = $state(false)
  /** True when the browser holds a `beforeinstallprompt` we can fire. */
  canInstall = $state(false)
  /** True on iOS Safari when the app isn't installed and no direct prompt exists. */
  iosGuideAvailable = $state(false)

  private deferredPrompt: BeforeInstallPromptEvent | null = null

  constructor() {
    this.installed = this.detectInstalled()
    this.iosGuideAvailable = this.detectIosGuide()
    this.attachListeners()
  }

  /** Directly install when the browser supports it. */
  async install(): Promise<'accepted' | 'dismissed' | 'unsupported'> {
    const prompt = this.deferredPrompt
    if (!prompt) return 'unsupported'
    this.deferredPrompt = null
    this.canInstall = false
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      if (choice.outcome === 'accepted') this.markInstalled(true)
      else remoteLog.dev('PWA install dismissed by the user')
      return choice.outcome
    } catch (error) {
      remoteLog.error(`PWA install prompt failed: ${String(error)}`)
      return 'unsupported'
    }
  }

  private attachListeners(): void {
    if (typeof window === 'undefined') return
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault()
      this.deferredPrompt = event as BeforeInstallPromptEvent
      this.canInstall = true
    })
    window.addEventListener('appinstalled', () => {
      this.markInstalled(true)
    })
  }

  /** Whether the running instance already is the installed app. */
  private detectInstalled(): boolean {
    if (typeof window === 'undefined') return false
    try {
      if (localStorage.getItem(INSTALLED_KEY) === '1') return true
    } catch {
      // best-effort — fall through to display-mode detection
    }
    if ((navigator as StandaloneNavigator).standalone) return true
    return window.matchMedia('(display-mode: standalone)').matches
  }

  /**
   * iOS Safari never fires `beforeinstallprompt`, so a direct install prompt
   * is impossible. Show a how-to guide whenever the app isn't installed and no
   * install prompt support exists.
   */
  private detectIosGuide(): boolean {
    if (typeof navigator === 'undefined' || typeof window === 'undefined') return false
    if (this.detectInstalled()) return false
    const ios =
      /iPad|iPhone|iPod/u.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    return ios && !('beforeinstallprompt' in window)
  }

  private markInstalled(value: boolean): void {
    this.installed = value
    this.canInstall = false
    this.deferredPrompt = null
    try {
      if (value) localStorage.setItem(INSTALLED_KEY, '1')
      else localStorage.removeItem(INSTALLED_KEY)
    } catch {
      // best-effort
    }
  }
}

export const pwaInstall = new PwaInstall()
