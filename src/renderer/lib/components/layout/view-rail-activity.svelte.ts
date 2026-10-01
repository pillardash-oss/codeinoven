import { createSubscriber, SvelteSet } from 'svelte/reactivity'
import type { Component } from 'svelte'
import { BotMessageSquare, Download, MessageSquare, Timeline } from '@lucide/svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import {
  browserDownloads,
  type BrowserDownloadOutstanding
} from '$lib/stores/browser-downloads.svelte'
import { browserAssistant } from '$lib/stores/browser-assistant.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { contentThreadFamily, type ContentThreadFamily } from '$lib/content-view-threads'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
import { coordinatorHasActiveDelegates, isOrchestrationChildThread } from '$shared/types'
import { threadWorkingForIndicator } from './app-header-thread-status'
import type { HeaderViewOptionId } from './AppHeaderNavigationController.svelte'

/**
 * Live activity for the primary-view rail.
 *
 * The rail puts the view switcher on its own docked rail, so each view carries
 * only its own family's activity instead of one trigger carrying every family's
 * badges at once. Projects, Threads, Scoped threads and Scope Board are all the
 * project family and therefore share the project badge; Chats and Assistant
 * each carry their own.
 *
 * The Browser is the one view whose badge is not a thread family. A browser tab
 * owns an assistant conversation that is a real thread but is deliberately held
 * out of every list, and the profile keeps downloading after the user leaves the
 * view, so its item reports both ({@link ViewRailActivity.browserAssistant} and
 * {@link ViewRailActivity.browserTransfers}).
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

  /**
   * A browser tab's assistant conversation, counted apart from every other family.
   *
   * These rows are held out of `scopeState.allScopeThreads` on purpose, so no
   * family badge can ever see them and the Browser item used to report only
   * downloads. A conversation could then sit working, or wait on a question with
   * no card the user could find, while the rail said nothing at all.
   *
   * Counted with the same rules as a family ({@link ViewRailActivity.counts}), so
   * a browser chat and a workspace chat read identically on the rail.
   */
  browserAssistant: ViewFamilyActivity = $derived.by((): ViewFamilyActivity => {
    // Same retry clock as the family counts: a browser chat parked on a long
    // scheduled retry has to leave this count on its own, without waiting for
    // some other family's row to keep the clock alive.
    if (agentRuns.hasPendingRetry) subscribeToRetryClock()
    const activity = emptyFamilyActivity()
    const now = Date.now()
    for (const thread of browserAssistant.threads) {
      if (thread.archived) continue
      if (threadWorkingForIndicator(thread, now)) {
        activity.working += 1
        continue
      }
      if (thread.status === 'awaiting_approval') activity.attention += 1
      else if (thread.status === 'failed') {
        activity.attention += 1
        activity.attentionError = true
      } else if (thread.status === 'working-paused') activity.retry += 1
    }
    return activity
  })

  /**
   * The Browser view's own rail activity: the global browser profile's
   * outstanding downloads.
   *
   * A download is the one thing the browser keeps doing after the user leaves
   * it. The transfer runs on while another view is on screen, and the list that
   * shows it lives inside the view they left, so the rail's Browser item is the
   * only surface that can say a download is still running.
   *
   * Counted for the global profile, which is the browser the Browser view opens
   * and therefore the exact set its own downloads panel lists: a badge that
   * promised more than the destination shows would be a badge the user cannot
   * act on. The renderer mirror is read directly rather than the browser's
   * runtime, so nothing about the browser itself joins the first-paint chunk.
   */
  browserTransfers: BrowserDownloadOutstanding = $derived(
    browserDownloads.outstandingCounts(GLOBAL_BROWSER_PROJECT_ID)
  )
}
/**
 * The single activity pill a rail view shows, chosen by priority: working
 * outranks attention, which outranks a parked retry. The returned label always
 * carries the family's full breakdown. Returns null when the family is quiet.
 *
 * The project family spans four views (Projects, Threads, Scoped threads, Scope
 * Board), so its badge rides only one of them at a time: the option the caller
 * resolved as `projectBadgeOption`, which is the live project view when one is
 * shown, or the last project view the user was on when a view that owns another
 * family (Chat, Assistant) or no threads at all (the Browser) is on screen.
 * Chats and Assistant each have a single view and keep their badge there. The
 * Browser owns no listed thread family of its own, so its item reports the tab
 * assistant conversations behind it (see {@link browserAgentBadge}) and falls
 * back to the profile's downloads (see {@link browserTransferBadge}).
 */
