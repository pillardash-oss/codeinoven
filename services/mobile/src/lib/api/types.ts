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

/** The reasoning levels the composer's thinking chip offers, in the app's order. */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/** How tool calls are approved for a message this composer writes. */
export type PermissionLevel = 'auto_review' | 'full_access'

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
  /** The composer's own choices for this thread. Each is nullable, because a
   *  thread mirrored before the composer existed has no choice to report. */
  thinking: ThinkingLevel | null
  permission: PermissionLevel | null
  /** The account label a message from this thread runs as. */
  account: string | null
  /** The Oven the phone sends to; null is the local machine. */
  ovenId: string | null
  /** The plus menu's File System switch, as the desktop draws it. */
  fileSystem: boolean
  /** The context the model offers, and when the meter was last reset. */
  contextWindow: number | null
  usageResetAt: number | null
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
  /** What this turn consumed, when the run recorded it. Absent is not zero. */
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number | null
  costMicros: number | null
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

/**
 * A machine that reported in to this account. The descriptor is whatever the Oven
 * chose to say about itself (host, platform, the harnesses it offers), so it is
 * read as a record rather than guessed at here.
 */
export interface Oven {
  id: string
  name: string
  fingerprint: string
  lastHeartbeatAt: number
  descriptor: Record<string, unknown> | null
}

/** One file the phone attached to a message. The bytes stay on the service; the
 *  prompt states what came with it, and the desktop fetches them by id. */
export interface Attachment {
  id: string
  threadId: string
  promptId: string | null
  name: string
  mime: string
  size: number
  createdAt: number
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
  /** The composer's choices at the moment the message was sent. */
  model: string | null
  thinking: ThinkingLevel | null
  permission: PermissionLevel | null
  account: string | null
  ovenId: string | null
  fileSystem: boolean
  attachments: Attachment[]
}

/** One model the service offers, in the picker's own grouping. */
export interface Model {
  id: string
  name: string
  provider: string
  providerLabel: string
  favorite: boolean
}

/** The picker's list plus the model ids this account used most recently. */
export interface ModelCatalog {
  items: Model[]
  recent: string[]
}

/** What the meter and its panel read, derived from stored token counts. */
export interface ThreadUsage {
  used: number
  window: number
  leftBeforeCompact: number
  thisTurn: { input: number; output: number }
  rate: number
  costMicros: number
  since: number | null
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
