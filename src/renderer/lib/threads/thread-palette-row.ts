import CioChat from '$lib/components/icons/cio/CioChat.svelte'
import { SvelteSet } from 'svelte/reactivity'

import type { Component } from 'svelte'
import type { ActionDefinition } from '$lib/actions'
import { isThreadLiveWorking, statusBadgeForThread } from '$lib/thread-status-badge'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
import { ovens } from '$lib/stores/ovens.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { threadScopeBucket } from '$lib/threads/thread-scope'
import { LOCAL_OVEN_ID } from '$shared/ovens'
import type { Thread } from '$shared/types'

/**
 * One thread row for a command palette, built once and used everywhere.
 *
 * The spotlight's thread search and the composer's relocate picker both list
 * threads, and both must read the way the sidebar does: the same status badge,
 * the same scope badge, the same oven, branch, harness and model metadata. The
 * row language lives here so a second picker cannot quietly invent its own.
 */

/** A thread's last-activity stamp in the shortest readable form. */
export function relativeThreadTime(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

/** The container a thread row belongs to, presented the way the palette
 *  presents a thread's project: its label, colour, and icon. */
export interface ThreadPaletteContainer {
  label: string
  color?: string
  iconUri?: string
  icon?: Component
}

export interface ThreadPaletteRowInput {
  /** The id the palette binds the row to, and reports its selection by. */
  id: ActionDefinition['id']
  thread: Thread
  container: ThreadPaletteContainer
  /** The matching excerpt, when the row came from a message search. */
  snippet?: string
  /** Whether the row may carry the thread's scope badge. Only project threads
   *  belong to a scope board, so a chat or an assistant task passes false. */
  withScope?: boolean
}

/** Build the palette row for one thread. */
export function threadPaletteRow(input: ThreadPaletteRowInput): ActionDefinition {
  const { id, thread, container, snippet } = input
  const isLiveWorking = isThreadLiveWorking(thread)
  const status = statusBadgeForThread(
    thread,
    isLiveWorking,
    rendererRecovery.queuedMessageCount(thread.projectId, thread.id) > 0
  )
  // Model/harness metadata for the row: while the thread is working the current
  // provider + model is shown, otherwise the thread's harnesses and provider
  // appear as icons - mirroring the sidebar thread row.
  const harnessIds = Array.from(
    new SvelteSet([
      ...(thread.usedHarnessIds ?? []),
      ...(thread.settings?.harnessId ? [thread.settings.harnessId] : [])
    ])
  )
  const providerId = thread.settings?.providerId ?? thread.providerId
  const providers = providerCatalog.cached(thread.projectId) ?? providerCatalog.allCached()
  const providerName = providerId
    ? (providers.find((provider) => provider.id === providerId)?.name ?? null)
    : null
  // Thread rows always surface the thread's last-activity time, never its
  // creation time, so freshly worked-on threads read as "1h" etc.
  const activityLabel = relativeThreadTime(thread.lastActivity)
  // The thread's scope, so the row says which scope it belongs to - the same
  // signal the sidebar thread rows and the hover card already carry.
  const scope = input.withScope === false ? null : threadScopeBucket(thread)
  // Oven and branch, the two facts about where a thread actually runs.
  const oven =
    thread.settings?.ovenId && thread.settings.ovenId !== LOCAL_OVEN_ID
      ? ovens.identity(thread.settings.ovenId)
      : null
  const branch = thread.branch?.trim() || null
  return {
    id,
    title: thread.title,
    description: snippet
      ? `${container.label} · ${activityLabel} · ${snippet}`
      : `${container.label} · ${activityLabel}`,
    category: 'thread',
    source: {
      id: `project:${thread.projectId}`,
      label: container.label,
      kind: 'app',
      ...(container.color ? { color: container.color } : {})
    },
    showSourceBadge: false,
    ...(container.iconUri ? { iconUri: container.iconUri } : { icon: container.icon ?? CioChat }),
    ...(status ? { status } : {}),
    ...(scope ? { scope } : {}),
    threadMeta: {
      working: isLiveWorking,
      harnessIds,
      providerName,
      providerId,
      modelId: thread.settings?.modelId ?? null,
      ...(oven ? { oven: { name: oven.name, iconUrl: oven.iconUrl } } : {}),
      ...(branch ? { branch } : {})
    },
    keywords: [
      container.label,
      thread.title,
      ...(oven ? [oven.name] : []),
      ...(branch ? [branch] : []),
      ...(snippet ? [snippet] : [])
    ]
  }
}
