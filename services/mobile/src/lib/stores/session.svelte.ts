import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { api, ApiError, setApiToken } from '#lib/api/client'
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
      // One request to know who is signed in. Which device this is belongs to
      // Settings, and asking for the whole device list before the first screen
      // can draw is a second round trip the opens the phone does not need.
      this.user = await api.me()
      this.device = null
      this.phase = 'authenticated'
      await this.write(USER_KEY, JSON.stringify(this.user))
    } catch (cause) {
      // A revoked or expired session is a sign-out; a network that is not there
      // is not. Signing the account out because the oven was asleep would make a
      // flaky connection destructive, so only an answer from the service forgets
      // the token and the last known account keeps the app usable offline.
      const rejected = cause instanceof ApiError && cause.isUnauthorized
      if (rejected) {
        await this.forget()
        this.phase = 'anonymous'
        return
      }
      const cached = await this.read(USER_KEY)
      const user = parseUser(cached)
      if (user) {
        this.user = user
        this.phase = 'authenticated'
      } else {
        this.phase = 'anonymous'
      }
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

  /**
   * Finish a provider sign-in: the browser round trip left a one-time code, and
   * this exchanges it for this device's own session.
   */
  async completeOAuth(code: string): Promise<boolean> {
    return this.authenticate(() => api.exchangeOAuth({ code }))
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
      await this.write(USER_KEY, JSON.stringify(this.user))
      this.phase = 'authenticated'
      return true
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : 'Sign-in failed.'
      return false
    } finally {
      this.busy = false
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

function parseUser(raw: string | null): AccountUser | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as { id?: unknown; email?: unknown }
    if (typeof candidate.id !== 'string' || typeof candidate.email !== 'string') return null
    return parsed as AccountUser
  } catch {
    return null
  }
}

export const session = new SessionStore()
