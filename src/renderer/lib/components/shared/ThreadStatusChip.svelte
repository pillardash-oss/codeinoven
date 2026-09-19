<script lang="ts">
  /**
   * A labelled thread-status chip: the canonical coloured `StatusBadge` dot next
   * to the thread's status text, using the same mapping as the sidebar row and
   * the command palette. Every surface that shows a thread's state outside its
   * own row renders this so the colour and wording never drift apart.
   */
  import StatusBadge from './StatusBadge.svelte'
  import { isThreadLiveWorking, statusBadgeForThread } from '$lib/thread-status-badge'
  import type { Thread } from '$shared/types'

  interface Props {
    thread: Thread
    /** Text size, matched to the row the chip sits in. */
    size?: 'sm' | 'md'
    class?: string
  }

  let { thread, size = 'sm', class: className = '' }: Props = $props()

  const status = $derived(statusBadgeForThread(thread, isThreadLiveWorking(thread)))
  const sizeClass = $derived(size === 'md' ? 'text-[0.625rem]' : 'text-[0.5625rem]')
</script>

{#if status}
  <span
    class="inline-flex min-w-0 shrink-0 items-center gap-1 rounded-md border border-border bg-raised px-1.5 py-0.5 font-medium text-dimmed {sizeClass} {className}"
  >
    <StatusBadge
      stage={status.stage}
      tone={status.tone}
      kind={status.kind}
      variant={status.variant ?? 'dot'}
      animated={status.animated}
      size="sm"
      title={status.label}
    />
    <span class="truncate">{status.label}</span>
  </span>
{/if}
