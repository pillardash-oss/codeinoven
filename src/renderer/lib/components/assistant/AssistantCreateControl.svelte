<script lang="ts">
  import AssistantIcon from '$lib/components/icons/AssistantIcon.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import type { NewAssistantDraft } from './assistant-create'

  interface Props {
    /**
     * Create an assistant from what the user typed; the host seeds the "Getting
     * started" thread, where the assistant gathers whatever it still needs to
     * know and writes its knowledge with the user.
     */
    onCreate: (draft: NewAssistantDraft) => void | Promise<void>
    /**
     * Build the assistant by talking to it instead of from this form. The host
     * creates an assistant with nothing known about it and opens its first
     * conversation, where the assistant itself asks for the name, the personality
     * and the rest, one question at a time.
     */
    onCreateViaChat?: () => void | Promise<void>
    title?: string
    /** External open signal (keyboard shortcut); the control opens its dialog
     *  whenever the value grows past the one it already handled. */
    trigger?: number
  }

  let { onCreate, onCreateViaChat, title = 'New assistant', trigger = 0 }: Props = $props()

  let open = $state(false)
  let name = $state('')
  let personality = $state('')
  /** On by default: a new assistant runs on a schedule unless the user opts out. */
  let scheduled = $state(true)
  let scheduleName = $state('')
  let busy = $state(false)

  /** Highest trigger value already handled. The control unmounts when the view
   *  changes and remounts later; re-initialising from the live value keeps a
   *  stale trigger from re-opening the dialog on remount. */
  // Intentional initial-value capture   the baseline later triggers compare against.
  // svelte-ignore state_referenced_locally
  let handledTrigger = trigger
  $effect(() => {
    if (trigger > handledTrigger) {
      handledTrigger = trigger
      open = true
    }
  })

  const canSubmit = $derived(name.trim().length > 0 && !busy)

  async function submit(): Promise<void> {
    if (!canSubmit) return
    busy = true
    try {
      await onCreate({
        name: name.trim(),
        personality: personality.trim(),
        scheduled,
        scheduleName: scheduleName.trim()
      })
      open = false
      resetForm()
    } finally {
      busy = false
    }
  }

  /**
   * Hand the whole thing to the conversation. Nothing typed in this form is used:
   * the assistant exists straight away with nothing known about it, and it asks
   * for all of it, starting with the name.
   */
  async function submitViaChat(): Promise<void> {
    if (busy || !onCreateViaChat) return
    busy = true
    try {
      await onCreateViaChat()
      open = false
      resetForm()
    } finally {
      busy = false
    }
  }

  function resetForm(): void {
    name = ''
    personality = ''
    scheduled = true
    scheduleName = ''
  }
</script>

<button
  type="button"
  class="flex h-7 w-7 items-center justify-center text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
  aria-label="New assistant"
  title="New assistant"
  onclick={() => (open = true)}
>
  <AssistantIcon size={15} />
</button>

<Modal {open} {title} size="lg" onClose={() => (open = false)}>
  <form
    class="flex flex-col gap-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void submit()
    }}
  >
    <div>
      <label class="mb-1 block text-[0.6875rem] font-medium text-muted" for="new-assistant-name">
        Assistant name
      </label>
      <input
        id="new-assistant-name"
        class="w-full border border-border bg-surface px-2.5 py-2 text-[0.8125rem] text-foreground placeholder:text-dimmed focus:border-border-strong focus:outline-none"
        placeholder="e.g. Jenny"
        aria-label="Assistant name"
        bind:value={name}
      />
    </div>

    <div>
      <label
        class="mb-1 block text-[0.6875rem] font-medium text-muted"
        for="new-assistant-personality"
      >
        Personality <span class="font-normal text-dimmed">(optional)</span>
      </label>
      <textarea
        id="new-assistant-personality"
        rows="4"
        class="w-full resize-none border border-border bg-surface px-2.5 py-2 text-[0.8125rem] text-foreground placeholder:text-dimmed focus:border-border-strong focus:outline-none"
        placeholder="You are Jenny. You keep my X and LinkedIn accounts moving, and you write the way I do."
        aria-label="Assistant personality"
        bind:value={personality}></textarea>
      <p class="mt-1.5 text-[0.625rem] leading-relaxed text-dimmed">
        How it should behave and sound. It works the rest out with you.
      </p>
    </div>

    <div
      class="flex items-center justify-between gap-3 border border-border bg-surface px-2.5 py-2"
    >
      <div class="min-w-0">
        <p class="text-[0.75rem] text-foreground">Run on a schedule</p>
        <p class="text-[0.625rem] leading-relaxed text-dimmed">
          {scheduled
            ? 'It agrees the times with you, then keeps to them.'
            : 'No schedule. It runs when you ask.'}
        </p>
      </div>
      <Switch
        bind:checked={scheduled}
        aria-label="Run this assistant on a schedule"
        title="Run on a schedule"
      />
    </div>

    {#if scheduled}
      <div>
        <label
          class="mb-1 block text-[0.6875rem] font-medium text-muted"
          for="new-assistant-schedule-name"
        >
          Schedule name <span class="font-normal text-dimmed">(optional)</span>
        </label>
        <input
          id="new-assistant-schedule-name"
          class="w-full border border-border bg-surface px-2.5 py-2 text-[0.8125rem] text-foreground placeholder:text-dimmed focus:border-border-strong focus:outline-none"
          placeholder="e.g. Daily account check"
          aria-label="Schedule name"
          bind:value={scheduleName}
        />
      </div>
    {/if}
  </form>

  {#snippet footer()}
    <!-- Cancel sits on the left, away from the two ways forward: the user who
         opened this by accident reaches for the far corner, and the choice that
         matters is the one between creating it here and building it by talking. -->
    <div class="flex w-full items-center justify-between">
      <button
        type="button"
        data-modal-dismiss
        class="px-3 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Close without creating an assistant"
        onclick={() => {
          resetForm()
          open = false
        }}
      >
        Cancel
      </button>
      <div class="flex items-center gap-2">
        {#if onCreateViaChat}
          <button
            type="button"
            class="px-3 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
            title="Let the assistant ask you the questions instead of filling this in"
            disabled={busy}
            onclick={() => void submitViaChat()}
          >
            Create via chat
          </button>
        {/if}
        <button
          type="submit"
          data-modal-primary
          class="bg-primary px-3 py-1.5 text-[0.75rem] text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          disabled={!canSubmit}
        >
          Create assistant
        </button>
      </div>
    </div>
  {/snippet}
</Modal>
