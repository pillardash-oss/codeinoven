<script lang="ts">
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import type { Thread, ThreadSearchResult } from '$shared/types'

  interface Props {
    result: ThreadSearchResult
    selected?: boolean
    onOpen: (thread: Thread) => void
  }

  let { result, selected = false, onOpen }: Props = $props()

  let thread = $derived(result.thread)

  let badgeProps = $derived.by(() => {
    if (thread.status === 'planning' || thread.status === 'executing') {
      return { stage: 'working' as const, variant: 'spinner' as const }
    }
    if (thread.status === 'awaiting_approval') {
      return { kind: 'attention' as const, animated: true }
    }
    if (thread.status === 'failed') {
      return { kind: 'error' as const }
    }
    if (!thread.read) return { stage: 'unread' as const }
    if (thread.status === 'created') return { stage: 'todo' as const }
    return null
  })

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return 'Now'
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d`
    const weeks = Math.floor(days / 7)
    if (weeks < 5) return `${weeks}w`
    return `${Math.floor(days / 30)}mo`
  }
</script>

<button
  class="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors {selected
    ? 'bg-elevated'
    : 'hover:bg-elevated'}"
  title={thread.title}
  onclick={() => onOpen(thread)}
>
  <span class="flex min-w-0 items-center gap-2">
    <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
      {#if badgeProps}
        <StatusBadge
          stage={badgeProps.stage}
          kind={badgeProps.kind}
          variant={badgeProps.variant ?? 'dot'}
          animated={badgeProps.animated}
          size="sm"
          title={thread.status.replace('_', ' ')}
        />
      {:else}
        <span class="h-2 w-2 rounded-full border border-border-strong bg-transparent"></span>
      {/if}
    </span>
    <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{thread.title}</span>
    <span class="shrink-0 whitespace-nowrap text-[10px] text-dimmed">
      {relativeTime(thread.lastActivity)}
    </span>
  </span>
  {#if result.kind === 'message' && result.snippet}
    <span class="line-clamp-2 pl-[22px] text-[11px] leading-snug text-dimmed">
      <span class="text-[10px] uppercase tracking-wide text-dimmed/80">
        {result.role === 'assistant' ? 'Agent' : 'You'}
      </span>
      <span aria-hidden="true"> · </span>
      {result.snippet}
    </span>
  {/if}
</button>
