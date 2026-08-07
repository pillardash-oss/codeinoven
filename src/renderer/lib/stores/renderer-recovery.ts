import { APP_SLUG } from '$shared/brand'
import type {
  PromptAssignmentTaskReference,
  PromptAttachment,
  PromptProjectReference,
  PromptReference,
  UserMessagePresentation
} from '$shared/types'

export const RENDERER_RECOVERY_STORAGE_KEY = `${APP_SLUG}.rendererRecovery.v1`

/** A settings section — each is its own dedicated page in the app navigation. */
export type SettingsSection =
  'general' | 'memory' | 'audits' | 'harnesses' | 'utilities' | 'remote' | 'about'

export type MainView =
  | 'projects'
  | 'chats'
  | 'scope'
  | 'threads'
  | 'settings'
  | 'settings-memory'
  | 'settings-audits'
  | 'settings-harnesses'
  | 'settings-utilities'
  | 'settings-remote'
  | 'settings-about'

export interface SelectedThreadReference {
  projectId: string
  threadId: string
}

/** A single saved composer draft — text plus any file attachments. */
export interface ComposerDraftEntry {
  text: string
  attachments: PromptAttachment[]
  projectReferences: PromptProjectReference[]
  taskReferences: PromptAssignmentTaskReference[]
}

/** A selected assistant-response excerpt anchored to a message range. */
export interface QueuedResponseReference extends PromptReference {
  messageId: string
  startOffset: number
  endOffset: number
}

/**
 * A message queued while the agent was busy. Kept in the recovery snapshot so
 * an app refresh or state restart never drops it; it is cleared once sent,
 * steered, edited back into the composer, or deleted.
 */
export interface QueuedMessageEntry {
  text: string
  attachments: PromptAttachment[]
  promptContext?: string
  promptReferences: QueuedResponseReference[]
  projectReferences: PromptProjectReference[]
  presentation?: UserMessagePresentation
  taskReferences: PromptAssignmentTaskReference[]
}

export interface RendererRecoverySnapshot {
  version: 1
  activeView: MainView
  selectedProjectId: string | null
  selectedThread: SelectedThreadReference | null
  composerDrafts: Record<string, ComposerDraftEntry>
  /** Queued messages awaiting an idle agent, keyed like composer drafts. */
  queuedMessages: Record<string, QueuedMessageEntry>
  /** Project ids the user has manually collapsed in the sidebar. */
  collapsedFolders: string[]
  /** Model keys (providerId:modelId) the user has favorited for quick access. */
  favoriteModels: string[]
  /** Model keys (providerId:modelId) the user has recently used, most recent first. */
  recentModels: string[]
  /** Chats-tab favorites — kept separate from project favorites so chatting with
   *  a cheap model never reshapes the project model list. */
  chatFavoriteModels: string[]
  /** Chats-tab recently used models, most recent first. */
  chatRecentModels: string[]
  /** Default audit model key (harnessId:providerId:modelId). */
  auditModelKey?: string
}

export interface RecoveryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const MAIN_VIEWS: readonly MainView[] = [
  'projects',
  'chats',
  'scope',
  'threads',
  'settings',
  'settings-memory',
  'settings-audits',
  'settings-harnesses',
  'settings-utilities',
  'settings-remote',
  'settings-about'
]
const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'general',
  'memory',
  'audits',
  'harnesses',
  'utilities',
  'remote',
  'about'
]
const SETTINGS_VIEW_PREFIX = 'settings-'
const MAX_ID_LENGTH = 512
export const MAX_DRAFT_LENGTH = 100_000
export const MAX_RECOVERY_DRAFTS = 200

export function emptyRendererRecoverySnapshot(): RendererRecoverySnapshot {
  return {
    version: 1,
    activeView: 'projects',
    selectedProjectId: null,
    selectedThread: null,
    composerDrafts: {},
    queuedMessages: {},
    collapsedFolders: [],
    favoriteModels: [],
    recentModels: [],
    chatFavoriteModels: [],
    chatRecentModels: [],
    auditModelKey: undefined
  }
}

function isPromptAttachment(value: unknown): value is PromptAttachment {
  return (
    isRecord(value) &&
    typeof value.mime === 'string' &&
    typeof value.url === 'string' &&
    (value.filename === undefined || typeof value.filename === 'string')
  )
}

