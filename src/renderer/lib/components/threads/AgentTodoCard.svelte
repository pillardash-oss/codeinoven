<script lang="ts">
  import { Check, ChevronDown, Circle, ListChecks, Loader2, X } from '@lucide/svelte'
  import { slide } from 'svelte/transition'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import {
    activeAgentTodoIndex,
    agentTodoProgressLabel,
    type AgentTodoItem
  } from '$lib/agent-todos'

  interface Props {
    items: AgentTodoItem[]
    signature: string
    busy: boolean
    /** Dismiss the card after the thread stopped working. */
    onClose: () => void
  }

  let { items, signature, busy, onClose }: Props = $props()

  let open = $state(false)
  let userPinnedOpen = $state(false)
  let lastSignature = $state('')

  let completedCount = $derived(items.filter((item) => item.status === 'completed').length)
  let currentItem = $derived(
    items.find((item) => item.status === 'in_progress') ??
      items.find((item) => item.status === 'pending')
  )
  let activeIndex = $derived(activeAgentTodoIndex(items, busy))
  let progressLabel = $derived(agentTodoProgressLabel(items.length, completedCount, activeIndex))

  $effect(() => {
    const currentSignature = signature
    if (currentSignature === lastSignature) return
    lastSignature = currentSignature
    if (userPinnedOpen) {
      open = true
      return
    }
    open = true
    const timer = window.setTimeout(() => {
      if (!userPinnedOpen) open = false
    }, 4_000)
    return () => window.clearTimeout(timer)
  })

  function toggleOpen(): void {
    if (open) {
      open = false
      userPinnedOpen = false
      return
    }
    open = true
    userPinnedOpen = true
  }
</script>

<section
  out:slide={dismissSlide()}
  class="overflow-hidden rounded-t-xl border border-b-0 border-info/20 bg-elevated/50"
  aria-label="Agent task progress"
>
  <!-- Header is a row rather than one full-width button so the close control can
  sit beside the fold toggle instead of inside it. -->
  <div class="flex items-center">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-elevated"
      aria-expanded={open}
      onclick={toggleOpen}
    >
      <ListChecks size={14} class="shrink-0 text-info" />
      <span class="shrink-0 text-xs font-semibold text-foreground">Tasks</span>
      <span class="shrink-0 text-[0.6875rem] tabular-nums text-dimmed">
        {progressLabel}
      </span>
      {#if !open && currentItem}
        <span class="min-w-0 flex-1 truncate text-xs text-muted">{currentItem.label}</span>
      {:else}
        <span class="flex-1"></span>
      {/if}
      <ChevronDown
        size={13}
        class="shrink-0 text-dimmed transition-transform {open ? '' : 'rotate-180'}"
      />
    </button>

    <!-- Only offered once the turn stops, so a closed card can never hide live
    task progress. -->
    {#if !busy}
      <button
        type="button"
        class="mr-2 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Close task list"
        title="Close task list"
        onclick={onClose}
      >
        <X size={13} />
      </button>
    {/if}
  </div>

  {#if open}
    <div
      transition:slide={foldSlide()}
      class="max-h-56 overflow-y-auto border-t px-3 py-2"
      aria-live="polite"
    >
      <ul class="space-y-1.5">
        {#each items as item, index (`${item.id}-${index}`)}
          <li class="flex items-start gap-2 text-xs">
            <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
              {#if item.status === 'completed'}
                <span
                  class="flex h-4 w-4 items-center justify-center rounded-full bg-success/15 text-success"
                >
                  <Check size={11} />
                </span>
              {:else if index === activeIndex}
                <Loader2 size={13} class="animate-spin text-info" />
              {:else}
                <Circle size={12} class="text-dimmed" />
              {/if}
            </span>
            <span
              class:line-through={item.status === 'completed'}
              class:text-dimmed={item.status === 'completed'}
              class:text-foreground={item.status !== 'completed'}
              class="min-w-0 flex-1 leading-relaxed"
            >
              {item.label}
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>
