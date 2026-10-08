/** Fixed id of the hidden project that holds standalone (project-less) chats. */
export const INBOX_PROJECT_ID = 'inbox'

/**
 * The transient scope the welcome ("Start a new chat") composer stages into
 * while the chat it will become does not exist yet.
 *
 * It is not a thread and nothing lives there: as soon as the chat exists, main
 * moves everything staged here into that chat's own workspace
 * (`chats-cwd/<threadId>/.cio/tmp`) and the composer repoints its attachment
 * chips at the moved files. Nothing may keep writing here after the hand-off.
 */
export const DRAFT_CHAT_THREAD_ID = 'new-chat'

/**
 * Fixed id of the hidden container that holds assistant-space threads (routine
 * tasks). Like the inbox it is a hidden project, so assistant threads never
 * leak into the Projects or Chats lists.
 */
export const ASSISTANT_SPACE_ID = 'assistant'

/**
 * Fixed id of the hidden container that owns the global (personal) browser
 * workspace.
 *
 * It is the one hidden container with no content-view family: its tabs are web
 * pages rather than conversations, and its threads exist only so a per-tab agent
 * side chat can resolve its scope. Each tab's conversation thread is named after
 * its tab, and its workspace is `browser-cwd/<thread id>` in app storage, so one
 * tab never shares a directory with another. Every thread listing and search
 * therefore excludes this container's threads, so those rows can never surface
 * as user threads.
 */
export const GLOBAL_BROWSER_PROJECT_ID = 'browser-global'

/** Fixed id of the global browser's single scope-anchor thread. */
export const GLOBAL_BROWSER_THREAD_ID = 'browser-global'

/**
 * App-storage root holding one workspace directory per standalone (inbox) chat.
 * `chats-cwd/<threadId>` is the directory a chat's session runs in, the mount
 * root of its file tree, and the chat's own scratch and artifact directory.
 *
 * The name lives here, not in the main process's storage-layout module, because
 * the renderer needs the same segment to turn a path an agent cited back into a
 * tree-relative one, and importing that module would pull filesystem code into
 * the renderer bundle.
 */
export const CHATS_CWD_DIR = 'chats-cwd'

/**
 * Fixed hidden containers that hold many independent conversations under one
 * project id. Every per-conversation surface keys off the open thread's
 * conversation scope inside them: a standalone chat owns its own file mount and
 * its own browser tabs, while an assistant routine's threads (its how-to host
 * and the runs it fires) share one of each, because a routine is one container
 * the user set up. Switching conversations swaps the scope instead of leaking
 * one conversation's state into another. A real project keeps one shared
 * surface across all of its threads.
 */
export function isConversationContainer(projectId: string): boolean {
  return projectId === INBOX_PROJECT_ID || projectId === ASSISTANT_SPACE_ID
}

/**
 * The conversation a thread's browser tabs belong to. A project's threads share
 * the project, exactly as they share its workspace. An assistant thread shares
 * its routine with that routine's other threads, which is the same owner the
 * `assistant-cwd/<routineId ?? threadId>` mount uses, so a browser opened by one
 * run of a routine stays on screen in its how-to host and in its other runs. A
 * routine-less assistant task and an inbox chat are independent conversations
 * and each own their own.
 */
export function conversationScopeId(
  projectId: string,
  threadId: string,
  routineId?: string | null
): string {
  if (projectId === ASSISTANT_SPACE_ID) return routineId ?? threadId
  if (projectId === INBOX_PROJECT_ID) return threadId
  return projectId
}

/**
 * Whether a conversation browses its own app-owned workspace directory instead
 * of a project root: standalone chats mount `chats-cwd/<threadId>` and
 * assistant tasks mount `assistant-cwd/<routineId ?? threadId>`, and browser
 * conversations mount `browser-cwd/<threadId>`. Every file
 * surface keys the mount off the open thread for exactly these containers.
 */
export function usesThreadWorkspaceMount(projectId: string): boolean {
  return isConversationContainer(projectId) || projectId === GLOBAL_BROWSER_PROJECT_ID
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
  /** Sanitized custom SVG pasted by the user. Dynamic non-neutral colours use currentColor. */
  customSvg?: string
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
  customSvg?: string | null
  changeTrackingMode?: ChangeTrackingMode
  hasDeployments?: boolean
}
