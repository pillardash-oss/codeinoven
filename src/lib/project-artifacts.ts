import { join } from 'path'
import { readFile } from 'fs/promises'
import type { Database } from '../main/database/database'
import { ThreadRepo } from '../main/database/repositories/thread-repo'
import { ProjectRepo } from '../main/database/repositories/project-repo'
import { CHATS_CWD_DIR, type Project } from './types'
import { atomicWrite, ensureDir } from './utils'
import { APP_NAME } from './brand'

export const PROJECT_DATA_DIRECTORY = '.cio'
export const PROJECT_SPECS_DIRECTORY = 'specs'

/** App-storage root directory used as the neutral working directory for
 *  standalone (inbox) chats, so a chat session never runs against a real
 *  project folder. Each chat owns `chats-cwd/<threadId>/`: the one directory
 *  it runs in, mounts in its file tree, and keeps its own files in. */
export { CHATS_CWD_DIR }

/** Legacy per-chat artifact root that chat generated images were written to
 *  before each chat got its own `chats-cwd/<threadId>/` workspace. Kept
 *  readable so a chat started earlier still shows the images it produced. */
export const LEGACY_CHATS_ARTIFACTS_DIRECTORY = 'chats-artifacts'

/** App-storage root directory used as the neutral working directory for
 *  assistant-space routine tasks, so authoring a how-to never runs against a
 *  real project folder either. */
export const ASSISTANT_CWD_DIR = 'assistant-cwd'

/** App-storage root directory holding one workspace per browser tab's agent
 *  chat, so a conversation about a web page never runs against a real project
 *  folder and never shares a directory with another tab. */
export const BROWSER_CWD_DIR = 'browser-cwd'

/** Legacy inbox-chat generated-image root kept readable for older threads. */
export const LEGACY_CHAT_ARTIFACTS_DIRECTORY = 'chat-artifacts'

/** Storage-root-relative workspace directory of one standalone (inbox) chat:
 *  the session's working directory, the mount root of the chat's file tree,
 *  and the chat's own scratch and artifact directory. */
export function chatThreadWorkspaceDirectory(threadId: string): string {
  return join(CHATS_CWD_DIR, threadId)
}

/**
 * Storage-root-relative workspace directory every task of one routine mounts.
 * A routine behaves like a project, so its tasks share one folder.
 */
export function assistantRoutineWorkspaceDirectory(routineId: string): string {
  return join(ASSISTANT_CWD_DIR, routineId)
}

/**
 * Storage-root-relative workspace directory of one assistant task. A routine
 * behaves like a project, so every task in it shares `assistant-cwd/<routineId>`;
 * a routine-less task falls back to its own thread id so it still lives under
 * the assistant root without colliding with any routine.
 */
export function assistantThreadWorkspaceDirectory(
  threadId: string,
  routineId?: string | null
): string {
  return assistantRoutineWorkspaceDirectory(routineId ?? threadId)
}

/** Storage-root-relative workspace directory of one browser tab's agent chat:
 *  the directory its session runs in and the tab's own scratch root. The tab's
 *  conversation thread is named after the tab, so this is `browser-cwd/<tab id>`
 *  and one tab never reads or writes another tab's files. */
export function browserThreadWorkspaceDirectory(threadId: string): string {
  return join(BROWSER_CWD_DIR, threadId)
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

/**
 * The same validation as {@link requireLocalProject}, read on the database worker.
 *
 * For an async caller on an interaction path: the synchronous read above holds the
 * Electron main thread for the length of a statement, which a profile of the app
 * caught stalling frames (see the main-thread SQLite rule in `docs/APP-BIBLE.md`).
 * The errors are worded identically, so a caller can pick either one without
 * changing what a bad project id reports.
 */
export async function requireLocalProjectViaWorker(
  db: Database,
  projectId: string
): Promise<Project> {
  const project = await new ProjectRepo(db).getViaWorker(projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)
  if (project.source !== 'local' || !project.path) {
    throw new Error(`Project ${projectId} has no local filesystem root`)
  }
  return project
}
