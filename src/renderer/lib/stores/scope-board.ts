import { APP_SLUG } from '$shared/brand'
import {
  DEFAULT_SCOPE_BUCKET_ID,
  isOrchestrationChildThread,
  scopeSliceForStatus,
  type ScopeBoard,
  type ScopeBucket,
  type ScopeSlice,
  type Thread
} from '$shared/types'
import type { ThreadStatusTone } from '$shared/thread-status-policy'

/** Stage a thread renders under on the scope board; one slice per board column. */
export type ThreadStage = ScopeSlice

export interface ScopeProject {
  id: string
  name: string
  path?: string
  source?: 'local' | 'ssh'
  host?: string
  iconUrl?: string | null
  color?: string
}

export interface ScopeSidebarContext {
  projectId: string
  bucketId: string
  stage: ThreadStage
  threadId: string
}

export interface ScopeBucketEdit {
  name: string
  color?: string
  iconType?: string
}

export interface ProjectBadge {
  hasWorking: boolean
  hasUnread: boolean
  hasAttention: boolean
  hasError: boolean
}

export const STAGE_LABELS: Record<ThreadStage, string> = {
  pinned: 'Pinned',
  todo: 'Todo',
  working: 'Working',
  spec: 'Spec',
  issue: 'Issue',
  unread: 'Unread',
  done: 'Done'
}

export const STAGE_COLORS: Record<ThreadStage, string> = {
  pinned: 'var(--color-thread-pinned)',
  todo: 'var(--color-dimmed)',
  working: 'var(--color-thread-working)',
  spec: 'var(--color-thread-spec)',
  issue: 'var(--color-warning)',
  unread: 'var(--color-thread-unread)',
  done: 'var(--color-thread-done)'
}

export const STATUS_TONE_COLORS: Record<ThreadStatusTone, string> = {
  todo: 'var(--color-dimmed)',
  working: 'var(--color-thread-working)',
  'working-paused': 'var(--color-thread-working-paused)',
  attention: 'var(--color-warning)',
  spec: 'var(--color-thread-spec)',
  done: 'var(--color-thread-done)',
  error: 'var(--color-thread-error)',
  missed: 'var(--color-missed)'
}

export const STAGE_ORDER: ThreadStage[] = [
  'pinned',
  'todo',
  'working',
  'spec',
  'issue',
  'unread',
  'done'
]

export const EMPTY_BOARD: ScopeBoard = {
  version: 2,
  buckets: [
    {
      id: DEFAULT_SCOPE_BUCKET_ID,
      name: 'Default',
      sortOrder: 0,
      collapsed: false,
      collapsedSlices: [],
      root: { kind: 'project' }
    }
  ],
  worktreeDefaults: { setupCommands: [], runSetupByDefault: true, environmentMode: 'copy' }
}

export interface ScopeSnapshot {
  activeProjectId: string | null
  sidebarContext: ScopeSidebarContext | null
}

const SCOPE_STORAGE_KEY = `${APP_SLUG}.scope.v1`

export function parseSidebarContext(value: unknown): ScopeSidebarContext | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (
    typeof obj.projectId !== 'string' ||
    typeof obj.bucketId !== 'string' ||
    typeof obj.threadId !== 'string' ||
    typeof obj.stage !== 'string' ||
    !STAGE_ORDER.includes(obj.stage as ThreadStage)
  ) {
    return null
  }
  return {
    projectId: obj.projectId,
    bucketId: obj.bucketId,
    stage: obj.stage as ThreadStage,
    threadId: obj.threadId
  }
}

export function loadScopeSnapshot(): ScopeSnapshot {
  if (typeof window === 'undefined') return { activeProjectId: null, sidebarContext: null }
  try {
    const raw = window.localStorage.getItem(SCOPE_STORAGE_KEY)
    if (!raw) return { activeProjectId: null, sidebarContext: null }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      activeProjectId: typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : null,
      sidebarContext: parseSidebarContext(parsed.sidebarContext)
    }
  } catch {
    return { activeProjectId: null, sidebarContext: null }
  }
}

export function persistScopeSnapshot(snapshot: ScopeSnapshot): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Scope persistence is optional; unavailable storage must not break the app.
  }
}

export function clearScopeSnapshot(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(SCOPE_STORAGE_KEY)
  } catch {
    // Best-effort cleanup.
  }
}

export function threadStage(thread: Thread, draftThreadId?: string | null): ThreadStage {
  if (draftThreadId && thread.id === draftThreadId) return 'todo'
  if (thread.pinned) return 'pinned'
  if (thread.status === 'completed' && !thread.read && !isOrchestrationChildThread(thread)) {
    return 'unread'
  }
  return scopeSliceForStatus(thread.status)
}

export function orderedBuckets(board: ScopeBoard): ScopeBucket[] {
  return [...board.buckets].sort((a, b) => a.sortOrder - b.sortOrder)
}

export function cloneBoard(board: ScopeBoard): ScopeBoard {
  return {
    version: 2,
    buckets: orderedBuckets(board).map((bucket) => ({
      ...bucket,
      collapsedSlices: [...bucket.collapsedSlices],
      root:
        bucket.root.kind === 'worktree'
          ? {
              ...bucket.root,
              setup: {
                ...bucket.root.setup,
                commands: bucket.root.setup.commands.map((command) => ({ ...command }))
              }
            }
          : { kind: 'project' }
    })),
    worktreeDefaults: {
      ...board.worktreeDefaults,
      setupCommands: board.worktreeDefaults.setupCommands.map((command) => ({ ...command }))
    }
  }
}
