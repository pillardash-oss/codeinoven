import type { PageLoad } from './$types'
import { api } from '#lib/api/client'

/**
 * The thread panel's data. It loads through the router rather than in an effect
 * so a change of scope (?project=) is a new read by construction, and the dock's
 * project sheet needs no second copy of the list.
 */
export const load: PageLoad = async ({ url, parent }) => {
  await parent()
  const project = url.searchParams.get('project') ?? ''
  try {
    const [threadPage, projectPage] = await Promise.all([
      api.threads({ limit: 200, project: project || undefined }),
      api.projects({ sort: 'activity', limit: 100 })
    ])
    return {
      project,
      threads: threadPage.items,
      projects: projectPage.items,
      error: null
    }
  } catch (cause) {
    return {
      project,
      threads: [],
      projects: [],
      error: cause instanceof Error ? cause.message : 'Threads could not be loaded.'
    }
  }
}
