import type { Component } from 'svelte'
import CioActivity from '@pdslng/cio-icon/CioActivity.svelte'
import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
import CioCircle from '@pdslng/cio-icon/CioCircle.svelte'
import CioCrossCircle from '@pdslng/cio-icon/CioCrossCircle.svelte'
import CioPause from '@pdslng/cio-icon/CioPause.svelte'
import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
import CioTools from '@pdslng/cio-icon/CioTools.svelte'
import CioAttentionThin from '@pdslng/cio-icon/CioAlertCircle.svelte'
import type { ThreadStatus } from './types'

/**
 * One place that knows what each thread state is called, which tone it draws in,
 * and which inbox group it belongs to. The service stores the desktop's own
 * status values, so this table is the whole translation layer between them and
 * the phone's vocabulary. The labels come from the desktop policy, not from a
 * second naming of the same states.
 */

export type StatusTone =
  'attention' | 'working' | 'working-paused' | 'spec' | 'done' | 'error' | 'todo'

export type InboxGroup = 'attention' | 'drafts' | 'unread' | 'errors' | 'spec' | 'working' | 'done'

export interface StatusSkin {
  label: string
  tone: StatusTone
  group: InboxGroup
  icon: Component<{ size?: number | string; strokeWidth?: number | string }>
}

const SKINS: Readonly<Record<ThreadStatus, StatusSkin>> = {
  created: { label: 'New', tone: 'todo', group: 'drafts', icon: CioCircle },
  planning: { label: 'Planning', tone: 'working', group: 'working', icon: CioActivity },
  awaiting_approval: {
    label: 'Needs attention',
    tone: 'attention',
    group: 'attention',
    icon: CioAttention
  },
  spec: { label: 'Spec ready', tone: 'spec', group: 'spec', icon: CioTools },
  executing: { label: 'Working', tone: 'working', group: 'working', icon: CioActivity },
  'working-paused': { label: 'Paused', tone: 'working-paused', group: 'attention', icon: CioPause },
  interrupted: {
    label: 'Interrupted',
    tone: 'attention',
    group: 'attention',
    icon: CioAttentionThin
  },
  completed: { label: 'Done', tone: 'done', group: 'done', icon: CioCheckCircle },
  failed: { label: 'Failed', tone: 'error', group: 'errors', icon: CioCrossCircle }
}

/** The one status with no row of its own: a draft is a thread nobody started. */
export const DRAFT_ICON = CioPencil

export function statusSkin(status: ThreadStatus): StatusSkin {
  return SKINS[status] ?? SKINS.created
}

/** The colour a tone draws in, read by name from the app's palette. */
export function toneColor(tone: StatusTone): string {
  switch (tone) {
    case 'attention':
      return 'var(--color-warning)'
    case 'spec':
      return 'var(--color-thread-spec)'
    case 'working':
      return 'var(--color-info)'
    case 'error':
      return 'var(--color-danger)'
    case 'done':
      return 'var(--color-muted)'
    case 'working-paused':
      return 'var(--color-warning)'
    case 'todo':
    default:
      return 'var(--color-muted)'
  }
}

/** The order the inbox groups keep, matching the drawer from top to bottom. */
export const INBOX_GROUPS: readonly { id: InboxGroup; label: string; tone?: StatusTone }[] = [
  { id: 'attention', label: 'Attention', tone: 'attention' },
  { id: 'drafts', label: 'Drafts', tone: 'todo' },
  { id: 'unread', label: 'Unread' },
  { id: 'errors', label: 'Errors', tone: 'error' },
  { id: 'spec', label: 'Spec', tone: 'spec' },
  { id: 'working', label: 'Working', tone: 'working' },
  { id: 'done', label: 'Done', tone: 'done' }
]

/** Sort weight inside one list: what needs the user first, quiet work last. */
export const STATUS_WEIGHT: Readonly<Record<ThreadStatus, number>> = {
  awaiting_approval: 0,
  interrupted: 1,
  failed: 2,
  spec: 3,
  'working-paused': 4,
  executing: 5,
  planning: 6,
  created: 7,
  completed: 8
}

/**
 * A phone shows age, never a timestamp. The oldest bucket is weeks because a
 * list on a phone is about relative recency, not an audit trail.
 */
export function formatAge(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.round(days / 7)
  if (weeks < 52) return `${weeks}w`
  return `${Math.round(weeks / 52)}y`
}
