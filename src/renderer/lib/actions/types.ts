import type { Component } from 'svelte'

export type ActionId = `${string}:${string}`

export type ActionCategory =
  | 'navigation'
  | 'model'
  | 'reasoning'
  | 'mode'
  | 'command'
  | 'skill'
  | 'mcp'
  | 'target'
  | 'file'
  | 'thread'
  | 'other'

export type ActionSourceKind = 'app' | 'harness' | 'plugin'

export interface ActionSource {
  id: string
  label: string
  kind: ActionSourceKind
  /** Accent color for the source badge (e.g. a project's color). */
  color?: string
}

export interface ActionDefinition {
  id: ActionId
  title: string
  description?: string
  category: ActionCategory
  source: ActionSource
  /** Set false when the source is already presented in the action's supporting metadata. */
  showSourceBadge?: boolean
  keywords?: readonly string[]
  shortcut?: readonly string[]
  disabledReason?: string
  /** Optional lucide icon rendered in place of the category letter badge. */
  icon?: Component
  /** Optional colored data-URI (e.g. a file/folder icon) rendered in the badge. */
  iconUri?: string
  /** Optional live status rendered as a colored badge + human label (e.g. thread
   *  working / retrying / error) so results can be distinguished at a glance. */
  status?: ActionStatusBadge
  /** Optional thread model/harness metadata rendered at the end of the
   *  description row: the currently working provider + model while the thread
   *  is working, otherwise the thread's harnesses and provider as icons. */
  threadMeta?: ActionThreadMeta
}

export interface ActionThreadMeta {
  /** Whether the thread is currently working — picks the current model over the history icons. */
  working: boolean
  /** Distinct harnesses associated with the thread, newest first. */
  harnessIds: readonly string[]
  /** Resolved provider display name for the thread's current model. */
  providerName: string | null
  /** Provider id of the thread's current model — drives icon resolution. */
  providerId: string | null
  /** Model identifier of the thread's current model. */
  modelId: string | null
}

export interface ActionStatusBadge {
  /** Human-readable status text shown next to the colored dot. */
  label: string
  stage?: 'pinned' | 'todo' | 'working' | 'spec' | 'issue' | 'unread' | 'done'
  tone?: 'todo' | 'working' | 'working-paused' | 'attention' | 'spec' | 'done' | 'error'
  kind?: 'completed' | 'chat-completed' | 'attention' | 'spec' | 'error'
  variant?: 'dot' | 'spinner'
  animated?: boolean
}

export interface ActionSelection {
  action: ActionDefinition
  query: string
  method: 'keyboard' | 'pointer'
}

export interface ActionFilterOptions {
  limit?: number
  categories?: readonly ActionCategory[]
  sources?: readonly string[]
}
