import { createAuthClient } from 'better-auth/client'
import type { CloudUser } from './cloud-api'

const authClient = createAuthClient()

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

export async function signInWithGitHub(): Promise<void> {
  const result = await authClient.signIn.social({
    provider: 'github',
    callbackURL: '/remote.html',
    errorCallbackURL: '/remote.html?authError=github'
  })
  if (result.error) throw new Error(result.error.message ?? 'github-sign-in-failed')
}

export async function logoutCloudAccount(): Promise<void> {
  const result = await authClient.signOut()
  if (result.error) throw new Error(result.error.message ?? 'sign-out-failed')
}
