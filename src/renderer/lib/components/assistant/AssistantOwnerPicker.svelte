<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import { AssistantDefaultIcon, getAssistantIcon } from '$lib/assistant-icons'
  import { assistantIsScheduled, describeSchedule, type Assistant } from '$shared/types'

  interface Props {
    /** Whether the picker is showing; the host owns it, so it can close on pick. */
    open: boolean
    /** Every assistant a task can be handed to, in the sidebar's own order. */
    assistants: Assistant[]
    /** What the picker is asking, in one line, e.g. "Which assistant is this for?". */
    question: string
    /** Title of the action that starts a brand-new assistant, when offered. */
    newAssistantLabel?: string
    onPick: (assistantId: string) => void
    /** Offered only when the host can start the new-assistant flow from here. */
    onNewAssistant?: () => void
    onClose: () => void
  }

  let {
    open,
    assistants,
    question,
    newAssistantLabel = 'New assistant',
    onPick,
    onNewAssistant,
    onClose
  }: Props = $props()

  /** The line under an assistant's name: what it keeps to, or that it waits. */
  function assistantLine(assistant: Assistant): string {
    if (!assistantIsScheduled(assistant)) return 'Runs when you ask'
    return assistant.schedule ? describeSchedule(assistant.schedule) : 'Agreeing its times'
  }
</script>

<Modal {open} title="Which assistant?" size="md" {onClose}>
  <div class="flex flex-col gap-3">
    <p class="text-[0.8125rem] leading-relaxed text-muted">{question}</p>

    {#if assistants.length === 0}
      <p class="border border-border bg-surface px-2.5 py-3 text-[0.75rem] text-dimmed">
        No assistants yet. Make one and the task lands in it.
      </p>
    {:else}
      <!-- Every assistant is one row, not a menu: a person picking who should
           take something on recognizes a name faster than reading a list. -->
      <div class="flex max-h-80 flex-col overflow-y-auto border border-border">
        {#each assistants as assistant (assistant.id)}
          {@const iconUrl = getAssistantIcon(assistant)}
          <button
            type="button"
            class="flex w-full items-center gap-2.5 border-b border-border px-2.5 py-2 text-left transition-colors last:border-b-0 hover:bg-elevated"
            title="Give this to {assistant.name}"
            aria-label="Give this to {assistant.name}"
            onclick={() => onPick(assistant.id)}
          >
            {#if iconUrl}
              <img src={iconUrl} alt="" class="h-6 w-6 shrink-0 object-contain" />
            {:else}
              <AssistantDefaultIcon size={18} class="shrink-0 text-muted" />
            {/if}
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[0.8125rem] text-foreground">{assistant.name}</span>
              <span class="block truncate text-[0.6875rem] text-dimmed"
                >{assistantLine(assistant)}</span
              >
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <div class="flex w-full items-center justify-between">
      <button
        type="button"
        class="px-3 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Close without choosing"
        onclick={onClose}
      >
        Cancel
      </button>
      {#if onNewAssistant}
        <button
          type="button"
          data-modal-primary
          class="bg-primary px-3 py-1.5 text-[0.75rem] text-on-primary transition-colors hover:bg-primary-hover"
          title="Start a new assistant instead"
          onclick={onNewAssistant}
        >
          {newAssistantLabel}
        </button>
      {/if}
    </div>
  {/snippet}
</Modal>
