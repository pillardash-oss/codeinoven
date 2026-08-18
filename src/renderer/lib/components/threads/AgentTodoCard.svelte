<script lang="ts">
  import { Check, ChevronRight, Circle, ListChecks, Loader2 } from '@lucide/svelte'
  import { activeAgentTodoIndex, type AgentTodoItem } from '$lib/agent-todos'

  interface Props {
    items: AgentTodoItem[]
    signature: string
    busy: boolean
  }

  let { items, signature, busy }: Props = $props()

  let open = $state(false)
  let userPinnedOpen = $state(false)
  let lastSignature = $state('')

  let completedCount = $derived(items.filter((item) => item.status === 'completed').length)
  let currentItem = $derived(
    items.find((item) => item.status === 'in_progress') ??
      items.find((item) => item.status === 'pending')
  )
  let activeIndex = $derived(activeAgentTodoIndex(items, busy))
  let progressLabel = $derived(
    activeIndex >= 0
      ? `Working on ${activeIndex + 1} of ${items.length} · ${completedCount} done`
      : `${completedCount}/${items.length} done`
  )

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
  class="overflow-hidden rounded-t-xl border border-b-0 border-info/20 bg-elevated/50"
  aria-label="Agent task progress"
>
  <button
    type="button"
    class="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-elevated"
    aria-expanded={open}
    onclick={toggleOpen}
  >
    <ListChecks size={14} class="shrink-0 text-info" />
    <span class="shrink-0 text-xs font-semibold text-foreground">Tasks</span>
    <span class="shrink-0 text-[11px] tabular-nums text-dimmed">
      {progressLabel}
    </span>
    {#if !open && currentItem}
      <span class="min-w-0 flex-1 truncate text-xs text-muted">{currentItem.label}</span>
    {:else}
      <span class="flex-1"></span>
    {/if}
    <ChevronRight
      size={13}
      class="shrink-0 text-dimmed transition-transform {open ? 'rotate-90' : ''}"
    />
  </button>

  {#if open}
    <div class="max-h-56 overflow-y-auto border-t px-3 py-2" aria-live="polite">
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
