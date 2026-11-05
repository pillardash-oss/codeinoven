import type { PageLoad } from './$types'
import { api } from '#lib/api/client'
import { rememberWorkView } from '#lib/work-view'

/**
 * The work list read as projects. Every project arrives with its threads in the
 * same read, because a strip unfolds what it already holds instead of fetching a
 * second page when it is opened. The strips are drawn in the order the service
 * ranks them, by activity.
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
    return { projects: projectPage.items, threads: threadPage.items, error: null }
  } catch (cause) {
    return {
      projects: [],
      threads: [],
      error: cause instanceof Error ? cause.message : 'Projects could not be loaded.'
    }
  }
}
