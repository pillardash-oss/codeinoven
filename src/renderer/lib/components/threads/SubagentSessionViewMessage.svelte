<script lang="ts">
  import type { AgentMessage, AgentPart } from '$shared/types'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import WorkingTrace from './WorkingTrace.svelte'
  import { formatTime, textParts, workingParts } from './subagent-session-view-helpers'

  interface Props {
    message: AgentMessage
    /** True while the child session is still running, so the trace stays live. */
    busy: boolean
    startTime?: number
    modelLabel: string | null
    providerName?: string
    onOpenSubagent?: (part: Extract<AgentPart, { type: 'subagent' }>) => void
  }

  let { message, busy, startTime, modelLabel, providerName, onOpenSubagent }: Props = $props()
</script>

{#if message.role === 'user'}
  <div class="ml-auto max-w-[90%]">
    <div class="rounded-xl rounded-br-sm bg-elevated px-3 py-2.5 text-xs text-foreground">
      {#each textParts(message) as part (part.id)}
        <MarkdownView text={part.text} />
      {/each}
    </div>
    <p class="mt-1 text-right text-[0.5625rem] text-dimmed">
      {formatTime(message.createdAt)}
    </p>
  </div>
{:else}
  {@const traceParts = workingParts(message)}
  {@const responseParts = textParts(message)}
  <div class="flex flex-col gap-2.5">
    {#if traceParts.length > 0}
      <WorkingTrace
        parts={traceParts}
        open={busy}
        {busy}
        latest={busy}
        {startTime}
        {modelLabel}
        {providerName}
        {onOpenSubagent}
      />
    {/if}
    {#each responseParts as part (part.id)}
      <div class="text-xs text-foreground">
        <MarkdownView text={part.text} />
      </div>
    {/each}
    {#if message.error}
      <div
        class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[0.6875rem] text-danger"
      >
        {message.error}
      </div>
    {/if}
    {#if message.completedAt}
      <p class="text-[0.5625rem] text-dimmed">{formatTime(message.completedAt)}</p>
    {/if}
  </div>
{/if}
