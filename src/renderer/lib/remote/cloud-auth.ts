import { createAuthClient } from 'better-auth/client'
import type { CloudUser } from './cloud-api'

const authClient = createAuthClient()
const AUTH_CALLBACK_TOKEN_PARAM = 'ott'
const AUTH_CALLBACK_ERROR_PARAM = 'authError'

export type CloudAuthProvider = 'google' | 'apple'

function currentCallbackUrl(): URL | null {
  return typeof window === 'undefined' ? null : new URL(window.location.href)
}

function clearCallbackParameters(url: URL): void {
  url.searchParams.delete(AUTH_CALLBACK_TOKEN_PARAM)
  url.searchParams.delete(AUTH_CALLBACK_ERROR_PARAM)
  try {
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // Session completion does not depend on cleaning the callback URL.
  }
}

/** Whether this page load is returning from a hosted account sign-in attempt. */
export function hasCloudAuthCallback(): boolean {
  const url = currentCallbackUrl()
  return Boolean(
    url?.searchParams.has(AUTH_CALLBACK_TOKEN_PARAM) ||
    url?.searchParams.has(AUTH_CALLBACK_ERROR_PARAM)
  )
}

/**
 * Exchange the cross-domain callback's short-lived token for the same-origin
 * session cookie used by the mobile PWA and remote API.
 */
export async function completeCloudAuthCallback(): Promise<void> {
  const url = currentCallbackUrl()
  if (!url) return

  const providerError = url.searchParams.get(AUTH_CALLBACK_ERROR_PARAM)
  const token = url.searchParams.get(AUTH_CALLBACK_TOKEN_PARAM)
  if (!providerError && !token) return

  try {
    if (providerError === 'google' || providerError === 'apple') {
      throw new Error(`${providerError}-sign-in-failed`)
    }
    if (!token || token.length < 16 || token.length > 512) {
      throw new Error('oauth-session-failed')
    }

    const response = await fetch('/api/auth/cross-domain/one-time-token/verify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    })
    if (!response.ok) throw new Error('oauth-session-failed')
  } finally {
    clearCallbackParameters(url)
  }
}

export async function currentCloudUser(): Promise<CloudUser> {
  const result = await authClient.getSession()
  if (result.error || !result.data?.user) throw new Error('unauthorized')
  return {
    id: result.data.user.id,
    email: result.data.user.email,
    displayName: result.data.user.name,
    image: result.data.user.image ?? null
  }
}

export async function signInWithCloudProvider(provider: CloudAuthProvider): Promise<void> {
  const result = await authClient.signIn.social({
    provider,
    callbackURL: '/',
    errorCallbackURL: `/?authError=${provider}`
  })
  if (result.error) throw new Error(result.error.message ?? `${provider}-sign-in-failed`)
}

export async function logoutCloudAccount(): Promise<void> {
  const result = await authClient.signOut()
  if (result.error) throw new Error(result.error.message ?? 'sign-out-failed')
}
