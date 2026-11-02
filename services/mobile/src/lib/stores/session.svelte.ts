import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { api, setApiToken } from '#lib/api/client'
import type { AccountUser, AuthResult, Device } from '#lib/api/types'

/**
 * Who is signed in on this phone.
 *
 * The token is the only durable piece of state: it is written after a successful
 * sign-in and read once at start-up, and every other screen reads the account
 * from here rather than fetching it again. A revoked or expired token lands on
 * the sign-in screen instead of an empty app.
 */

const TOKEN_KEY = 'cio.mobile.token'
const USER_KEY = 'cio.mobile.user'

export type SessionPhase = 'loading' | 'anonymous' | 'authenticated'

function platform(): 'ios' | 'android' | 'desktop' {
  const value = Capacitor.getPlatform()
  if (value === 'ios' || value === 'android') return value
  return 'desktop'
}

function deviceName(): string {
  const value = Capacitor.getPlatform()
  if (value === 'ios') return 'iPhone'
  if (value === 'android') return 'Android phone'
  return 'Browser'
}

class SessionStore {
  phase = $state<SessionPhase>('loading')
  user = $state<AccountUser | null>(null)
  device = $state<Device | null>(null)
  busy = $state(false)
  error = $state<string | null>(null)

  get signedIn(): boolean {
    return this.phase === 'authenticated' && this.user !== null
  }

  get deviceLabel(): string {
    return deviceName()
  }

  /** Read the stored token and confirm it still works before showing the app. */
  async restore(): Promise<void> {
    if (this.phase !== 'loading') return
    const token = await this.read(TOKEN_KEY)
    if (!token) {
      this.phase = 'anonymous'
      return
    }
    setApiToken(token)
    try {
      this.user = await api.me()
      this.device = await this.cachedDevice()
      this.phase = 'authenticated'
    } catch {
      await this.forget()
      this.phase = 'anonymous'
    }
  }

  async signIn(email: string, password: string): Promise<boolean> {
    return this.authenticate(() =>
      api.signIn({ email, password, device: { name: deviceName(), platform: platform() } })
    )
  }

  async signUp(name: string, email: string, password: string): Promise<boolean> {
    return this.authenticate(() =>
      api.signUp({ name, email, password, device: { name: deviceName(), platform: platform() } })
    )
  }

  async signOut(): Promise<void> {
    try {
      await api.signOut()
    } catch {
      // A sign-out that cannot reach the service still signs this device out.
    }
    await this.forget()
    this.phase = 'anonymous'
  }

  clearError(): void {
    this.error = null
  }

  private async authenticate(run: () => Promise<AuthResult>): Promise<boolean> {
    this.busy = true
    this.error = null
    try {
      const result = await run()
      setApiToken(result.token)
      await this.write(TOKEN_KEY, result.token)
      await this.write(USER_KEY, result.user.id)
      this.device = result.device
      this.user = await api.me()
      this.phase = 'authenticated'
      return true
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : 'Sign-in failed.'
      return false
    } finally {
      this.busy = false
    }
  }

  private async cachedDevice(): Promise<Device | null> {
    try {
      const devices = await api.devices()
      return devices.find((entry) => entry.current) ?? null
    } catch {
      return null
    }
  }

  private async forget(): Promise<void> {
    setApiToken(null)
    this.user = null
    this.device = null
    await Preferences.remove({ key: TOKEN_KEY }).catch(() => undefined)
    await Preferences.remove({ key: USER_KEY }).catch(() => undefined)
  }

  private async read(key: string): Promise<string | null> {
    try {
      const { value } = await Preferences.get({ key })
      return value
    } catch {
      return globalThis.localStorage?.getItem(key) ?? null
    }
  }

  private async write(key: string, value: string): Promise<void> {
    try {
      await Preferences.set({ key, value })
    } catch {
      globalThis.localStorage?.setItem(key, value)
    }
  }
}

export const session = new SessionStore()
