import type { PageLoad } from './$types'
import { api } from '#lib/api/client'
import { rememberWorkView } from '#lib/work-view'

/**
 * The other reading of the work list: every project with what is happening in
 * it. It loads through the router like the thread list, so switching the
 * header's title is a new read rather than a state the screen has to keep in
 * step by hand.
 */
export const load: PageLoad = async ({ parent }) => {
  await parent()
  // The dock's single work square reopens whichever reading was used last.
  void rememberWorkView('projects')
  try {
    const [projectPage, threadPage] = await Promise.all([
      api.projects({ sort: 'activity', limit: 100 }),
      api.threads({ limit: 200 })
    ])
    return { projects: projectPage.items, threadCount: threadPage.items.length, error: null }
  } catch (cause) {
    return {
      projects: [],
      threadCount: 0,
      error: cause instanceof Error ? cause.message : 'Projects could not be loaded.'
    }
  }
}
