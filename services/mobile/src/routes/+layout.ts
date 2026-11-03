import { redirect, type Load } from '@sveltejs/kit'
import { session } from '#lib/stores/session.svelte'

/**
 * The route guard. The token is restored once, before the first screen renders,
 * and a visitor without a working session is sent to sign in rather than shown an
 * empty app. Doing it here keeps every screen free of the same check.
 */

export const ssr = false
export const prerender = false

export const load: Load = async ({ url }) => {
  await session.restore()

  const signIn = url.pathname === '/sign-in'
  if (!signIn && !session.signedIn) redirect(307, '/sign-in')
  if (signIn && session.signedIn) redirect(307, '/')
}
