import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
import CioProjects from '@pdslng/cio-icon/CioProjects.svelte'
import { createSubscriber } from 'svelte/reactivity'
import type { Component } from 'svelte'
import { CONTENT_FAMILY_ICONS } from '$lib/content-view-icons'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import {
  browserDownloads,
  type BrowserDownloadOutstanding
} from '$lib/stores/browser-downloads.svelte'
import { browserAssistant } from '$lib/stores/browser-assistant.svelte'
import { speechController } from '$lib/speech/speech-controller.svelte'
import { browserAudio } from '$lib/stores/browser-audio.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { contentThreadFamily, type ContentThreadFamily } from '$lib/content-view-threads'
import {
  countThreadStates,
  countThreadStatesByGroup,
  emptyThreadStateCounts,
  type ThreadStateCounts
} from '$lib/thread-state-counts'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
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
 *
 * The figures themselves come from `$lib/thread-state-counts`, the one pass over
 * the one in-memory thread list that also feeds the sidebar's project rows: the
 * rail and a project strip are two views of the same counts, so they can never
 * report different numbers for the same threads.
 */
export type ViewActivityCounts = Record<ContentThreadFamily, ThreadStateCounts>

export type ViewBadgeTone = 'working' | 'attention' | 'error' | 'retry'

export interface ViewBadge {
  tone: ViewBadgeTone
  count: number
  /** Accessible label carrying the full family breakdown, not just the shown count. */
  label: string
  /** Family glyph rendered inside the count pill. */
  icon: Component
  /** Exact accents used for unread notification dots. */
  colors?: string[]
}

export interface ViewRailBadges {
  activity: ViewBadge | null
  unread: ViewBadge | null
  /** A browser surface behind this item is playing sound right now. */
  playing: boolean
}

/**
 * Which browser surfaces are playing sound, as one snapshot the rail reads per
 * option. The thread browser reports per family; the global profile reports on
 * its own, because the Browser item owns no thread family.
 */
export interface ViewAudioActivity {
  /** Families whose thread browser is playing sound. */
  families: ReadonlySet<ContentThreadFamily>
  /** Whether the global browser profile is playing sound. */
  global: boolean
}

/** Nothing playing: the shape a caller falls back to when no audio is wired. */
const NO_AUDIO_ACTIVITY: ViewAudioActivity = { families: new Set(), global: false }

