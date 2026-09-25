<script lang="ts">
  import { type Component } from 'svelte'
  import { fade } from 'svelte/transition'
  import { ChevronDown, MessageSquare, Timeline } from '@lucide/svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import ShortcutHint from '$lib/components/ui/ShortcutHint.svelte'
  import WorkingCountBadge from '$lib/components/shared/WorkingCountBadge.svelte'
  import { preloadScopeChunk } from '$lib/page-preload'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { viewActions } from '$lib/stores/view-actions.svelte'
  import {
    coordinatorHasActiveDelegates,
    INBOX_PROJECT_ID,
    isOrchestrationChildThread
  } from '$shared/types'
  import { DropdownMenu } from 'bits-ui'
  import { threadWorkingForIndicator } from './app-header-thread-status'
  import type { HeaderViewOption, HeaderViewOptionId } from './AppHeaderNavigationController.svelte'

  interface Props {
    /** The options the switcher lists, already ordered by the navigation controller. */
    options: HeaderViewOption[]
    /** The option the trigger and menu currently reflect. */
    shownOption: HeaderViewOptionId
    activeIcon: Component
    activeLabel: string
    /** Warm the target view's thread/chunk before a nav click lands. */
    onOptionHover: (id: HeaderViewOptionId) => void
  }

  let { options, shownOption, activeIcon, activeLabel, onOptionHover }: Props = $props()

  /** How often a parked retry wait is re-checked so a reset that falls back
   *  inside the wake window rejoins the working count. */
  const RETRY_WINDOW_RECHECK_MS = 60_000
  const subscribeToRetryClock = createSubscriber((update) => {
    const timer = window.setInterval(update, RETRY_WINDOW_RECHECK_MS)
    return () => window.clearInterval(timer)
  })

  /**
   * Thread counts per navigation family, feeding the activity badges on
   * the view switcher. Working threads pulse in the working tone (same rule
   * as before); threads parked on `working-paused` pulse in the retry tone;
   * threads in `awaiting_approval` or `failed` pulse in the attention tone
   * (error-red when a failure is inside the family). Orchestration children
   * are folded into their coordinator (same rule as the sidebar rows) so a
   * delegated run counts once instead of inflating the total with hidden
   * worker threads. A live-working thread always counts as working, never
   * as attention/retry, so no thread is ever double-counted.
   */
  let threadActivityCounts = $derived.by(() => {
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
    const workingIds = new Set(working.map((thread) => thread.id))
    const counts = {
      workingProjects: 0,
      workingChats: 0,
      attentionProjects: 0,
      attentionChats: 0,
      attentionProjectsError: false,
      attentionChatsError: false,
      retryProjects: 0,
      retryChats: 0
    }
    for (const thread of threads) {
      if (thread.archived || isOrchestrationChildThread(thread)) continue
      const isChat = thread.projectId === INBOX_PROJECT_ID
      const isWorking = workingIds.has(thread.id) || coordinatorHasActiveDelegates(thread, working)
      if (isWorking) {
        if (isChat) counts.workingChats += 1
        else counts.workingProjects += 1
        continue
      }
      if (thread.status === 'working-paused') {
        if (isChat) counts.retryChats += 1
        else counts.retryProjects += 1
        continue
      }
      if (thread.status === 'awaiting_approval' || thread.status === 'failed') {
        if (isChat) {
          counts.attentionChats += 1
          if (thread.status === 'failed') counts.attentionChatsError = true
        } else {
          counts.attentionProjects += 1
          if (thread.status === 'failed') counts.attentionProjectsError = true
        }
      }
    }
    return counts
  })

  /** Badge tooltip/aria text carrying the true count (the pill may saturate). */
  function workingThreadLabel(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'} working`
  }

  /** Tooltip/aria text for threads stalled on approval or an error. */
  function attentionThreadLabel(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} attention`
  }

  /** Tooltip/aria text for threads parked until their automatic retry. */
  function retryThreadLabel(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'} waiting to retry`
  }

  let hasThreadActivity = $derived(
    threadActivityCounts.workingProjects > 0 ||
      threadActivityCounts.workingChats > 0 ||
      threadActivityCounts.attentionProjects > 0 ||
      threadActivityCounts.attentionChats > 0 ||
      threadActivityCounts.retryProjects > 0 ||
      threadActivityCounts.retryChats > 0
  )

  /** Rendered width of the current trigger label. Measured after every label
   *  swap so the wrapper can animate its width instead of snapping. */
  let labelWidth = $state<number | null>(null)
  let measureLabel: HTMLSpanElement | undefined = $state(undefined)

  $effect(() => {
    // Track the label so this re-runs after each swap, once the measuring
    // span already holds the new text.
    void activeLabel
    if (measureLabel) labelWidth = measureLabel.offsetWidth
  })
</script>