export function viewBadgeFor(
  optionId: HeaderViewOptionId,
  projectBadgeOption: HeaderViewOptionId | null,
  counts: ViewActivityCounts,
  browserTransfers: BrowserDownloadOutstanding,
  browserAssistantActivity: ViewFamilyActivity = emptyFamilyActivity()
): ViewBadge | null {
  if (optionId === 'browser') {
    return browserAgentBadge(browserAssistantActivity) ?? browserTransferBadge(browserTransfers)
  }
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

/**
 * The Browser item's badge for the tab assistant conversations it owns.
 *
 * A conversation waiting on the user outranks one that is working, because
 * working is self-resolving while a question only clears when someone answers
 * it. It outranks the transfer badge too: a conversation blocked on the user is
 * the one thing on this view that time alone does not clear, so it is the one
 * thing the badge must not hide behind a download count.
 */
function browserAgentBadge(activity: ViewFamilyActivity): ViewBadge | null {
  if (activity.attention > 0) {
    return {
      tone: activity.attentionError ? 'error' : 'attention',
      count: activity.attention,
      label: browserAssistantLabel(activity.attention, activity.attention === 1 ? 'needs' : 'need'),
      icon: FAMILY_ICONS.chats
    }
  }
  if (activity.working > 0) {
    return {
      tone: 'working',
      count: activity.working,
      label: browserAssistantLabel(activity.working, activity.working === 1 ? 'is' : 'are'),
      icon: FAMILY_ICONS.chats
    }
  }
  if (activity.retry > 0) {
    return {
      tone: 'retry',
      count: activity.retry,
      label: browserAssistantLabel(
        activity.retry,
        activity.retry === 1 ? 'is waiting to retry' : 'are waiting to retry'
      ),
      icon: FAMILY_ICONS.chats
    }
  }
  return null
}

/** Tooltip/aria text for a browser tab's assistant conversations: how many of
 *  them, and what they are doing. */
function browserAssistantLabel(count: number, verb: string): string {
  const head = count === 1 ? '1 browser chat' : `${count} browser chats`
  return `${head} ${verb}`
}

/**
 * The Browser item's badge: the profile's outstanding downloads, in the working
 * tone while any of them is transferring and in the attention tone once every
 * one of them is stopped and waiting on the user.
 *
 * It stays up while the Browser is the view on screen, exactly as a thread
 * family's badge does: a download outlives the visit, and the rail is what says
 * the browser is still busy once the user looks away.
 */
function browserTransferBadge(transfers: BrowserDownloadOutstanding): ViewBadge | null {
  const count = transfers.running + transfers.stopped
  if (count === 0) return null
  return {
    tone: transfers.running > 0 ? 'working' : 'attention',
    count,
    label: browserTransferLabel(transfers),
    icon: Download
  }
}

/** Tooltip/aria text for the Browser badge: how much is transferring, and how
 *  much is stopped and waiting on a resume or a restart. */
function browserTransferLabel(transfers: BrowserDownloadOutstanding): string {
  const count = transfers.running + transfers.stopped
  const head = count === 1 ? '1 browser download' : `${count} browser downloads`
  if (transfers.stopped === 0) return `${head} in progress`
  if (transfers.running === 0) return `${head} stopped, waiting to resume or restart`
  return `${head}: ${transfers.running} in progress, ${transfers.stopped} stopped`
}
