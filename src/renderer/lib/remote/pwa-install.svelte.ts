/**
 * PWA installability for the remote client.
 *
 * Browsers never auto-prompt a fresh visit; the site must capture the
 * `beforeinstallprompt` event and surface its own install affordance. This
 * store does that, and also teaches the sidebar whether the app is already
 * running installed (standalone) so an install button can stay hidden.
 *
 * `beforeinstallprompt` only fires on a trusted HTTPS origin. The LAN gateway
 * serves the PWA over a self-signed certificate and iOS Safari never fires the
 * event at all, so a direct prompt is often unavailable. In those cases the
 * UI shows a platform how-to guide instead of a prompt.
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
  canPrompt = $state(false)
  /** True on iOS Safari — installation goes through the Share menu. */
  isIos = $state(false)

  private deferredPrompt: BeforeInstallPromptEvent | null = null

  constructor() {
    this.installed = this.detectInstalled()
    this.isIos = this.detectIos()
    this.attachListeners()
  }

  /**
   * Install when the browser offers a direct prompt. Returns 'unsupported'
   * when the platform needs the manual flow instead (iOS, or a browser that
   * never fired `beforeinstallprompt` — e.g. an untrusted certificate), so the
   * caller can fall back to a how-to guide.
   */
  async install(): Promise<'accepted' | 'dismissed' | 'unsupported'> {
    const prompt = this.deferredPrompt
    if (!prompt) return 'unsupported'
    this.deferredPrompt = null
    this.canPrompt = false
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
      this.canPrompt = true
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

  private detectIos(): boolean {
    if (typeof navigator === 'undefined') return false
    return (
      /iPad|iPhone|iPod/u.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    )
  }

  private markInstalled(value: boolean): void {
    this.installed = value
    this.canPrompt = false
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