<!-- View switcher dropdown + per-view quick actions -->
<div class="flex items-center gap-0.5">
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="relative flex h-7 items-center gap-1 rounded-md px-1.5 text-[0.625rem] font-medium text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
      aria-label="Switch view"
      title="Switch view"
      data-onboarding="view-switcher"
    >
      <!-- Active view icon: crossfades between views instead of popping. -->
      <span class="grid h-4 w-4 shrink-0 place-items-center">
        {#key shownOption}
          {@const ActiveViewIcon = activeIcon}
          <span
            class="col-start-1 row-start-1 flex items-center justify-center"
            in:fade={{ duration: 150 }}
            out:fade={{ duration: 100 }}
          >
            <ActiveViewIcon size={14} strokeWidth={1.8} />
          </span>
        {/key}
      </span>
      <!-- Label wrapper: width is measured from the hidden mirror span and
           transitions, so the switcher and the action buttons beside it
           glide when the view changes instead of jumping. -->
      <span
        class="relative overflow-hidden text-left whitespace-nowrap transition-[width] duration-200 ease-out motion-reduce:transition-none"
        style:width={labelWidth === null ? undefined : `${labelWidth}px`}
      >
        {activeLabel}
        <span
          class="absolute top-0 left-0 invisible whitespace-nowrap"
          bind:this={measureLabel}
          aria-hidden="true"
        >
          {activeLabel}
        </span>
      </span>
      <ChevronDown size={12} class="shrink-0 text-muted" />
      <!-- Thread activity: one pulsing badge per navigation family and
           status group (working, needs attention, waiting to retry), riding
           the top edge of the trigger (left-anchored like every other
           header badge). The label itself stays still. Family icons stay
           the same as the working badges (Timeline = project threads,
           MessageSquare = chats); the tone carries the status. -->
      {#if hasThreadActivity}
        <span class="absolute -top-2 left-1 flex items-center gap-1">
          <WorkingCountBadge
            icon={Timeline}
            count={threadActivityCounts.workingProjects}
            label={workingThreadLabel(threadActivityCounts.workingProjects, 'project thread')}
          />
          <WorkingCountBadge
            icon={MessageSquare}
            count={threadActivityCounts.workingChats}
            label={workingThreadLabel(threadActivityCounts.workingChats, 'chat')}
          />
          <WorkingCountBadge
            icon={Timeline}
            count={threadActivityCounts.attentionProjects}
            label={attentionThreadLabel(threadActivityCounts.attentionProjects, 'project thread')}
            tone={threadActivityCounts.attentionProjectsError ? 'error' : 'attention'}
          />
          <WorkingCountBadge
            icon={MessageSquare}
            count={threadActivityCounts.attentionChats}
            label={attentionThreadLabel(threadActivityCounts.attentionChats, 'chat')}
            tone={threadActivityCounts.attentionChatsError ? 'error' : 'attention'}
          />
          <WorkingCountBadge
            icon={Timeline}
            count={threadActivityCounts.retryProjects}
            label={retryThreadLabel(threadActivityCounts.retryProjects, 'project thread')}
            tone="retry"
          />
          <WorkingCountBadge
            icon={MessageSquare}
            count={threadActivityCounts.retryChats}
            label={retryThreadLabel(threadActivityCounts.retryChats, 'chat')}
            tone="retry"
          />
        </span>
      {/if}
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        class="z-50 w-56 overflow-hidden rounded-md border bg-surface p-1 shadow-lg"
      >
        {#each options as option (option.id)}
          {@const Icon = option.icon}
          {@const isSelected = option.id === shownOption}
          <DropdownMenu.Item
            class={[
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors',
              isSelected ? 'text-foreground' : 'text-muted hover:bg-elevated focus:bg-elevated'
            ]}
            onpointerenter={() => {
              onOptionHover(option.id)
              if (option.id === 'scope-board' || option.id === 'scoped-threads') preloadScopeChunk()
            }}
            onSelect={option.select}
          >
            <Icon
              size={14}
              strokeWidth={1.8}
              class="shrink-0 {isSelected ? 'text-foreground' : 'text-muted'}"
            />
            <span class="flex-1 whitespace-nowrap">{option.label}</span>
            <ShortcutHint keys={option.keys} />
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>

  <!-- Per-view quick actions, registered by the workspace store -->
  <div class="flex items-center gap-0.5">
    {#each viewActions.items as item (item.id)}
      {#if item.component}
        {@const ActionControl = item.component}
        <ActionControl {...item.props ?? {}} />
      {:else if item.icon && item.run}
        {@const ActionIcon = item.icon}
        <button
          class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
          aria-label={item.ariaLabel ?? item.title ?? 'Action'}
          title={item.title}
          data-shortcut={item.shortcut ? item.shortcut.join(',') : undefined}
          onclick={() => item.run?.()}
        >
          <ActionIcon size={15} strokeWidth={1.8} />
        </button>
      {/if}
    {/each}
  </div>
</div>
