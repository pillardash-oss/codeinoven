import type { PageLoad } from './$types'
import { api } from '#lib/api/client'
import { rememberProject } from '#lib/project-recency'
import { rememberWorkView } from '#lib/work-view'

/**
 * The thread panel's data. It loads through the router rather than in an effect,
 * so a change of view is a new read by construction and the dock's work square
 * needs no second copy of the list.
 */
export const load: PageLoad = async ({ parent }) => {
  await parent()
  // The dock's single work square reopens whichever reading was used last.
  void rememberWorkView('threads')
  try {
    const [threadPage, projectPage] = await Promise.all([
      api.threads({ limit: 200 }),
      api.projects({ sort: 'activity', limit: 100 })
    ])
    return { threads: threadPage.items, projects: projectPage.items, error: null }
  } catch (cause) {
    return {
      threads: [],
      projects: [],
      error: cause instanceof Error ? cause.message : 'Threads could not be loaded.'
    }
  }
}
