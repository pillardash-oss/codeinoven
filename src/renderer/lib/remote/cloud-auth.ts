import { createAuthClient } from 'better-auth/client'
import type { CloudUser } from './cloud-api'

const authClient = createAuthClient()

export type CloudAuthProvider = 'google' | 'apple'

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
