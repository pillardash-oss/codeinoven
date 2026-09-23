<script lang="ts">
  import { Workflow } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'

  interface Props {
    /**
     * Create a routine with the given title and optional description; the host
     * seeds the "Getting started" thread where the how-to is written.
     */
    onCreate: (name: string, description: string) => void | Promise<void>
    title?: string
    /** External open signal (keyboard shortcut); the control opens its dialog
     *  whenever the value grows past the one it already handled. */
    trigger?: number
  }

  let { onCreate, title = 'New routine', trigger = 0 }: Props = $props()

  let open = $state(false)
  let name = $state('')
  let description = $state('')
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
      await onCreate(name.trim(), description.trim())
      open = false
      name = ''
      description = ''
    } finally {
      busy = false
    }
  }
</script>

<button
  type="button"
  class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
  aria-label="New routine"
  title="New routine"
  onclick={() => (open = true)}
>
  <Workflow size={15} strokeWidth={1.8} />
</button>

<Modal {open} {title} size="lg" onClose={() => (open = false)}>
  <div class="flex flex-col gap-4">
    <div>
      <label class="mb-1 block text-[0.6875rem] font-medium text-muted" for="new-routine-name">
        Routine name
      </label>
      <input
        id="new-routine-name"
        class="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[0.8125rem] text-foreground placeholder:text-dimmed focus:border-border-strong focus:outline-none"
        placeholder="e.g. Triage CodeInOven PRs daily, 9am and 5pm"
        aria-label="Routine name"
        bind:value={name}
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
      />
    </div>

    <div>
      <label
        class="mb-1 block text-[0.6875rem] font-medium text-muted"
        for="new-routine-description"
      >
        Description <span class="font-normal text-dimmed">(optional)</span>
      </label>
      <textarea
        id="new-routine-description"
        rows="2"
        class="w-full resize-none rounded-md border border-border bg-surface px-2.5 py-2 text-[0.8125rem] text-foreground placeholder:text-dimmed focus:border-border-strong focus:outline-none"
        placeholder="A note for yourself about what this routine is for"
        aria-label="Routine description"
        bind:value={description}></textarea>
      <p class="mt-1.5 text-[0.625rem] leading-relaxed text-dimmed">
        A note for you only, it is never sent to the agent. Next you describe the routine to the
        agent in its Getting started thread, and it writes the how-to with you.
      </p>
    </div>
  </div>

  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <button
        type="button"
        data-modal-dismiss
        class="rounded-md px-3 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        onclick={() => (open = false)}
      >
        Cancel
      </button>
      <button
        type="button"
        data-modal-primary
        class="rounded-md bg-primary px-3 py-1.5 text-[0.75rem] text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        disabled={!canSubmit}
        onclick={() => void submit()}
      >
        Create routine
      </button>
    </div>
  {/snippet}
</Modal>
