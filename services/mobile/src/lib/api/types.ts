/**
 * The wire types of the service contract in `services/README.md`. The names and
 * shapes match the desktop's own types, so a mirrored row needs no translation
 * and a field can move between the two without a rename.
 */

export type ThreadStatus =
  | 'created'
  | 'planning'
  | 'awaiting_approval'
  | 'spec'
  | 'executing'
  | 'working-paused'
  | 'interrupted'
  | 'completed'
  | 'failed'

export type DevicePlatform = 'desktop' | 'ios' | 'android'

export type ProjectSource = 'local' | 'ssh'

export interface User {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  emailVerifiedAt: number | null
  createdAt: number
}

export interface StoreSummary {
  kind: 'hosted' | 'self_hosted'
  schemaVersion: number
  requiredVersion: number
  migratable: boolean
}

export interface AccountUser extends User {
  store: StoreSummary | null
}

export interface Device {
  id: string
  name: string
  platform: DevicePlatform
  lastSeenAt: number
  createdAt: number
  current: boolean
}

export interface StatusCounts {
  attention: number
  spec: number
  working: number
  done: number
  failed: number
}

export interface Project {
  id: string
  name: string
  path: string
  source: ProjectSource
  host: string | null
  ovenId: string | null
  providerId: string
  workflowId: string
  icon: string | null
  color: string | null
  iconType: string | null
  customSvg: string | null
  pinned: boolean
  hidden: boolean
  sortOrder: number | null
  threadCount: number
  unreadCount: number
  statusCounts: StatusCounts
  createdAt: number
  updatedAt: number
}

export interface Thread {
  id: string
  projectId: string
  title: string
  status: ThreadStatus
  read: boolean
  pinned: boolean
  archived: boolean
  drafting: boolean
  /** The model and harness that answer this thread, as the desktop states them
   *  in its own composer. Both are optional in the store. */
  model: string | null
  harness: string | null
  lastError: string | null
  messageCount: number
  lastMessagePreview: string | null
  lastActivity: number
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: string
  threadId: string
  role: 'user' | 'assistant'
  body: string
  seq: number
  createdAt: number
}

export interface Assistant {
  id: string
  name: string
  description: string
  scheduleName: string | null
  color: string | null
  customSvg: string | null
  scheduled: boolean
  paused: boolean
  threadCount: number
  lastRunAt: number | null
  updatedAt: number
}

export interface Session {
  id: string
  deviceId: string | null
  userAgent: string | null
  createdAt: number
  lastUsedAt: number
  expiresAt: number
  current: boolean
}

export interface Prompt {
  id: string
  threadId: string
  body: string
  /** `steering` means the oven takes it next, ahead of the rest of the queue. */
  state: 'queued' | 'claimed' | 'steering' | 'done' | 'failed'
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface AuthResult {
  user: User
  token: string
  device: Device
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}
