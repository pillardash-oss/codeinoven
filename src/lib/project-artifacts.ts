import { join } from 'path'
import type { Database } from '../main/database/database'
import { ThreadRepo } from '../main/database/repositories/thread-repo'
import { ProjectRepo } from '../main/database/repositories/project-repo'
import type { Project } from './types'

export const PROJECT_DATA_DIRECTORY = '.cio'
export const PROJECT_SPECS_DIRECTORY = 'specs'

export function featureSlugFromTitle(title: string): string {
  const normalized = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
  return (
    normalized
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 64)
      .replace(/-+$/gu, '') || 'feature'
  )
}

export function featureArtifactDirectory(featureSlug: string): string {
  return join(PROJECT_DATA_DIRECTORY, PROJECT_SPECS_DIRECTORY, featureSlug)
}

/** Assign a readable feature identity once; later thread renames never alter it. */
export async function ensureFeatureSlug(
  db: Database,
  projectId: string,
  threadId: string
): Promise<string> {
  const threads = new ThreadRepo(db)
  const thread = threads.get(threadId)
  if (!thread) throw new Error(`Thread not found: ${threadId}`)
  if (thread.projectId !== projectId) {
    throw new Error(`Thread ${threadId} does not belong to project ${projectId}`)
  }
  if (thread.featureSlug) return thread.featureSlug

  const base = featureSlugFromTitle(thread.title)
  const assigned = new Set(
    threads
      .listByProject(projectId)
      .filter((sibling) => sibling.id !== threadId && sibling.featureSlug)
      .map((sibling) => sibling.featureSlug as string)
  )

  let featureSlug = base
  for (let suffix = 2; assigned.has(featureSlug); suffix += 1) {
    featureSlug = `${base}-${suffix}`
  }

  threads.upsert({ ...thread, featureSlug, updatedAt: Date.now() })
  return featureSlug
}

export function requireLocalProject(db: Database, projectId: string): Project {
  const project = new ProjectRepo(db).get(projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)
  if (project.source !== 'local' || !project.path) {
    throw new Error(`Project ${projectId} has no local filesystem root`)
  }
  return project
}