function isPromptProjectReference(value: unknown): value is PromptProjectReference {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    (value.kind === 'file' || value.kind === 'directory')
  )
}

function isPromptAssignmentTaskReference(value: unknown): value is PromptAssignmentTaskReference {
  const taskStatuses = [
    'planned',
    'blocked',
    'ready',
    'running',
    'reported',
    'auditing',
    'rework',
    'attention',
    'completed',
    'failed'
  ]
  return (
    isRecord(value) &&
    typeof value.assignmentId === 'string' &&
    typeof value.taskId === 'string' &&
    typeof value.phaseId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    typeof value.status === 'string' &&
    taskStatuses.includes(value.status) &&
    (value.workerName === undefined || typeof value.workerName === 'string') &&
    (value.threadId === undefined || typeof value.threadId === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isQueuedResponseReference(value: unknown): value is QueuedResponseReference {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    typeof value.text === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.startOffset === 'number' &&
    typeof value.endOffset === 'number' &&
    (value.comment === undefined || typeof value.comment === 'string')
  )
}

function isUserMessagePresentation(value: unknown): value is UserMessagePresentation {
  return (
    isRecord(value) &&
    typeof value.action === 'string' &&
    (value.body === undefined || typeof value.body === 'string')
  )
}

export function isRecoveryIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value
  )
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && SETTINGS_SECTIONS.some((section) => section === value)
}

/** The MainView for a settings section — General lives at 'settings'. */
export function settingsViewForSection(section: SettingsSection): MainView {
  return section === 'general' ? 'settings' : `${SETTINGS_VIEW_PREFIX}${section}`
}

/** True when the view is a settings section page (General or any settings-* page). */
export function isSettingsView(view: MainView): boolean {
  return view === 'settings' || view.startsWith(SETTINGS_VIEW_PREFIX)
}

/** The settings section for a settings view; null for non-settings views. */
export function settingsSectionForView(view: MainView): SettingsSection | null {
  if (view === 'settings') return 'general'
  if (view.startsWith(SETTINGS_VIEW_PREFIX)) {
    const section = view.slice(SETTINGS_VIEW_PREFIX.length)
    return isSettingsSection(section) ? section : null
  }
  return null
}

/** Migrate legacy standalone 'providers'/'remote' views into their settings pages. */
function normalizeMainView(value: unknown): MainView | null {
  if (value === 'providers') return settingsViewForSection('harnesses')
  if (value === 'settings-providers') return 'settings-harnesses'
  if (value === 'remote') return settingsViewForSection('remote')
  return typeof value === 'string' && MAIN_VIEWS.some((view) => view === value)
    ? (value as MainView)
    : null
}

export function recoveryDraftKey(projectId: string, threadId: string): string {
  return JSON.stringify([projectId, threadId])
}

function isDraftKey(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value)
    return (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      isRecoveryIdentifier(parsed[0]) &&
      isRecoveryIdentifier(parsed[1])
    )
  } catch {
    return false
  }
}

function parseSelectedThread(value: unknown): SelectedThreadReference | null {
  if (!isRecord(value)) return null
  if (!isRecoveryIdentifier(value.projectId) || !isRecoveryIdentifier(value.threadId)) return null
  return { projectId: value.projectId, threadId: value.threadId }
}

function parseFavoriteModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((s): s is string => typeof s === 'string' && s.length > 0)
}

function parseCollapsedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => isRecoveryIdentifier(id))
}

function parseDrafts(value: unknown): Record<string, ComposerDraftEntry> {
  if (!isRecord(value)) return {}

  const drafts: Record<string, ComposerDraftEntry> = {}
  let count = 0
  for (const [key, raw] of Object.entries(value)) {
    if (count >= MAX_RECOVERY_DRAFTS) break
    if (!isDraftKey(key)) continue

    // Backwards compatibility: old snapshots stored a plain string.
    if (typeof raw === 'string' && raw.length <= MAX_DRAFT_LENGTH) {
      drafts[key] = { text: raw, attachments: [], projectReferences: [], taskReferences: [] }
      count += 1
      continue
    }

    if (!isRecord(raw)) continue
    const text = typeof raw.text === 'string' ? raw.text : ''
    if (text.length > MAX_DRAFT_LENGTH) continue

    const attachments = Array.isArray(raw.attachments)
      ? raw.attachments.filter(isPromptAttachment)
      : []
    const projectReferences = Array.isArray(raw.projectReferences)
      ? raw.projectReferences.filter(isPromptProjectReference).slice(0, 20)
      : []
    const taskReferences = Array.isArray(raw.taskReferences)
      ? raw.taskReferences.filter(isPromptAssignmentTaskReference).slice(0, 20)
      : []
    drafts[key] = { text, attachments, projectReferences, taskReferences }
    count += 1
  }
  return drafts
}

