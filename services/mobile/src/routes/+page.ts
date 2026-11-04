import { redirect } from '@sveltejs/kit'
import type { PageLoad } from './$types'

/**
 * The phone opens on the thread panel. Projects is a scope you choose from the
 * dock, not a second home, so the root has nothing of its own to draw.
 */
export const load: PageLoad = () => {
  redirect(307, '/threads')
}
