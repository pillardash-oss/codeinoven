import { createSubscriber, SvelteSet } from 'svelte/reactivity'
import type { Component } from 'svelte'
import { BotMessageSquare, MessageSquare, Timeline } from '@lucide/svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { contentThreadFamily, type ContentThreadFamily } from '$lib/content-view-threads'
import { coordinatorHasActiveDelegates, isOrchestrationChildThread } from '$shared/types'
import { threadWorkingForIndicator } from './app-header-thread-status'
import type { HeaderViewOptionId } from './AppHeaderNavigationController.svelte'

/**
 * Live thread activity for the primary-view rail.
 *
 * The rail puts the view switcher on its own docked rail, so each view carries
 * only its own family's activity instead of one trigger carrying every family's
 * badges at once. Projects, Threads, Scoped threads and Scope Board are all the
 * project family and therefore share the project badge; Chats and Assistant
 * each carry their own.
 */
export interface ViewFamilyActivity {
  working: number
  attention: number
  /** True when an attention thread in the family has actually failed. */
  attentionError: boolean
  retry: number
}

export interface ViewActivityCounts {
  projects: ViewFamilyActivity
  chats: ViewFamilyActivity
  assistant: ViewFamilyActivity
}

export type ViewBadgeTone = 'working' | 'attention' | 'error' | 'retry'

export interface ViewBadge {
  tone: ViewBadgeTone
  count: number
  /** Accessible label carrying the full family breakdown, not just the shown count. */
  label: string
  /** Family glyph rendered inside the count pill. */
  icon: Component
}

/** The three families the rail's badges and labels are keyed by. */
const FAMILY_ICONS: Record<ContentThreadFamily, Component> = {
  projects: Timeline,
  chats: MessageSquare,
  assistant: BotMessageSquare
}

const FAMILY_NOUN: Record<ContentThreadFamily, string> = {
  projects: 'project thread',
  chats: 'chat',
  assistant: 'assistant thread'
}

/** How often a parked retry wait is re-checked so a reset that falls back
 *  inside the wake window rejoins the working count. */
const RETRY_WINDOW_RECHECK_MS = 60_000
const subscribeToRetryClock = createSubscriber((update) => {
  const timer = window.setInterval(update, RETRY_WINDOW_RECHECK_MS)
  return () => window.clearInterval(timer)
})

function emptyFamilyActivity(): ViewFamilyActivity {
  return { working: 0, attention: 0, attentionError: false, retry: 0 }
}

/** The family a rail view belongs to. Every project-mode view shares one badge. */
export function viewOptionFamily(optionId: HeaderViewOptionId): ContentThreadFamily {
  if (optionId === 'chats') return 'chats'
  if (optionId === 'assistant') return 'assistant'
  return 'projects'
}

function plural(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`
}

/** Tooltip/aria text naming every active group in the family, so a hidden
 *  attention or retry group is still reachable from the single pill. */
function familyActivityLabel(family: ContentThreadFamily, activity: ViewFamilyActivity): string {
  const noun = FAMILY_NOUN[family]
  const parts: string[] = []
  if (activity.working > 0) {
    parts.push(`${activity.working} ${plural(noun, activity.working)} working`)
  }
  if (activity.attention > 0) {
    parts.push(
      `${activity.attention} ${plural(noun, activity.attention)} need${
        activity.attention === 1 ? 's' : ''
      } attention`
    )
  }
  if (activity.retry > 0) {
    parts.push(`${activity.retry} ${plural(noun, activity.retry)} waiting to retry`)
  }
  return parts.join(', ')
}

/**
 * Thread counts per family, feeding the activity badges on the view rail.
 *
 * Working threads pulse in the working tone; threads parked on
 * `working-paused` pulse in the retry tone; threads in `awaiting_approval` or
 * `failed` pulse in the attention tone (error-red when a failure is inside the
 * family). Orchestration children are folded into their coordinator (same rule
 * as the sidebar rows) so a delegated run counts once instead of inflating the
 * total with hidden worker threads. A live-working thread always counts as
 * working, never as attention/retry, so no thread is ever double-counted.
 */
export class ViewRailActivity {
  counts: ViewActivityCounts = $derived.by((): ViewActivityCounts => {
    const threads = scopeState.allScopeThreads
    // Re-check on a coarse clock only while a retry deadline is tracked, so a
    // 6h+ parked wait rejoins the count once its reset gets close.
    if (agentRuns.hasPendingRetry) subscribeToRetryClock()
    const now = Date.now()
    const working = threads.filter(
      (thread) => !thread.archived && threadWorkingForIndicator(thread, now)
    )
    // The working predicate reads the agent-run store, so evaluate it once per
    // thread instead of once in the filter above and again in the loop below.
    const workingIds = new SvelteSet(working.map((thread) => thread.id))
    const counts: ViewActivityCounts = {
      projects: emptyFamilyActivity(),
      chats: emptyFamilyActivity(),
      assistant: emptyFamilyActivity()
    }
    for (const thread of threads) {
      if (thread.archived || isOrchestrationChildThread(thread)) continue
      const bucket = counts[contentThreadFamily(thread)]
      const isWorking = workingIds.has(thread.id) || coordinatorHasActiveDelegates(thread, working)
      if (isWorking) {
        bucket.working += 1
        continue
      }
      if (thread.status === 'working-paused') {
        bucket.retry += 1
        continue
      }
      if (thread.status === 'awaiting_approval' || thread.status === 'failed') {
        bucket.attention += 1
        if (thread.status === 'failed') bucket.attentionError = true
      }
    }
    return counts
  })
}
/**
 * The single activity pill a rail view shows, chosen by priority: working
 * outranks attention, which outranks a parked retry. The returned label always
 * carries the family's full breakdown. Returns null when the family is quiet.
 *
 * The project family spans four views (Projects, Threads, Scoped threads, Scope
 * Board), so its badge rides only one of them at a time: the option the caller
 * resolved as `projectBadgeOption`, which is the live project view when one is
 * shown, or the last project view the user was on when a non-project view (the
 * Browser) is on screen. Chats and Assistant each have a single view and keep
 * their badge there.
 */
export function viewBadgeFor(
  optionId: HeaderViewOptionId,
  projectBadgeOption: HeaderViewOptionId | null,
  counts: ViewActivityCounts
): ViewBadge | null {
  const family = viewOptionFamily(optionId)
  if (family === 'projects' && optionId !== projectBadgeOption) return null
  const activity = counts[family]
  const icon = FAMILY_ICONS[family]
  if (activity.working > 0) {
    return {
      tone: 'working',
      count: activity.working,
      label: familyActivityLabel(family, activity),
      icon
    }
  }
  if (activity.attention > 0) {
    return {
      tone: activity.attentionError ? 'error' : 'attention',
      count: activity.attention,
      label: familyActivityLabel(family, activity),
      icon
    }
  }
  if (activity.retry > 0) {
    return {
      tone: 'retry',
      count: activity.retry,
      label: familyActivityLabel(family, activity),
      icon
    }
  }
  return null
}
