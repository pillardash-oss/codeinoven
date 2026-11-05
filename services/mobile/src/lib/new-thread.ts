import { goto } from '$app/navigation'
import { api } from '#lib/api/client'
import { orderProjects, readProjectRanking, rememberProject } from '#lib/project-recency'
import type { Project, Thread } from '#lib/api/types'

/**
 * What the new thread square does, on every panel.
 *
 * One button covers three intents, and the panel it is pressed on decides which
 * of them is meant: a chat opens a thread with no chooser, a phone with a single
 * project opens a thread in it, and a phone with several offers them in the order
 * it worked on them. A second tap on the same square skips the chooser and opens
 * a thread in the project in hand, so starting work never costs a drawer.
 *
 * The service starts every thread with the name it is given, because the desktop
 * renames a thread from its first prompt anyway; the phone therefore spells the
 * placeholder the desktop would have written, and never blocks a tap on typing.
 */

/** The name a thread carries until its first prompt gives it a real one. */
export const NEW_THREAD_TITLE = 'New thread'

/** A second tap inside this window means "skip the chooser". */
export const DOUBLE_TAP_MS = 280

export type NewThreadIntent = 'chooser' | 'direct'

export interface NewThreadPlan {
  intent: NewThreadIntent
  /** The project a direct start writes into, when one could be resolved. */
  projectId: string | null
}

/** The projects to offer, most recently worked on first. */
export async function projectsInHandOrder(): Promise<Project[]> {
  const [page, ranking] = await Promise.all([
    api.projects({ sort: 'activity', limit: 100 }),
    readProjectRanking()
  ])
  return orderProjects(page.items, ranking)
}

/**
 * Read what a press means before anything is shown. A chats panel has no
 * chooser by design, and a phone with one project has nothing to choose.
 */
export async function planNewThread(options: { onChats: boolean }): Promise<NewThreadPlan> {
  const projects = await projectsInHandOrder()
  const top = projects[0]?.id ?? null
  if (options.onChats) return { intent: 'direct', projectId: top }
  if (projects.length === 1) return { intent: 'direct', projectId: top }
  return { intent: 'chooser', projectId: top }
}

/** Start the thread the plan calls for, and open it. */
export async function startNewThread(projectId: string): Promise<Thread> {
  const thread = await api.createThread({ projectId, title: NEW_THREAD_TITLE })
  void rememberProject(projectId)
  await goto(`/threads/${thread.id}`)
  return thread
}
