<script lang="ts">
  import { Workflow } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'

  interface Props {
    /** Create a routine with the given name; the host also seeds a first task. */
    onCreate: (name: string) => void | Promise<void>
    title?: string
    /** External open signal (keyboard shortcut); the control opens its dialog
     *  whenever the value grows past the one it already handled. */
    trigger?: number
  }

  let { onCreate, title = 'New routine', trigger = 0 }: Props = $props()

  let open = $state(false)
  let name = $state('')
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

  async function submit(): Promise<void> {
    const trimmed = name.trim()
    if (trimmed.length === 0 || busy) return
    busy = true
    try {
      await onCreate(trimmed)
      open = false
      name = ''
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

<Modal {open} {title} onClose={() => (open = false)}>
  <p class="mb-3 text-[0.75rem] text-muted">
    A routine groups tasks under one how-to. A first task is created automatically and you will
    write the how-to with the agent next.
  </p>
  <input
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
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="rounded-md px-3 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        onclick={() => (open = false)}
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-md bg-primary px-3 py-1.5 text-[0.75rem] text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        disabled={name.trim().length === 0 || busy}
        onclick={() => void submit()}
      >
        Create routine
      </button>
    </div>
  {/snippet}
</Modal>
