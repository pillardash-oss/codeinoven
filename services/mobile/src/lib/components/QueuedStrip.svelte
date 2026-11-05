<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import type { Prompt } from '#lib/api/types'

  /**
   * The message waiting to be answered, held on the composer's top edge rather
   * than raised as a second bubble in the transcript: it is what the box below it
   * is for, and it folds away so the box never loses the screen.
   *
   * The service queues a prompt on its own, so this strip reports the state the
   * prompt is actually in instead of offering a "send now" the service cannot
   * honour.
   */
  interface Props {
    prompts: Prompt[]
  }

  let { prompts }: Props = $props()

  let open = $state(false)

  let label = $derived(prompts.length === 1 ? '1 waiting' : `${prompts.length} waiting`)
  let stage = $derived(prompts[0]?.state ?? 'queued')
  let stateLabel = $derived(
    stage === 'claimed' ? 'Working on it' : stage === 'failed' ? 'Failed' : 'Queued'
  )
</script>

<div class="queue-wrap">
  <button
    class="queue"
    type="button"
    aria-expanded={open}
    aria-controls="queued-messages"
    aria-label="Show the message waiting to send"
    title="Show the message waiting to send"
    onclick={() => (open = !open)}
  >
    <span class="queue-lead">
      <b>{label}</b>
      <span>{prompts.length === 1 ? prompts[0]?.body : 'Messages sent while the oven works'}</span>
    </span>
    <span class="queue-state">{stateLabel}</span>
    <CioChevronDown size={14} />
  </button>

  {#if open}
    <div class="queue-body" id="queued-messages">
      {#each prompts as prompt (prompt.id)}
        <p>{prompt.body}</p>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* One line, always: the count keeps its width and the held message is what
     gives way, so the strip stays a 44px row whatever was written. */
  .queue-lead {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    white-space: nowrap;
  }

  .queue-lead b {
    flex: none;
    font-weight: 500;
  }

  .queue-lead span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted);
  }

  .queue-state {
    flex: none;
    color: var(--ink-meta);
  }

  .queue-body p {
    margin: 0;
    padding: 0.625rem 0.75rem;
    font-size: 0.875rem;
    line-height: 1.45;
    color: var(--color-foreground);
    white-space: pre-wrap;
  }
</style>
