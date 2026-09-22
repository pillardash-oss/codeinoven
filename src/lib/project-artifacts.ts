import { join } from 'path'
import { readFile } from 'fs/promises'
import type { Database } from '../main/database/database'
import { ThreadRepo } from '../main/database/repositories/thread-repo'
import { ProjectRepo } from '../main/database/repositories/project-repo'
import type { Project } from './types'
import { atomicWrite, ensureDir } from './utils'
import { APP_NAME } from './brand'

export const PROJECT_DATA_DIRECTORY = '.cio'
export const PROJECT_SPECS_DIRECTORY = 'specs'

/** App-storage root directory holding every chat thread's own artifact scratch
 *  directory. Sibling of `chats-cwd`; each thread gets `chats-artifacts/<threadId>/`
 *  as its private, pre-authorized read/write route. */
export const CHATS_ARTIFACTS_DIRECTORY = 'chats-artifacts'

/** App-storage root directory used as the neutral working directory for
 *  standalone (inbox) chats, so a chat session never runs against a real
 *  project folder. */
export const CHATS_CWD_DIR = 'chats-cwd'

/** App-storage root directory used as the neutral working directory for
 *  assistant-space routine tasks, so authoring a how-to never runs against a
 *  real project folder either. */
export const ASSISTANT_CWD_DIR = 'assistant-cwd'

/** Legacy inbox-chat generated-image root kept readable for older threads. */
export const LEGACY_CHAT_ARTIFACTS_DIRECTORY = 'chat-artifacts'

/** Storage-root-relative artifact directory of one chat thread. */
export function chatThreadArtifactDirectory(threadId: string): string {
  return join(CHATS_ARTIFACTS_DIRECTORY, threadId)
}

const PROJECT_GITIGNORE_BLOCK = `# ${APP_NAME} agent scratch space (context, reports, temp work)\n.cio/\n`

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

/**
 * Create the project's `.cio/` agent scratch pad and gitignore it from day
 * one. Best-effort: a local project must never fail to register because of
 * this, so callers treat a thrown error as non-fatal.
 */
export async function ensureProjectScratchSpace(projectPath: string): Promise<void> {
  await ensureDir(join(projectPath, PROJECT_DATA_DIRECTORY))

  const ignorePath = join(projectPath, '.gitignore')
  let current = ''
  try {
    current = await readFile(ignorePath, 'utf-8')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }

  if (gitignoreCoversCio(current)) return
  const separator = current.trimEnd() ? '\n\n' : ''
  await atomicWrite(ignorePath, `${current.trimEnd()}${separator}${PROJECT_GITIGNORE_BLOCK}`)
}

/** True when an existing `.gitignore` already covers the `.cio` directory. */
function gitignoreCoversCio(content: string): boolean {
  return content.split(/\r?\n/u).some((line) => {
    const pattern = line.trim()
    if (!pattern || pattern.startsWith('#')) return false
    const normalized = pattern.replace(/^\/+?/u, '').replace(/^\*\*\//u, '')
    return normalized === PROJECT_DATA_DIRECTORY || normalized === `${PROJECT_DATA_DIRECTORY}/`
  })
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
