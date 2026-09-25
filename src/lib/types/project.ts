/** Fixed id of the hidden project that holds standalone (project-less) chats. */
export const INBOX_PROJECT_ID = 'inbox'

/**
 * Fixed id of the hidden container that holds assistant-space threads (routine
 * tasks). Like the inbox it is a hidden project, so assistant threads never
 * leak into the Projects or Chats lists.
 */
export const ASSISTANT_SPACE_ID = 'assistant'

/**
 * Fixed hidden containers that hold many independent conversations under one
 * project id. Every per-conversation surface keys off the open thread inside
 * them: a standalone chat or an assistant task owns its own file mount and its
 * own browser tabs, so switching conversations swaps both instead of leaking
 * one conversation's state into another. A real project keeps one shared
 * surface across all of its threads.
 */
export function isConversationContainer(projectId: string): boolean {
  return projectId === INBOX_PROJECT_ID || projectId === ASSISTANT_SPACE_ID
}

/**
 * Whether a conversation browses its own app-owned workspace directory instead
 * of a project root: standalone chats mount `chats-artifacts/<threadId>` and
 * assistant tasks mount `assistant-cwd/<routineId ?? threadId>`. Every file
 * surface keys the mount off the open thread for exactly these containers.
 */
export function usesThreadWorkspaceMount(projectId: string): boolean {
  return isConversationContainer(projectId)
}

export type ChangeTrackingMode = 'git' | 'manual'

export type RepositoryStatus = 'git' | 'not_git' | 'git_unavailable'

export interface RepositoryPreflightResult {
  status: RepositoryStatus
  projectPath: string
  repositoryRoot?: string
  detail?: string
}

export interface Project {
  id: string
  name: string
  path: string
  source: 'local' | 'ssh'
  host?: string
  providerId: string
  workflowId: string
  threadLimit: number
  /** Hidden projects (e.g. the inbox and the assistant space) are excluded from
   *  the Projects tab. */
  hidden?: boolean
  /** Whether the project is pinned to the top of the project list. */
  pinned?: boolean
  /** Position for manual drag-to-reorder; items without sortOrder fall back to updatedAt. */
  sortOrder?: number
  /** Filename of the project's stored icon (e.g. `icon.png`), relative to its storage dir. */
  icon?: string
  /** Accent colour for the project (a hex colour from the project palette). */
  color?: string
  /** Key of the selected SVG icon type (e.g. 'folder', 'code', 'terminal'). */
  iconType?: string
  /** Optional while loading projects persisted before change tracking was introduced. */
  changeTrackingMode?: ChangeTrackingMode
  /** Whether the repo is known to have GitHub deployments; gates the Deployments tab. */
  hasDeployments?: boolean
  createdAt: number
  updatedAt: number
}

export interface CreateProjectInput {
  name: string
  path: string
  source?: 'local' | 'ssh'
  host?: string
  providerId?: string
  workflowId?: string
  threadLimit?: number
  hidden?: boolean
  color?: string
  iconType?: string
  changeTrackingMode?: ChangeTrackingMode
  hasDeployments?: boolean
}
