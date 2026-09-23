<script lang="ts">
  import { Workflow } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import type { AgentModelSelection, ProviderCatalog, RoutineAgents } from '$shared/types'
  import RoutineAgentPicker from './RoutineAgentPicker.svelte'

  interface Props {
    /** Create a routine with the given name and model set; the host seeds a first task. */
    onCreate: (name: string, agents: RoutineAgents) => void | Promise<void>
    /** Harness catalogs the model pickers read. */
    providers: ProviderCatalog[]
    /** Project whose harness catalog the pickers display. */
    projectId?: string | null
    /**
     * The model the user is working on   the routine's default primary, so
     * creating a routine never requires an explicit model pick.
     */
    getDefaultPrimary?: () => AgentModelSelection | undefined
    title?: string
    /** External open signal (keyboard shortcut); the control opens its dialog
     *  whenever the value grows past the one it already handled. */
    trigger?: number
  }

  let {
    onCreate,
    providers,
    projectId = null,
    getDefaultPrimary,
    title = 'New routine',
    trigger = 0
  }: Props = $props()

  let open = $state(false)
  let name = $state('')
  let agents = $state<RoutineAgents>({ fallbacks: [] })
  let busy = $state(false)

  function defaultAgents(): RoutineAgents {
    const primary = getDefaultPrimary?.()
    return primary ? { primary, fallbacks: [] } : { fallbacks: [] }
  }

  function openDialog(): void {
    agents = defaultAgents()
    open = true
  }

  /** Highest trigger value already handled. The control unmounts when the view
   *  changes and remounts later; re-initialising from the live value keeps a
   *  stale trigger from re-opening the dialog on remount. */
  // Intentional initial-value capture   the baseline later triggers compare against.
  // svelte-ignore state_referenced_locally
  let handledTrigger = trigger
  $effect(() => {
    if (trigger > handledTrigger) {
      handledTrigger = trigger
      agents = defaultAgents()
      open = true
    }
  })

  const canSubmit = $derived(name.trim().length > 0 && Boolean(agents.primary?.modelId) && !busy)

  async function submit(): Promise<void> {
    if (!canSubmit) return
    busy = true
    try {
      await onCreate(name.trim(), agents)
      open = false
      name = ''
      agents = { fallbacks: [] }
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
  onclick={openDialog}
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
      <p class="mt-1.5 text-[0.625rem] leading-relaxed text-dimmed">
        A routine groups tasks under one how-to and one schedule. A first task is created
        automatically, and you write the how-to with the agent next.
      </p>
    </div>

    <div class="border-t border-border pt-3">
      <p class="mb-2 text-[0.625rem] leading-relaxed text-dimmed">
        Pick the models this routine runs on. A primary and two fallbacks mean a model that fails or
        hits its limit never stops the routine.
      </p>
      <RoutineAgentPicker
        {agents}
        {providers}
        {projectId}
        onChange={(next) => (agents = next)}
      />
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