/** The three families the rail's badges and labels are keyed by. */
// Each family wears the mark its own view wears, from the one place that holds a
// family's mark, so a badge and the view it counts can never disagree.
const FAMILY_ICONS: Record<ContentThreadFamily, Component> = {
  projects: CioProjects,
  chats: CONTENT_FAMILY_ICONS.chats,
  assistant: CONTENT_FAMILY_ICONS.assistant
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
 *  attention, error or retry group is still reachable from the single pill. */
function familyActivityLabel(family: ContentThreadFamily, activity: ThreadStateCounts): string {
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
 * One pass over the one in-memory thread list (`scopeState.allScopeThreads`),
 * on the shared state rule, so the rail and the sidebar's project rows report
 * the same figures for the same threads ({@link countThreadStatesByGroup}).
 *
 * Working threads wear the working tone; threads parked on `working-paused`
 * wear the retry tone; threads parked on the user (a permission, question or
 * secret) wear the attention tone, and a failed total wears the error tone. A
 * badge carries its count and never animates, because a running animation keeps
 * the compositor producing frames for as long as it runs, which a parked state
 * can hold open indefinitely. Orchestration children are folded into their
 * coordinator (same rule as the sidebar rows) so a delegated run counts once
 * instead of inflating the total with hidden worker threads. A live-working
 * thread always counts as working, never as attention/retry, so no thread is
 * ever double-counted.
 *
 * The unread axis lives inside the same counts: the mark under the activity pill
 * reads `counts[family].unread`, so the rail and every project strip count the
 * same threads on the same rule.
 */
export class ViewRailActivity {
  isRecording(
    optionId: HeaderViewOptionId,
    projectBadgeOption: HeaderViewOptionId | null
  ): boolean {
    const scope = speechController.recordingScope
    if (optionId === 'browser') {
      return (
        browserAudio.globalIsCapturing() ||
        (scope !== null &&
          scope.kind !== 'global' &&
          browserAssistant.threads.some((thread) => thread.id === scope.threadId))
      )
    }
    const family = viewOptionFamily(optionId)
    if (family === 'projects' && optionId !== projectBadgeOption) return false
    if (browserAudio.familiesCapturing().has(family)) return true
    if (!scope || scope.kind === 'global') return false
    if (scope.kind === 'project')
      return contentThreadFamily({ projectId: scope.projectId }) === family
    return family === 'chats'
  }

  counts: ViewActivityCounts = $derived.by((): ViewActivityCounts => {
    // Re-check on a coarse clock only while a retry deadline is tracked, so a
    // 6h+ parked wait rejoins the count once its reset gets close.
    if (agentRuns.hasPendingRetry) subscribeToRetryClock()
    const counts = countThreadStatesByGroup(scopeState.allScopeThreads, (thread) =>
      contentThreadFamily(thread)
    )
    return {
      projects: counts.get('projects') ?? emptyThreadStateCounts(),
      chats: counts.get('chats') ?? emptyThreadStateCounts(),
      assistant: counts.get('assistant') ?? emptyThreadStateCounts()
    }
  })

  /**
   * A browser tab's assistant conversation, counted apart from every other
   * family.
   *
   * These rows are held out of `scopeState.allScopeThreads` on purpose, so no
   * family badge can ever see them and the Browser item used to report only
   * downloads. A conversation could then sit working, or wait on a question with
   * no card the user could find, while the rail said nothing at all.
   *
   * Counted with the same rules as a family ({@link ViewRailActivity.counts}), so
   * a browser chat and a workspace chat read identically on the rail.
   */
  browserAssistant: ThreadStateCounts = $derived.by((): ThreadStateCounts => {
    // Same retry clock as the family counts: a browser chat parked on a long
    // scheduled retry has to leave this count on its own, without waiting for
    // some other family's row to keep the clock alive.
    if (agentRuns.hasPendingRetry) subscribeToRetryClock()
    return countThreadStates(
      browserAssistant.threads.filter((thread) => !thread.archived),
      Date.now()
    )
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

  /**
   * Browser surfaces playing sound right now, for the rail's speaker mark.
   *
   * A thread browser tab belongs to the conversation that opened it, so the sound
   * rides that conversation's family: a project thread's tab marks the project
   * family, a chat's marks Chats, an assistant task's marks Assistant. The global
   * profile belongs to no thread, so it marks the Browser item on its own.
   */
  audio: ViewAudioActivity = $derived.by(() => ({
    families: browserAudio.familiesPlaying(),
    global: browserAudio.globalIsPlaying()
  }))
}

/**
 * The single activity pill a rail view shows, chosen by priority: working
 * outranks attention, which outranks a parked retry. The returned label always
 * carries the family's full breakdown. Returns null when the family is quiet.
 *
 * The review-ready bucket a project strip draws in purple is deliberately not
 * badged here. The rail answers "what wants the user now" across every project
 * at once, and a finished artifact waiting to be read is already announced by
 * that thread's own unread dot (the card that delivered it), so a second badge
 * would report the same landing twice. The strip, which speaks for one project,
 * is where the review trace belongs.
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
 *
 * The speaker mark ({@link ViewRailBadges.playing}) is separate from that pill:
 * it rides the same option the family's badge does, so a view that is working and
 * playing sound shows both without either hiding the other.
 *
 * The unread mark carries the family's unread count, read off the same counts
 * ({@link ThreadStateCounts.unread}), so it counts only a completed run nobody
 * has opened and never doubles as a failure, a parked card, or a ready spec.
 */
export function viewBadgesFor(
  optionId: HeaderViewOptionId,
  projectBadgeOption: HeaderViewOptionId | null,
  counts: ViewActivityCounts,
  browserTransfers: BrowserDownloadOutstanding,
  browserAssistantActivity: ThreadStateCounts = emptyThreadStateCounts(),
  audio: ViewAudioActivity = NO_AUDIO_ACTIVITY
): ViewRailBadges {
  if (optionId === 'browser') {
    return {
      activity:
        browserAgentBadge(browserAssistantActivity) ?? browserTransferBadge(browserTransfers),
      unread: null,
      playing: audio.global
    }
  }
  const family = viewOptionFamily(optionId)
  if (family === 'projects' && optionId !== projectBadgeOption) {
    return { activity: null, unread: null, playing: false }
  }
  // The project family shares one badge option, so its sound mark rides the same
  // option its activity badge does; Chats and Assistant own their single view.
  const playing = audio.families.has(family)
  const unread = notificationPanelState.unreadRailSummary(family)
  const threadUnreadCount = counts[family].unread
  const unreadCount = Math.max(unread?.count ?? 0, threadUnreadCount)
  const unreadBadge: ViewBadge | null =
    unreadCount > 0
      ? {
          tone: 'attention',
          count: unreadCount,
          label: `${unreadCount} unread ${FAMILY_NOUN[family]}${unreadCount === 1 ? '' : 's'}`,
          icon: FAMILY_ICONS[family],
          colors:
            unread?.colors ??
            (family === 'assistant'
              ? [notificationPanelState.assistantColor ?? 'var(--color-dimmed)']
              : [family === 'chats' ? 'var(--color-chat-success)' : 'var(--color-success)'])
        }
      : null
  const activity = counts[family]
  const icon = FAMILY_ICONS[family]
  if (activity.working > 0) {
    return {
      activity: {
        tone: 'working',
        count: activity.working,
        label: familyActivityLabel(family, activity),
        icon
      },
      unread: unreadBadge,
      playing
    }
  }
  if (activity.attention > 0) {
    return {
      activity: {
        tone: 'attention',
        count: activity.attention,
        label: familyActivityLabel(family, activity),
        icon
      },
      unread: unreadBadge,
      playing
    }
  }
  if (activity.retry > 0) {
    return {
      activity: {
        tone: 'retry',
        count: activity.retry,
        label: familyActivityLabel(family, activity),
        icon
      },
      unread: unreadBadge,
      playing
    }
  }
  return { activity: null, unread: unreadBadge, playing }
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
function browserAgentBadge(activity: ThreadStateCounts): ViewBadge | null {
  if (activity.attention > 0) {
    return {
      tone: 'attention',
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
    icon: CioDownload
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