function parseQueuedMessages(value: unknown): Record<string, QueuedMessageEntry> {
  if (!isRecord(value)) return {}

  const queued: Record<string, QueuedMessageEntry> = {}
  let count = 0
  for (const [key, raw] of Object.entries(value)) {
    if (count >= MAX_RECOVERY_DRAFTS) break
    if (!isDraftKey(key)) continue
    if (!isRecord(raw)) continue

    const text = typeof raw.text === 'string' ? raw.text : ''
    if (text.length === 0 || text.length > MAX_DRAFT_LENGTH) continue

    const attachments = Array.isArray(raw.attachments)
      ? raw.attachments.filter(isPromptAttachment)
      : []
    const promptReferences = Array.isArray(raw.promptReferences)
      ? raw.promptReferences.filter(isQueuedResponseReference).slice(0, 20)
      : []
    const projectReferences = Array.isArray(raw.projectReferences)
      ? raw.projectReferences.filter(isPromptProjectReference).slice(0, 20)
      : []
    const taskReferences = Array.isArray(raw.taskReferences)
      ? raw.taskReferences.filter(isPromptAssignmentTaskReference).slice(0, 20)
      : []
    queued[key] = {
      text,
      attachments,
      promptContext: typeof raw.promptContext === 'string' ? raw.promptContext : undefined,
      promptReferences,
      projectReferences,
      presentation: isUserMessagePresentation(raw.presentation) ? raw.presentation : undefined,
      taskReferences
    }
    count += 1
  }
  return queued
}

/**
 * Parse renderer recovery data without trusting localStorage contents.
 * Invalid fields fall back independently so one corrupt value cannot block startup.
 */
export function parseRendererRecoveryState(raw: string | null): RendererRecoverySnapshot {
  if (!raw) return emptyRendererRecoverySnapshot()

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1) return emptyRendererRecoverySnapshot()

    const selectedThread = parseSelectedThread(parsed.selectedThread)
    const selectedProjectId =
      selectedThread?.projectId ??
      (isRecoveryIdentifier(parsed.selectedProjectId) ? parsed.selectedProjectId : null)

    return {
      version: 1,
      activeView: normalizeMainView(parsed.activeView) ?? 'projects',
      selectedProjectId,
      selectedThread,
      composerDrafts: parseDrafts(parsed.composerDrafts),
      queuedMessages: parseQueuedMessages(parsed.queuedMessages),
      collapsedFolders: parseCollapsedFolders(parsed.collapsedFolders),
      favoriteModels: parseFavoriteModels(parsed.favoriteModels),
      recentModels: parseFavoriteModels(parsed.recentModels),
      chatFavoriteModels: parseFavoriteModels(parsed.chatFavoriteModels),
      chatRecentModels: parseFavoriteModels(parsed.chatRecentModels),
      auditModelKey:
        typeof parsed.auditModelKey === 'string' && parsed.auditModelKey.length > 0
          ? parsed.auditModelKey
          : undefined
    }
  } catch {
    return emptyRendererRecoverySnapshot()
  }
}

export function browserRecoveryStorage(): RecoveryStorage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function loadRendererRecoveryState(
  storage: RecoveryStorage | undefined
): RendererRecoverySnapshot {
  try {
    return parseRendererRecoveryState(storage?.getItem(RENDERER_RECOVERY_STORAGE_KEY) ?? null)
  } catch {
    return emptyRendererRecoverySnapshot()
  }
}

export function persistRendererRecoveryState(
  storage: RecoveryStorage | undefined,
  snapshot: RendererRecoverySnapshot
): void {
  try {
    storage?.setItem(RENDERER_RECOVERY_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Recovery state is optional; unavailable storage must not break the renderer.
  }
}

export function removeRendererRecoveryState(storage: RecoveryStorage | undefined): void {
  try {
    storage?.removeItem(RENDERER_RECOVERY_STORAGE_KEY)
  } catch {
    // Recovery state is optional; unavailable storage must not break the renderer.
  }
}
