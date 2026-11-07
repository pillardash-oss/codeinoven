import { redirect } from '@sveltejs/kit'
import type { PageLoad } from './$types'
import { readWorkView, workViewHref } from '#lib/work-view'

/**
 * The phone opens on the work list, in whichever reading it was left in: all
 * threads, or all projects. Both are one destination, so neither is a second
 * home and the root has nothing of its own to draw.
 */
export const load: PageLoad = async () => {
  redirect(307, workViewHref(await readWorkView()))
}
